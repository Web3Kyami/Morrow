import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { CustomerService } from "../../src/customer.js";
import { FairComparisonService } from "../../src/fair.js";
import { seedCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;

test(
  "B3 genuine comparator: both arms on same frozen target B, A-sourced fresh recall, read-only",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    // Two cases in one demo tenant (seedCase makes separate tenants, so
    // add a second case to the first tenant manually).
    const a = await seedCase(admin);
    const tenantId = a.actor.tenantId;
    const caseBId = crypto.randomUUID();
    const orderBId = crypto.randomUUID();
    await tenantTransaction(admin, tenantId, async (tx) => {
      await tx.query(
        "INSERT INTO morrow.orders(tenant_id,id,customer_id,product_id) VALUES ($1,$2,$3,$4)",
        [tenantId, orderBId, crypto.randomUUID(), crypto.randomUUID()],
      );
      await tx.query(
        `INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
         VALUES ($1,$2,'testnet',$3,$4,$5,'0x2::sui::SUI',1000000,clock_timestamp()+interval '10 minutes')`,
        [
          tenantId,
          orderBId,
          crypto.randomUUID().replace(/-/g, "").replace(/0/g, "1"),
          `0x${"3".repeat(64)}`,
          `0x${"4".repeat(64)}`,
        ],
      );
      await tx.query(
        "INSERT INTO morrow.cases(tenant_id,id,order_id) VALUES ($1,$2,$3)",
        [tenantId, caseBId, orderBId],
      );
    });
    await admin.query(
      "UPDATE morrow.orders SET product_category='course' WHERE tenant_id=$1",
      [tenantId],
    );
    // Eligible lesson in this tenant with one extra step.
    const suffix = randomBytes(6).toString("hex");
    let lessonText = "";
    await tenantTransaction(admin, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO morrow.lessons(tenant_id,id,case_id,approved_by,policy_version,payload,fingerprint,network,account_id,namespace,content_hash,fingerprint_version,state,job_id,blob_id,completed_at,recalled_at)
         VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,'testnet',$7,$8,$9,2,'RECALL_VERIFIED',$10,$11,clock_timestamp(),clock_timestamp())`,
        [
          tenantId,
          crypto.randomUUID(),
          a.caseId,
          a.actor.operatorId,
          (lessonText = JSON.stringify({
            sourceCaseId: a.caseId,
            policyVersion: 1,
            productCategory: "course",
            problem: "PAID_ACCESS_MISSING",
            procedure: [
              "VERIFY_PAYMENT_INTENT",
              "REQUEST_MERCHANT_APPROVAL",
              "GRANT_IDEMPOTENTLY",
              "CONFIRM_READBACK",
              "ESCALATE_UNKNOWN",
            ],
            outcome: "READBACK_CONFIRMED",
            fictional: true,
          })),
          "fingerprint-" + suffix,
          "0x" + suffix.repeat(11).slice(0, 64),
          `morrow-testnet:${tenantId}`,
          createHash("sha256").update(lessonText).digest("hex"),
          "job-" + suffix,
          "blob-" + suffix,
        ],
      );
    });
    // Demo bearer session for this tenant/operator.
    const token = randomBytes(32).toString("base64url");
    await admin.query(
      "INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests) VALUES ($1,$2,$3,clock_timestamp()+interval '1 hour',100)",
      [
        createHash("sha256").update(token).digest("hex"),
        tenantId,
        a.actor.operatorId,
      ],
    );

    const blobId = "blob-" + suffix;
    let recallCalls = 0;
    let recallMode = "valid";
    const fakeMemory = {
      remember: async () => ({ jobId: "job-x" }),
      status: async () => ({}),
      recall: async (query: string) => {
        recallCalls++;
        assert.match(query, new RegExp(caseBId));
        if (recallMode === "unavailable") throw Error("OUTAGE");
        if (recallMode === "drift")
          await admin.query(
            "UPDATE morrow.cases SET version=version+1 WHERE tenant_id=$1 AND id=$2",
            [tenantId, caseBId],
          );
        return [{ blobId, text: recallMode === "invalid" ? "{}" : lessonText }];
      },
      close: () => {},
    };
    let paymentAvailable = false;
    const resolution = new ResolutionService(db, {
      getTransaction: async (digest) => {
        if (!paymentAvailable) throw new Error("UNSIGNED");
        const row = (
          await admin.query(
            "SELECT * FROM morrow.payment_intents WHERE expected_digest=$1",
            [digest],
          )
        ).rows[0];
        return {
          provider: "tatum",
          method: "sui.rpc.v2.LedgerService/GetTransaction",
          network: "testnet",
          digest,
          status: "SUCCESS",
          checkpoint: "42",
          sender: row.sender,
          timestamp: new Date(row.created_at.getTime() + 1).toISOString(),
          checkedAt: new Date().toISOString(),
          balanceChanges: [
            {
              address: row.recipient,
              coinType: "0x2::sui::SUI",
              amount: "1000000",
            },
          ],
        };
      },
    });
    const app = createApp(
      db,
      resolution,
      { demoEnabled: true },
      new CustomerService(db),
      undefined as never,
      undefined as never,
      new FairComparisonService(db, resolution, () => ({
        gateway: fakeMemory,
        tenantConfig: {
          network: "testnet",
          namespace: `morrow-testnet:${tenantId}`,
          accountId: "0x" + suffix.repeat(11).slice(0, 64),
          key: "test-only",
        },
        close: () => {},
      })),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      // Both arms on same frozen target B; A is only the lesson source.
      assert.equal(body.targetCaseId, caseBId);
      assert.equal(body.sourceCaseId, a.caseId);
      assert.ok(body.snapshot.snapshotHash);
      assert.equal(body.off.caseId, caseBId);
      assert.equal(body.on.caseId, caseBId);
      assert.equal(body.off.metrics.lessonsConsidered, 0);
      assert.equal(body.off.metrics.steps, 7);
      assert.equal(body.off.recall.status, "SKIPPED_OFF");
      assert.equal(body.on.metrics.lessonsConsidered, 1);
      assert.equal(body.on.metrics.steps, 9);
      assert.ok(body.on.plan.includes("ESCALATE_UNKNOWN"));
      assert.equal(body.on.recall.status, "OK");
      assert.deepEqual(body.on.recall.blobIds, [blobId]);
      assert.equal(recallCalls, 1);
      // Genuine investigations persisted on target B.
      assert.ok(body.off.investigation.verdict);
      assert.ok(body.on.investigation.verdict);
      assert.equal(body.comparison.policyVersion, 1);
      assert.equal(body.comparison.stepsDelta, 2);
      assert.equal(body.comparison.simulation, false);
      assert.equal(body.comparison.outcome, "INCONCLUSIVE"); // UNKNOWN provider is never a result.
      for (const mode of ["invalid", "unavailable", "drift"]) {
        recallMode = mode;
        const check = await app.inject({
          method: "POST",
          url: `/api/v1/cases/${a.caseId}/comparisons`,
          headers: { authorization: "Bearer " + token },
          payload: { caseBId },
        });
        assert.equal(check.statusCode, 200);
        assert.equal(check.json().comparison.outcome, "INCONCLUSIVE");
        if (mode === "drift") assert.equal(check.json().comparison.drift, true);
        else assert.equal(check.json().on.metrics.lessonsConsidered, 0);
      }
      assert.equal(body.comparison.readOnly, true);
      paymentAvailable = true;
      recallMode = "valid";
      const valid = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId },
      });
      assert.equal(valid.statusCode, 200);
      assert.equal(valid.json().comparison.outcome, "GUIDANCE_DIFFERENCE");
      assert.equal(valid.json().off.proposal.action, "REQUEST_MERCHANT_REVIEW");
      assert.equal(valid.json().on.proposal.action, "REQUEST_MERCHANT_REVIEW");
      assert.equal(
        valid.json().off.investigation.id,
        valid.json().on.investigation.id,
        "one frozen observation shared by both arms",
      );
      await admin.query(
        "UPDATE morrow.orders SET product_category='subscription' WHERE tenant_id=$1 AND id=$2",
        [tenantId, orderBId],
      );
      const incompatible = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId },
      });
      assert.equal(incompatible.json().on.metrics.lessonsConsidered, 0);
      assert.equal(incompatible.json().comparison.outcome, "INCONCLUSIVE");
      await admin.query(
        "UPDATE morrow.tenants SET grant_enabled=false WHERE id=$1",
        [tenantId],
      );
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId },
      });
      assert.equal(denied.json().off.proposal.action, "REFUSE");
      assert.equal(denied.json().on.proposal.action, "REFUSE");

      // Same case rejected; cross-tenant case rejected as not found.
      const same = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId: a.caseId },
      });
      assert.equal(same.statusCode, 400);
      const other = await seedCase(admin);
      const cross = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${a.caseId}/comparisons`,
        headers: { authorization: "Bearer " + token },
        payload: { caseBId: other.caseId },
      });
      assert.equal(cross.statusCode, 404);

      // Persisted, read-only, no grant. COMPARISON_RUN is on target B.
      const events = await admin.query(
        "SELECT kind FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 ORDER BY id",
        [tenantId, caseBId],
      );
      assert.ok(events.rows.some((r) => r.kind === "COMPARISON_RUN"));
      const checks = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.payment_checks WHERE tenant_id=$1 AND case_id=$2",
        [tenantId, caseBId],
      );
      assert.ok(checks.rows[0].n >= 2, "both arms investigated target B");
      const ent = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.entitlements WHERE tenant_id=$1",
        [tenantId],
      );
      assert.equal(ent.rows[0].n, 0);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
