import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { CustomerService, hash } from "../../src/customer.js";
import { seedCase, seedMerchantCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
const CUSTOMER_EMAIL = "case-a-buyer@example.test";

test(
  "S4 customer intake + status from persisted evidence only",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = `MRW-${randomBytes(3).toString("hex").toUpperCase()}`;
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [f.actor.tenantId, f.orderId, hash(orderRef), hash(CUSTOMER_EMAIL)],
    );
    const service = new ResolutionService(db, {
      getTransaction: async () => ({
        ...f.evidence,
        checkedAt: new Date().toISOString(),
      }),
    });
    const app = createApp(
      db,
      service,
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      // No static dir in tests: no page routes registered.
      assert.equal((await app.inject({ url: "/help" })).statusCode, 404);

      // Unknown order and wrong email stay generic.
      const unknown = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef: "MRW-NOPE1234",
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(unknown.statusCode, 404);
      assert.equal(unknown.json().error, "ORDER_NOT_FOUND");
      const wrongEmail = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef,
          email: "someone-else@example.test",
          issue: "paid but no access",
        },
      });
      assert.equal(wrongEmail.statusCode, 404);

      // Cross-origin refused; same-origin allowed.
      const cross = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        headers: { origin: "https://evil.example" },
        payload: {
          orderRef,
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(cross.statusCode, 403);

      const intake = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        headers: { origin: "http://localhost", host: "localhost" },
        payload: {
          orderRef,
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(intake.statusCode, 200);
      const intakeBody = intake.json();
      assert.equal(intakeBody.caseId, f.caseId);
      assert.ok(intakeBody.accessToken);
      const token = intakeBody.accessToken as string;

      // Status without a valid token cannot leak.
      assert.equal(
        (await app.inject({ url: `/api/v1/help-cases/${f.caseId}` }))
          .statusCode,
        403,
      );
      const wrongToken = await app.inject({
        url: `/api/v1/help-cases/${f.caseId}`,
        headers: { authorization: `Bearer ${"A".repeat(43)}` },
      });
      assert.equal(wrongToken.statusCode, 404);

      const statusUrl = `/api/v1/help-cases/${f.caseId}`;
      const before = await app.inject({
        url: statusUrl,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(before.statusCode, 200);
      const beforeBody = before.json();
      assert.equal(beforeBody.payment.verdict, "NOT_CHECKED");
      assert.equal(beforeBody.access.entitled, false);
      assert.equal(
        JSON.stringify(beforeBody).includes(f.evidence.digest),
        false,
        "no raw digest in status",
      );

      // Run the demo bearer investigation so a persisted MATCH exists.
      const { randomBytes } = await import("node:crypto");
      const demoToken = randomBytes(32).toString("base64url");
      await admin.query(
        `INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests) VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes',20)`,
        [
          createHash("sha256").update(demoToken).digest("hex"),
          f.actor.tenantId,
          f.actor.operatorId,
        ],
      );
      const investigated = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${f.caseId}/investigations`,
        headers: { authorization: `Bearer ${demoToken}` },
      });
      assert.equal(investigated.statusCode, 200);
      assert.equal(investigated.json().verdict, "MATCH");

      const after = await app.inject({
        url: statusUrl,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(after.json().payment.verdict, "MATCH");

      const decision = await service.decide(f.actor, {
        caseId: f.caseId,
        caseVersion: 1,
        policyVersion: 1,
        kind: "APPROVED",
      });
      const approved = await app.inject({
        url: statusUrl,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(approved.json().decision.kind, "APPROVED");
      assert.equal(
        approved.json().access.entitled,
        false,
        "approval alone is not access",
      );
      assert.equal(approved.json().repair, null);
      await admin.query(
        "UPDATE morrow.tenants SET policy_version=2 WHERE id=$1",
        [f.actor.tenantId],
      );
      const stale = await app.inject({
        url: statusUrl,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(
        stale.json().decision.current,
        false,
        "stale approval cannot appear current",
      );
      assert.ok(decision.id);

      // Validation errors preserve the shape (client shows inline errors).
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: { orderRef: "BAD", email: "not-an-email", issue: "x" },
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "S4 intake stays closed when the demo is disabled",
  { skip: !url },
  async () => {
    const db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNUSED");
      },
    });
    const app = createApp(
      db,
      service,
      { demoEnabled: false },
      new CustomerService(db),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef: "MRW-TEST1234",
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await app.close();
      await db.end();
    }
  },
);

test(
  "public customer intake excludes unmarked merchant orders",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const merchant = await seedMerchantCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = "MRW-ORDR" + randomBytes(4).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [
        merchant.actor.tenantId,
        merchant.orderId,
        hash(orderRef),
        hash(CUSTOMER_EMAIL),
      ],
    );
    const marker = await admin.query(
      "SELECT public_demo_intake FROM morrow.tenants WHERE id=$1",
      [merchant.actor.tenantId],
    );
    assert.equal(marker.rows[0]?.public_demo_intake, false);
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef,
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error, "ORDER_NOT_FOUND");
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "explicit fictional merchant intake works while its marker stays owner-managed",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const merchant = await seedMerchantCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = "MRW-ORDR" + randomBytes(4).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [
        merchant.actor.tenantId,
        merchant.orderId,
        hash(orderRef),
        hash(CUSTOMER_EMAIL),
      ],
    );
    await admin.query(
      "UPDATE morrow.tenants SET public_demo_intake=true WHERE id=$1",
      [merchant.actor.tenantId],
    );
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      await assert.rejects(
        db.query(
          "UPDATE morrow.tenants SET public_demo_intake=false WHERE id=$1",
          [merchant.actor.tenantId],
        ),
        (error: unknown) => (error as { code?: string }).code === "42501",
      );

      const intake = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef,
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
      assert.equal(intake.statusCode, 200);
      const accessToken = intake.json().accessToken as string;

      const status = await app.inject({
        url: `/api/v1/help-cases/${merchant.caseId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(status.statusCode, 200);

      await admin.query(
        "UPDATE morrow.tenants SET public_demo_intake=false WHERE id=$1",
        [merchant.actor.tenantId],
      );
      const closedStatus = await app.inject({
        url: `/api/v1/help-cases/${merchant.caseId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      assert.equal(closedStatus.statusCode, 404);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "concurrent first help submissions create one request without server errors",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = "MRW-" + randomBytes(6).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [f.actor.tenantId, f.orderId, hash(orderRef), hash(CUSTOMER_EMAIL)],
    );
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          app.inject({
            method: "POST",
            url: "/api/v1/help-requests",
            payload: {
              orderRef,
              email: CUSTOMER_EMAIL,
              issue: "paid but no access",
            },
          }),
        ),
      );
      assert.deepEqual(
        results.map((r) => r.statusCode),
        [200, 200, 200],
      );
      assert.equal(new Set(results.map((r) => r.json().helpRequestId)).size, 1);
      assert.equal(results.filter((r) => r.json().created).length, 1);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "B1 durable intake budget: exactly five counted attempts, then 429; wrong ownership does not consume quota",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = "MRW-" + randomBytes(6).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [f.actor.tenantId, f.orderId, hash(orderRef), hash(CUSTOMER_EMAIL)],
    );
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      // Wrong-email attempts stay generic and must not consume quota.
      // Kept to 3 so the separate per-IP budget (10/min in http.ts)
      // does not mask the durable per-order quota under test.
      for (let i = 0; i < 3; i++) {
        const wrong = await app.inject({
          method: "POST",
          url: "/api/v1/help-requests",
          payload: {
            orderRef,
            email: "someone-else@example.test",
            issue: "paid but no access",
          },
        });
        assert.equal(wrong.statusCode, 404);
      }
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) {
        const r = await app.inject({
          method: "POST",
          url: "/api/v1/help-requests",
          payload: {
            orderRef,
            email: CUSTOMER_EMAIL,
            issue: `paid but no access ${i}`,
          },
        });
        codes.push(r.statusCode);
        if (r.statusCode === 429)
          assert.equal(r.json().error, "INTAKE_RATE_LIMITED");
      }
      assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
      // Attempts are durable in help_intake_attempts, not derived from
      // the single help_requests row.
      const attempts = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.help_intake_attempts WHERE tenant_id=$1 AND order_id=$2",
        [f.actor.tenantId, f.orderId],
      );
      assert.equal(attempts.rows[0].n, 5);
      const helpRows = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.help_requests WHERE tenant_id=$1",
        [f.actor.tenantId],
      );
      assert.equal(helpRows.rows[0].n, 1);
      // A fresh service instance (process restart) still enforces the
      // persisted budget.
      const db2 = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
      const app2 = createApp(
        db2,
        new ResolutionService(db2, {
          getTransaction: async () => {
            throw new Error("UNUSED");
          },
        }),
        { demoEnabled: true },
        new CustomerService(db2),
      );
      try {
        const afterRestart = await app2.inject({
          method: "POST",
          url: "/api/v1/help-requests",
          payload: {
            orderRef,
            email: CUSTOMER_EMAIL,
            issue: "paid but no access after restart",
          },
        });
        assert.equal(afterRestart.statusCode, 429);
      } finally {
        await app2.close();
        await db2.end();
      }
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "B1 concurrent intakes consume quota transactionally: exactly five succeed",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const { randomBytes } = await import("node:crypto");
    const orderRef = "MRW-" + randomBytes(6).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4)",
      [f.actor.tenantId, f.orderId, hash(orderRef), hash(CUSTOMER_EMAIL)],
    );
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          app.inject({
            method: "POST",
            url: "/api/v1/help-requests",
            payload: {
              orderRef,
              email: CUSTOMER_EMAIL,
              issue: `paid but no access ${i}`,
            },
          }),
        ),
      );
      const ok = results.filter((r) => r.statusCode === 200).length;
      const limited = results.filter((r) => r.statusCode === 429).length;
      assert.equal(ok, 5);
      assert.equal(limited, 3);
      const attempts = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.help_intake_attempts WHERE tenant_id=$1 AND order_id=$2",
        [f.actor.tenantId, f.orderId],
      );
      assert.equal(attempts.rows[0].n, 5);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "B1 window rollover and tenant isolation: aged attempts stop counting; another tenant is unaffected",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const a = await seedCase(admin);
    const b = await seedCase(admin);
    const { randomBytes } = await import("node:crypto");
    const refA = "MRW-" + randomBytes(6).toString("hex").toUpperCase();
    const refB = "MRW-" + randomBytes(6).toString("hex").toUpperCase();
    await admin.query(
      "INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash) VALUES ($1,$2,$3,$4),($5,$6,$7,$8)",
      [
        a.actor.tenantId,
        a.orderId,
        hash(refA),
        hash(CUSTOMER_EMAIL),
        b.actor.tenantId,
        b.orderId,
        hash(refB),
        hash(CUSTOMER_EMAIL),
      ],
    );
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
    );
    const post = (orderRef: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef,
          email: CUSTOMER_EMAIL,
          issue: "paid but no access",
        },
      });
    try {
      for (let i = 0; i < 5; i++)
        assert.equal((await post(refA)).statusCode, 200);
      assert.equal((await post(refA)).statusCode, 429);
      // Tenant B has its own quota.
      assert.equal((await post(refB)).statusCode, 200);
      // Age tenant A's attempts beyond the rolling 24h window (owner role;
      // the runtime role cannot rewrite attempts, see permission grant).
      await admin.query(
        "UPDATE morrow.help_intake_attempts SET attempted_at = clock_timestamp() - interval '2 days' WHERE tenant_id=$1 AND order_id=$2",
        [a.actor.tenantId, a.orderId],
      );
      assert.equal((await post(refA)).statusCode, 200);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
