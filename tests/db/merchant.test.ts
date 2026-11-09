import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService } from "../../src/merchant.js";
import { hash } from "../../src/customer.js";
import { hashPassword } from "../../src/merchant.js";
import { seedCase, seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const MERCHANT_EMAIL =
  "mira-merchant-" + randomBytes(6).toString("hex") + "@example.test";
const MERCHANT_PASSWORD = "fixture-password";

test(
  "S5 merchant sign-in, queue scope, detail and search",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const mc = await seedMerchantCase(admin);
    const mc2 = await seedMerchantCase(admin);
    const judge = await seedCase(admin);
    // Second merchant case under a different tenant must stay invisible.
    await admin.query(
      "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
      [
        hash(MERCHANT_EMAIL),
        mc.actor.tenantId,
        mc.actor.operatorId,
        hashPassword(MERCHANT_PASSWORD),
      ],
    );
    // Seed the judge/demo case under a different tenant too (must not appear).
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNUSED");
      },
    });
    const app = createApp(
      db,
      service,
      { demoEnabled: true, fixtureLoginEnabled: true },
      undefined as never,
      new MerchantService(db),
    );
    try {
      // Unauthenticated queue and detail are closed.
      assert.equal(
        (await app.inject({ url: "/api/v1/merchant/cases" })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ url: `/api/v1/merchant/cases/${mc.caseId}` }))
          .statusCode,
        401,
      );

      // Wrong password is a generic refusal.
      const badLogin = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email: MERCHANT_EMAIL, password: "wrong-password" },
      });
      assert.equal(badLogin.statusCode, 401);
      assert.equal(badLogin.json().error, "INVALID_CREDENTIALS");

      // Correct password sets an HttpOnly cookie.
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email: MERCHANT_EMAIL, password: MERCHANT_PASSWORD },
      });
      assert.equal(login.statusCode, 200);
      const setCookie = String(login.headers["set-cookie"] ?? "");
      assert.match(setCookie, /morrow_merchant_session=/);
      assert.match(setCookie, /HttpOnly/);
      const token =
        setCookie.match(/morrow_merchant_session=([^;]+)/)?.[1] ?? "";
      assert.ok(token.length >= 40);
      const cookie = `morrow_merchant_session=${token}`;

      const queue = await app.inject({
        url: "/api/v1/merchant/cases",
        headers: { cookie },
      });
      assert.equal(queue.statusCode, 200);
      const queueBody = queue.json();
      assert.equal(queueBody.cases.length, 1);
      assert.equal(queueBody.cases[0].caseId, mc.caseId);
      assert.equal(queueBody.cases[0].paymentAttested, false);
      assert.equal(queueBody.cases[0].access, "MISSING");

      // Exact tenant-scoped contract: case UUID search finds its own case only.
      const search = await app.inject({
        url: `/api/v1/merchant/cases?q=${mc.caseId}`,
        headers: { cookie },
      });
      assert.equal(search.json().cases.length, 1);
      const otherSearch = await app.inject({
        url: `/api/v1/merchant/cases?q=${mc2.caseId}`,
        headers: { cookie },
      });
      assert.equal(
        otherSearch.json().cases.length,
        0,
        "other merchant cases stay invisible",
      );

      // Judge/demo case is not visible to the merchant.
      const judgeDetail = await app.inject({
        url: `/api/v1/merchant/cases/${judge.caseId}`,
        headers: { cookie },
      });
      assert.equal(judgeDetail.statusCode, 404);

      const detail = await app.inject({
        url: `/api/v1/merchant/cases/${mc.caseId}`,
        headers: { cookie },
      });
      assert.equal(detail.statusCode, 200);
      const detailBody = detail.json();
      assert.equal(detailBody.paymentAttested, false);
      assert.equal(detailBody.access, "MISSING");
      assert.ok(detailBody.policy);
      assert.ok(detailBody.evidence);

      // Logout invalidates the session.
      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/logout",
        headers: { cookie },
      });
      assert.equal(logout.statusCode, 200);
      const after = await app.inject({
        url: "/api/v1/merchant/cases",
        headers: { cookie },
      });
      assert.equal(after.statusCode, 401);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "merchant sign-in remains available when public demo routes are disabled",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const seeded = await seedMerchantCase(admin);
    const email =
      "mira-private-" + randomBytes(6).toString("hex") + "@example.test";
    await admin.query(
      "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
      [
        hash(email),
        seeded.actor.tenantId,
        seeded.actor.operatorId,
        hashPassword(MERCHANT_PASSWORD),
      ],
    );
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNUSED");
      },
    });
    const app = createApp(
      db,
      service,
      { demoEnabled: false, fixtureLoginEnabled: true },
      undefined as never,
      new MerchantService(db),
    );
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email, password: MERCHANT_PASSWORD },
      });
      assert.equal(login.statusCode, 200);
      const cookie = String(login.headers["set-cookie"] ?? "").split(";")[0]!;
      const queue = await app.inject({
        url: "/api/v1/merchant/cases",
        headers: { cookie },
      });
      assert.equal(queue.statusCode, 200);
      assert.equal(queue.json().cases.length, 1);
      assert.equal(queue.json().cases[0].caseId, seeded.caseId);

      const demo = await app.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": randomBytes(24).toString("base64url") },
        payload: {},
      });
      assert.equal(demo.statusCode, 401);

      const intake = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {},
      });
      assert.equal(intake.statusCode, 401);

      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session/logout",
        headers: { cookie },
      });
      assert.equal(logout.statusCode, 200);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

function digestOf(n: number) {
  return randomBytes(n).toString("base64url");
}
