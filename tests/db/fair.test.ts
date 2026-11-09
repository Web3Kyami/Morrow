import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService, hashPassword } from "../../src/merchant.js";
import { FairComparisonService } from "../../src/fair.js";
import { hash } from "../../src/customer.js";
import { seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const EMAIL =
  "merchant-fair-" + randomBytes(6).toString("hex") + "@example.test";
const PASSWORD = "fixture-password";

test(
  "S9 fair comparison: OFF never reads memory, ON only adds guidance, run persists",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const mc = await seedMerchantCase(admin);
    await admin.query(
      "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
      [
        hash(EMAIL),
        mc.actor.tenantId,
        mc.actor.operatorId,
        hashPassword(PASSWORD),
      ],
    );
    // A RECALL_VERIFIED lesson in this tenant with an extra step.
    const suffix = randomBytes(6).toString("hex");
    const accountId = "0x" + suffix.repeat(11).slice(0, 64);
    await tenantTransaction(admin, mc.actor.tenantId, async (db2) => {
      await db2.query(
        `INSERT INTO morrow.lessons(tenant_id,id,case_id,approved_by,policy_version,payload,fingerprint,network,account_id,namespace,content_hash,fingerprint_version,state,job_id,blob_id,completed_at,recalled_at)
         VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,'testnet',$7,$8,$9,2,'RECALL_VERIFIED',$10,$11,clock_timestamp(),clock_timestamp())`,
        [
          mc.actor.tenantId,
          "00000000-0000-4000-8000-" + randomBytes(6).toString("hex"),
          mc.caseId,
          mc.actor.operatorId,
          JSON.stringify({
            sourceCaseId: mc.caseId,
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
          }),
          "fingerprint-" + suffix,
          accountId,
          `morrow-testnet:${mc.actor.tenantId}`,
          "content-hash-" + suffix,
          "job-" + suffix,
          "blob-" + suffix,
        ],
      );
    });
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("NO_LIVE_TATUM");
        },
      }),
      { demoEnabled: true },
      undefined as never,
      new MerchantService(db),
      undefined as never,
      new FairComparisonService(db),
    );
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email: EMAIL, password: PASSWORD },
      });
      const cookie =
        "morrow_merchant_session=" +
        String(login.headers["set-cookie"]).match(
          /morrow_merchant_session=([^;]+)/,
        )?.[1];

      const off = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/fair`,
        headers: { cookie },
        payload: { mode: "OFF" },
      });
      assert.equal(off.statusCode, 200);
      assert.equal(off.json().metrics.lessonsConsidered, 0);
      assert.equal(
        off.json().metrics.steps,
        7,
        "OFF uses the fixed contract plan",
      );

      const on = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/fair`,
        headers: { cookie },
        payload: { mode: "ON" },
      });
      assert.equal(on.statusCode, 200);
      assert.equal(on.json().metrics.lessonsConsidered, 1);
      assert.ok(
        on.json().plan.includes("ESCALATE_UNKNOWN"),
        "ON adds only the lesson's extra step",
      );

      // A current-policy change makes the previously recalled lesson ineligible.
      await admin.query(
        "UPDATE morrow.tenants SET policy_version=2 WHERE id=$1",
        [mc.actor.tenantId],
      );
      const stale = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/fair`,
        headers: { cookie },
        payload: { mode: "ON" },
      });
      assert.equal(stale.statusCode, 200);
      assert.equal(
        stale.json().metrics.lessonsConsidered,
        0,
        "old policy lessons cannot guide a current case",
      );

      // Both runs persisted as read-only simulation events.
      const events = await admin.query(
        `SELECT data FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 AND kind='SIMULATION_RUN' ORDER BY id`,
        [mc.actor.tenantId, mc.caseId],
      );
      assert.equal(events.rowCount, 3, "all read-only runs persisted");
      assert.equal(events.rows[0].data.metrics.lessonsConsidered, 0);
      assert.equal(events.rows[1].data.metrics.lessonsConsidered, 1);

      // Neither run granted anything.
      const entitlements = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
        [mc.actor.tenantId, mc.orderId],
      );
      assert.equal(entitlements.rows[0].n, 0);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
