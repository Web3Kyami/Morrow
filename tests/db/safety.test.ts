import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { ResolutionService } from "../../src/resolution.js";
import { seedCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
test(
  "concurrency, isolation, policy and refusal boundaries (fictional payment evidence, real PostgreSQL)",
  { skip: !url },
  async (t) => {
    const admin = createPool(url!),
      runtime = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    async function ready() {
      const f = await seedCase(admin);
      const service = new ResolutionService(runtime, {
        getTransaction: async () => ({
          ...f.evidence,
          checkedAt: new Date().toISOString(),
        }),
      });
      await service.investigate(f.actor, f.caseId);
      const decision = await service.decide(f.actor, {
        caseId: f.caseId,
        caseVersion: 1,
        policyVersion: 1,
        kind: "APPROVED",
      });
      return {
        f,
        service,
        decision,
        request: {
          caseId: f.caseId,
          decisionId: decision.id,
          idempotencyKey: randomUUID(),
        },
      };
    }
    async function noGrant(f: Awaited<ReturnType<typeof seedCase>>) {
      const result = await tenantTransaction(admin, f.actor.tenantId, (db) =>
        db.query(
          "SELECT count(*)::int n FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
          [f.actor.tenantId, f.orderId],
        ),
      );
      assert.equal(result.rows[0].n, 0);
    }
    try {
      await t.test(
        "parallel identical retry produces one persisted repair and one grant",
        async () => {
          const { f, service, request } = await ready();
          const results = await Promise.all(
            Array.from({ length: 6 }, () => service.repair(f.actor, request)),
          );
          assert.equal(new Set(results.map((r) => r.repairId)).size, 1);
          assert.ok(results.every((r) => r.status === "READBACK_CONFIRMED"));
          const rows = await tenantTransaction(admin, f.actor.tenantId, (db) =>
            db.query(
              "SELECT count(*)::int n FROM morrow.repairs WHERE tenant_id=$1",
              [f.actor.tenantId],
            ),
          );
          assert.equal(rows.rows[0].n, 1);
        },
      );
      await t.test(
        "reusing an idempotency key for another decision is rejected",
        async () => {
          const { f, service, request } = await ready();
          await service.repair(f.actor, request);
          await assert.rejects(
            service.repair(f.actor, { ...request, decisionId: randomUUID() }),
            { code: "IDEMPOTENCY_CONFLICT" },
          );
        },
      );
      await t.test(
        "tenant and actor role cannot be supplied to cross another tenant",
        async () => {
          const { f, service } = await ready(),
            other = await seedCase(admin);
          await assert.rejects(service.inspect(other.actor, f.caseId), {
            code: "NOT_FOUND",
          });
          await assert.rejects(
            service.inspect({ ...f.actor, role: "merchant" }, f.caseId),
            { code: "FORBIDDEN" },
          );
          const noContext = await runtime.query(
            "SELECT count(*)::int n FROM morrow.orders",
          );
          assert.equal(noContext.rows[0].n, 0);
          await tenantTransaction(runtime, f.actor.tenantId, async (db) => {
            const rows = await db.query(
              "SELECT id FROM morrow.orders WHERE tenant_id=$1",
              [other.actor.tenantId],
            );
            assert.equal(rows.rowCount, 0);
          });
          await assert.rejects(
            tenantTransaction(runtime, f.actor.tenantId, (db) =>
              db.query(
                "UPDATE morrow.tenants SET policy_version=999 WHERE id=$1",
                [f.actor.tenantId],
              ),
            ),
            { code: "42501" },
          );
          await assert.rejects(
            tenantTransaction(runtime, f.actor.tenantId, (db) =>
              db.query(
                "UPDATE morrow.operators SET id=$1 WHERE tenant_id=$2 AND id=$3",
                [randomUUID(), f.actor.tenantId, f.actor.operatorId],
              ),
            ),
            /immutable identity/,
          );
        },
      );
      await t.test("policy changes invalidate an approved repair", async () => {
        const { f, service, request } = await ready();
        await tenantTransaction(admin, f.actor.tenantId, (db) =>
          db.query("UPDATE morrow.tenants SET policy_version=2 WHERE id=$1", [
            f.actor.tenantId,
          ]),
        );
        await assert.rejects(service.repair(f.actor, request), {
          code: "STALE_REVIEW",
        });
        await noGrant(f);
      });
      await t.test(
        "revoked operator cannot execute an old approval",
        async () => {
          const { f, service, request } = await ready();
          await tenantTransaction(admin, f.actor.tenantId, (db) =>
            db.query(
              "UPDATE morrow.operators SET active=false WHERE tenant_id=$1 AND id=$2",
              [f.actor.tenantId, f.actor.operatorId],
            ),
          );
          await assert.rejects(service.repair(f.actor, request), {
            code: "FORBIDDEN",
          });
          await noGrant(f);
        },
      );
      await t.test(
        "correct, reject and cancel invalidate earlier approval",
        async () => {
          for (const kind of ["CORRECTED", "REJECTED", "CANCELLED"] as const) {
            const { f, service, request } = await ready();
            await service.decide(f.actor, {
              caseId: f.caseId,
              caseVersion: 2,
              policyVersion: 1,
              kind,
              ...(kind === "CORRECTED"
                ? {
                    reason: "The proposed repair needs correction.",
                    correctionTarget: "ORDER_DETAILS" as const,
                  }
                : {}),
            });
            if (kind === "CORRECTED") {
              const latest = await tenantTransaction(
                admin,
                f.actor.tenantId,
                (db) =>
                  db.query(
                    "SELECT data FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 AND kind='CORRECTED' ORDER BY id DESC LIMIT 1",
                    [f.actor.tenantId, f.caseId],
                  ),
              );
              assert.equal(
                latest.rows[0]?.data.correctionTarget,
                "ORDER_DETAILS",
              );
              assert.equal(
                latest.rows[0]?.data.reason,
                "The proposed repair needs correction.",
              );
            }
            await assert.rejects(service.repair(f.actor, request), {
              code: "STALE_REVIEW",
            });
            await noGrant(f);
          }
        },
      );
      await t.test(
        "provider failure and payment mismatch do not grant after approval",
        async () => {
          const { f, request } = await ready();
          const down = new ResolutionService(runtime, {
            getTransaction: async () => {
              throw new Error("provider secret should never be echoed");
            },
          });
          assert.equal(
            (await down.investigate(f.actor, f.caseId)).verdict,
            "UNKNOWN",
          );
          await assert.rejects(down.repair(f.actor, request), {
            code: "PAYMENT_NOT_CONFIRMED",
          });
          const wrong = new ResolutionService(runtime, {
            getTransaction: async () => ({
              ...f.evidence,
              checkedAt: new Date().toISOString(),
              balanceChanges: [],
            }),
          });
          await assert.rejects(wrong.repair(f.actor, request), {
            code: "PAYMENT_NOT_CONFIRMED",
          });
          await noGrant(f);
        },
      );
      await t.test(
        "stale or future provider observations cannot authorize repair",
        async () => {
          const { f, request } = await ready();
          for (const checkedAt of [
            new Date(Date.now() - 120_000).toISOString(),
            new Date(Date.now() + 120_000).toISOString(),
          ]) {
            const stale = new ResolutionService(runtime, {
              getTransaction: async () => ({ ...f.evidence, checkedAt }),
            });
            assert.equal(
              (await stale.investigate(f.actor, f.caseId)).verdict,
              "UNKNOWN",
            );
            await assert.rejects(stale.repair(f.actor, request), {
              code: "PAYMENT_NOT_CONFIRMED",
            });
          }
          await noGrant(f);
        },
      );
      await t.test(
        "payment digest is unique even across tenants and audit is immutable",
        async () => {
          const { f } = await ready();
          await assert.rejects(
            tenantTransaction(admin, f.actor.tenantId, (db) =>
              db.query(
                "UPDATE morrow.case_events SET kind=$1 WHERE tenant_id=$2",
                ["FAKE", f.actor.tenantId],
              ),
            ),
            /immutable record/,
          );
          await assert.rejects(seedCase(admin, { digest: f.evidence.digest }), {
            code: "23505",
            constraint: "payment_intents_network_expected_digest_key",
          });
          await assert.rejects(
            tenantTransaction(admin, f.actor.tenantId, (db) =>
              db.query(
                `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
        SELECT tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at FROM morrow.payment_intents WHERE tenant_id=$1`,
                [f.actor.tenantId],
              ),
            ),
            { code: "23505" },
          );
        },
      );
    } finally {
      await runtime.end();
      await admin.end();
    }
  },
);
