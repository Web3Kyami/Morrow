import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { MerchantService, hashPassword } from "../../src/merchant.js";
import { LessonService } from "../../src/lessons.js";
import type { MemoryGateway } from "../../src/memory.js";
import { hash } from "../../src/customer.js";
import { seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const EMAIL =
  "merchant-teacher-" + randomBytes(6).toString("hex") + "@example.test";
const PASSWORD = "fixture-password";
const PROCEDURE = [
  "VERIFY_CURRENT_ORDER",
  "VERIFY_PAYMENT_INTENT",
  "CHECK_CURRENT_POLICY",
  "CHECK_PERSISTED_ACCESS",
  "REQUEST_MERCHANT_APPROVAL",
  "GRANT_IDEMPOTENTLY",
  "CONFIRM_READBACK",
];

function stubGateway(state: { job: string; blob: string }): MemoryGateway {
  return {
    async remember(text, idempotencyKey) {
      void text;
      void idempotencyKey;
      return { jobId: state.job };
    },
    async status(jobId) {
      return { job_id: jobId, status: "pending" };
    },
    async recall() {
      return [];
    },
    close() {},
  };
}

test(
  "S8 lesson approval requires a confirmed repair and stays workspace-local",
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
    const tenantConfig = {
      network: "testnet" as const,
      accountId: "0x" + "1".repeat(64),
      key: "k",
      namespace: `morrow-testnet:${mc.actor.tenantId}`,
    };
    const gateway = stubGateway({ job: randomUUID(), blob: "b" });
    const lessonService = new LessonService(db, tenantConfig, gateway);
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("NO_LIVE_TATUM");
      },
    });
    const app = createApp(
      db,
      service,
      {
        demoEnabled: true,
        fixtureLoginEnabled: true,
        providerStatus: async () => ({
          database: { state: "CONNECTED" },
          tatum: { state: "UNAVAILABLE", network: "testnet" },
          walrus: { state: "NOT_CONFIGURED", network: null },
        }),
        merchantLessons: () => ({
          service: lessonService,
          tenantConfig,
          close: () => {},
        }),
      },
      undefined as never,
      new MerchantService(db),
      undefined as never,
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

      const privateProviderStatus = await app.inject({
        url: "/api/v1/merchant/providers",
      });
      assert.equal(privateProviderStatus.statusCode, 401);
      const providerStatus = await app.inject({
        url: "/api/v1/merchant/providers",
        headers: { cookie },
      });
      assert.equal(providerStatus.statusCode, 200);
      assert.equal(providerStatus.json().tatum.state, "UNAVAILABLE");
      assert.equal(providerStatus.json().walrus.network, null);

      // Neither draft creation nor the old one-step route may bypass repair.
      const refused = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft`,
        headers: { cookie },
        payload: { productCategory: "course" },
      });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().error, "REPAIR_NOT_CONFIRMED");
      const legacy = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson`,
        headers: { cookie },
        payload: { productCategory: "course", procedure: PROCEDURE },
      });
      assert.equal(legacy.statusCode, 409);
      assert.equal(legacy.json().error, "LESSON_DRAFT_REQUIRED");

      // Record an executed repair + entitlement fixture (persisted, not provider).
      const decisionId = randomUUID();
      await tenantTransaction(admin, mc.actor.tenantId, async (db2) => {
        await db2.query(
          "INSERT INTO morrow.decisions(tenant_id,id,case_id,operator_id,kind,case_version,policy_version) VALUES ($1,$2,$3,$4,'APPROVED',2,1)",
          [mc.actor.tenantId, decisionId, mc.caseId, mc.actor.operatorId],
        );
        await db2.query(
          "INSERT INTO morrow.repairs(tenant_id,id,case_id,decision_id,operator_id,idempotency_key,fingerprint,status) VALUES ($1,$2,$3,$4,$5,'test-key-0001','f','EXECUTED')",
          [
            mc.actor.tenantId,
            randomUUID(),
            mc.caseId,
            decisionId,
            mc.actor.operatorId,
          ],
        );
        await db2.query(
          "INSERT INTO morrow.entitlements(tenant_id,order_id,product_id) VALUES ($1,$2,$3)",
          [
            mc.actor.tenantId,
            mc.orderId,
            (
              await db2.query(
                "SELECT product_id FROM morrow.orders WHERE tenant_id=$1 AND id=$2",
                [mc.actor.tenantId, mc.orderId],
              )
            ).rows[0].product_id,
          ],
        );
      });

      const opened = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft`,
        headers: { cookie },
        payload: { productCategory: "course" },
      });
      assert.equal(opened.statusCode, 200);
      assert.equal(opened.json().approval_state, "DRAFT");
      assert.equal(opened.json().version, 1);

      const saved = await app.inject({
        method: "PUT",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft`,
        headers: { cookie },
        payload: {
          version: 1,
          productCategory: "course",
          applicableCategories: ["course", "download"],
          procedure: PROCEDURE,
          unexpectedText: "customer email@example.test",
        },
      });
      assert.equal(saved.statusCode, 400, "unknown text fields are rejected");
      const savedDraft = await app.inject({
        method: "PUT",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft`,
        headers: { cookie },
        payload: {
          version: 1,
          productCategory: "course",
          applicableCategories: ["course", "download"],
          procedure: PROCEDURE,
        },
      });
      assert.equal(savedDraft.statusCode, 200);
      assert.equal(savedDraft.json().version, 2);

      const draftLibrary = await app.inject({
        method: "GET",
        url: "/api/v1/merchant/lessons?q=course",
        headers: { cookie },
      });
      assert.equal(draftLibrary.statusCode, 200);
      assert.equal(draftLibrary.json().drafts.length, 1);
      assert.equal(draftLibrary.json().drafts[0].policyVersion, 1);
      assert.deepEqual(draftLibrary.json().drafts[0].applicableCategories, [
        "course",
        "download",
      ]);

      const stale = await app.inject({
        method: "PUT",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft`,
        headers: { cookie },
        payload: {
          version: 1,
          productCategory: "course",
          applicableCategories: ["course"],
          procedure: PROCEDURE,
        },
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.json().error, "STALE_DRAFT");

      const approved = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft/approve`,
        headers: { cookie },
        payload: { version: 2 },
      });
      assert.equal(approved.statusCode, 200);
      assert.equal(approved.json().state, "APPROVED");

      // Same draft version resumes the persisted approval without duplication.
      const again = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft/approve`,
        headers: { cookie },
        payload: { version: 2 },
      });
      assert.equal(again.statusCode, 200);
      assert.equal(again.json().id, approved.json().id);

      const wrongCase = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${randomUUID()}/lesson/${approved.json().id}/advance`,
        headers: { cookie },
      });
      assert.equal(
        wrongCase.statusCode,
        404,
        "lesson actions must be bound to the case in the URL",
      );

      // Advance reports PENDING (accepted job is not stored memory).
      const advanced = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson/${approved.json().id}/advance`,
        headers: { cookie },
      });
      assert.equal(advanced.statusCode, 200);
      assert.equal(advanced.json().state, "PENDING");

      const library = await app.inject({
        method: "GET",
        url: "/api/v1/merchant/lessons?q=course",
        headers: { cookie },
      });
      assert.equal(library.statusCode, 200);
      assert.equal(library.json().lessons.length, 1);
      assert.equal(library.json().lessons[0].applicableCategories.length, 2);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "S8 lesson routes stay disabled when memory is unconfigured",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const mc = await seedMerchantCase(admin);
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("NO_LIVE_TATUM");
      },
    });
    const merchant = new MerchantService(db);
    const app = createApp(
      db,
      service,
      {
        demoEnabled: true,
        fixtureLoginEnabled: true,
        merchantLessons: () => null,
      },
      undefined as never,
      merchant,
      undefined as never,
    );
    try {
      // Even unauthenticated, the disabled state is honest (not a fake lesson).
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson`,
        payload: { productCategory: "course", procedure: PROCEDURE },
      });
      assert.equal(res.statusCode, 401);
      await admin.query(
        "INSERT INTO morrow.merchant_identities(email_hash,tenant_id,operator_id,password_hash) VALUES ($1,$2,$3,$4)",
        [
          hash(EMAIL + "b"),
          mc.actor.tenantId,
          mc.actor.operatorId,
          hashPassword(PASSWORD),
        ],
      );
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/merchant/session",
        payload: { email: EMAIL + "b", password: PASSWORD },
      });
      const cookie =
        "morrow_merchant_session=" +
        String(login.headers["set-cookie"]).match(
          /morrow_merchant_session=([^;]+)/,
        )?.[1];
      const disabled = await app.inject({
        method: "POST",
        url: `/api/v1/merchant/cases/${mc.caseId}/lesson-draft/approve`,
        headers: { cookie },
        payload: { version: 1 },
      });
      assert.equal(disabled.statusCode, 503);
      assert.equal(disabled.json().error, "MEMORY_UNAVAILABLE");
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
