import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService, hashPassword } from "../../src/merchant.js";
import { hash } from "../../src/customer.js";
import { seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const EMAIL =
  "merchant-decider-" + randomBytes(6).toString("hex") + "@example.test";
const PASSWORD = "fixture-password";

async function setup() {
  const admin = createPool(url!),
    db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
  const mc = await seedMerchantCase(admin);
  const other = await seedMerchantCase(admin);
  await admin.query(
    "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
    [
      hash(EMAIL),
      mc.actor.tenantId,
      mc.actor.operatorId,
      hashPassword(PASSWORD),
    ],
  );
  const service = new ResolutionService(db, {
    getTransaction: async () => {
      throw new Error("NO_LIVE_TATUM_IN_MERCHANT_FIXTURE");
    },
  });
  const app = createApp(
    db,
    service,
    { demoEnabled: true, fixtureLoginEnabled: true },
    undefined as never,
    new MerchantService(db),
    undefined as never,
  );
  return { admin, db, mc, other, app };
}

test(
  "S7 merchant approve needs a fresh match; reject never grants",
  { skip: !url },
  async () => {
    const { admin, db, mc, other, app } = await setup();
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email: EMAIL, password: PASSWORD },
      });
      assert.match(
        String(login.headers["set-cookie"]),
        /; Secure/,
        "merchant session cookies require HTTPS by default",
      );
      const cookie =
        "morrow_merchant_session=" +
        String(login.headers["set-cookie"]).match(
          /morrow_merchant_session=([^;]+)/,
        )?.[1];
      const tenantId = mc.actor.tenantId;

      const checked = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/investigations`,
        headers: { cookie },
      });
      assert.equal(checked.statusCode, 200);
      assert.equal(
        checked.json().verdict,
        "UNKNOWN",
        "an unavailable provider cannot appear matched",
      );
      const crossCheck = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${other.caseId}/investigations`,
        headers: { cookie },
      });
      assert.equal(crossCheck.statusCode, 404);

      // Approve without any fresh payment check is refused honestly.
      const premature = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/decisions`,
        headers: { cookie },
        payload: { kind: "APPROVED", caseVersion: 1, policyVersion: 1 },
      });
      assert.equal(premature.statusCode, 409);
      assert.equal(premature.json().error, "PAYMENT_NOT_CONFIRMED");

      // Cross-tenant decision attempt stays hidden.
      const cross = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${other.caseId}/decisions`,
        headers: { cookie },
        payload: { kind: "REJECTED", caseVersion: 1, policyVersion: 1 },
      });
      assert.equal(cross.statusCode, 404);

      // Stale policy version is refused.
      const stale = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/decisions`,
        headers: { cookie },
        payload: { kind: "REJECTED", caseVersion: 1, policyVersion: 99 },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, "STALE_REVIEW");

      // Rejection is recorded and never grants access.
      const rejected = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/decisions`,
        headers: { cookie },
        payload: { kind: "REJECTED", caseVersion: 1, policyVersion: 1 },
      });
      assert.equal(rejected.statusCode, 201);
      const decisionId = rejected.json().id;
      const queue = await app.inject({
        url: "/api/v1/merchant/cases",
        headers: { cookie },
      });
      const queuedCase = queue
        .json()
        .cases.find((c: { caseId: string }) => c.caseId === mc.caseId);
      assert.deepEqual(
        queuedCase.decision,
        { kind: "REJECTED", current: true },
        "the queue must not return a declined case as awaiting its first decision",
      );

      // Repair after a rejection is impossible.
      const repair = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/repairs`,
        headers: { cookie },
        payload: { decisionId, idempotencyKey: "merchant-repair-1" },
      });
      assert.equal(repair.statusCode, 403);
      assert.equal(repair.json().error, "APPROVAL_REQUIRED");

      // Even a fresh fixture match cannot be repaired without live Tatum
      // evidence: merchant fixture tenants never touch live payment state.
      await tenantTransaction(admin, tenantId, async (db) => {
        await db.query(
          `INSERT INTO morrow.payment_checks(tenant_id,id,case_id,verdict,reason,evidence)
           VALUES ($1,$2,$3,'MATCH','PRECOMMITTED_PAYMENT_CONFIRMED',$4::jsonb)`,
          [
            tenantId,
            randomUUID(),
            mc.caseId,
            JSON.stringify({
              provider: "tatum",
              method: "sui.rpc.v2.LedgerService/GetTransaction",
              network: "testnet",
              digest: mc.digest,
              source: "demo-fixture",
            }),
          ],
        );
      });
      const approved = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/decisions`,
        headers: { cookie },
        payload: { kind: "APPROVED", caseVersion: 2, policyVersion: 1 },
      });
      assert.equal(approved.statusCode, 201);
      const liveRepair = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/repairs`,
        headers: { cookie },
        payload: {
          decisionId: approved.json().id,
          idempotencyKey: "merchant-repair-2",
        },
      });
      assert.equal(liveRepair.statusCode, 409);
      assert.equal(liveRepair.json().error, "PAYMENT_NOT_CONFIRMED");

      // Nothing was ever granted to this order.
      const access = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
        [tenantId, mc.orderId],
      );
      assert.equal(access.rows[0].n, 0);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
