import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { CustomerService } from "../../src/customer.js";
import {
  DemoProvisioningService,
  type ReservedIntent,
} from "../../src/demo-provisioning.js";

const url = process.env.TEST_DATABASE_URL;

// Deterministic test-only intent builder. It is injected only in tests;
// the live server always uses the real Tatum builder from main.ts.
const fakeIntent = (): ReservedIntent => ({
  // Unique per call: payment_intents is unique on (network, digest), so a
  // reused digest must fail rather than become a newly paid order.
  digest: crypto.randomUUID().replace(/-/g, "").replace(/0/g, "1"),
  sender: `0x${"1".repeat(64)}`,
  recipient: `0x${"2".repeat(64)}`,
  amount: "1000000",
  transactionBytes: "dGVzdA==",
  gasRefs: [crypto.randomUUID()],
  gasBudget: "2000000",
});

function makeApp(db: ReturnType<typeof createPool>, demoEnabled = true) {
  return createApp(
    db,
    new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNUSED");
      },
    }),
    { demoEnabled },
    new CustomerService(db),
    undefined as never,
    undefined as never,
    undefined as never,
    new DemoProvisioningService(db, async () => fakeIntent()),
  );
}

test(
  "B2 provisioning creates an isolated demo case, session and payment instructions",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const app = makeApp(db);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": crypto.randomUUID() },
        payload: {},
      });
      assert.equal(res.statusCode, 201);
      const body = res.json();
      assert.match(body.caseId, /^[0-9a-f-]{36}$/i);
      assert.equal(body.token.length, 43);
      assert.match(body.orderRef, /^MRW-[A-Z0-9]{4,16}$/);
      assert.equal(body.demoEmail, "buyer@example.test");
      assert.equal(body.payment.network, "testnet");
      assert.match(body.payment.digest, /^[1-9A-HJ-NP-Za-km-z]{32,50}$/);
      assert.match(body.payment.instruction, /No transaction has been signed/);

      // Session works for the demo operator investigation route scope:
      // the case exists in exactly one tenant, with one intent.
      const tenant = await admin.query(
        "SELECT id, kind, grant_enabled FROM morrow.tenants WHERE id=$1",
        [body.tenantId],
      );
      assert.equal(tenant.rows[0].kind, "demo");
      assert.equal(tenant.rows[0].grant_enabled, true);
      const intent = await admin.query(
        "SELECT expected_digest, sender, recipient, amount::text AS amount FROM morrow.payment_intents WHERE tenant_id=$1 AND order_id=$2",
        [body.tenantId, body.orderId],
      );
      assert.equal(intent.rows[0].expected_digest, body.payment.digest);
      assert.equal(intent.rows[0].amount, "1000000");

      // Customer intake works with the provisioned reference/email.
      const intake = await app.inject({
        method: "POST",
        url: "/api/v1/help-requests",
        payload: {
          orderRef: body.orderRef,
          email: body.demoEmail,
          issue: "paid but no access",
        },
      });
      assert.equal(intake.statusCode, 200);
      assert.equal(intake.json().caseId, body.caseId);

      // A second provisioning creates a different isolated tenant/case.
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": crypto.randomUUID() },
        payload: {},
      });
      assert.equal(second.statusCode, 201);
      assert.notEqual(second.json().caseId, body.caseId);
      assert.notEqual(second.json().tenantId, body.tenantId);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "B2 provisioning stays closed when demo is disabled or builder is unconfigured",
  { skip: !url },
  async () => {
    const db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const disabled = makeApp(db, false);
    try {
      const res = await disabled.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": crypto.randomUUID() },
        payload: {},
      });
      assert.equal(res.statusCode, 401);
    } finally {
      await disabled.close();
    }
    const unconfigured = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
      new CustomerService(db),
      undefined as never,
      undefined as never,
      undefined as never,
      new DemoProvisioningService(db),
    );
    try {
      const res = await unconfigured.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": crypto.randomUUID() },
        payload: {},
      });
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, "DEMO_PAYMENT_UNAVAILABLE");
    } finally {
      await unconfigured.close();
      await db.end();
    }
  },
);

test(
  "B2 provisioning retries a digest collision with a distinct intent and leaves no orphan",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const unique = () =>
      crypto.randomUUID().replace(/-/g, "").replace(/0/g, "1");
    const base = {
      sender: `0x${"1".repeat(64)}`,
      recipient: `0x${"2".repeat(64)}`,
      amount: "1000000",
      transactionBytes: "dGVzdA==",
      gasRefs: [crypto.randomUUID()],
      gasBudget: "2000000",
    };
    const svc = new DemoProvisioningService(db, async () => ({
      digest: unique(),
      ...base,
      gasRefs: [crypto.randomUUID()],
      gasBudget: "2000000",
    }));
    const first = await svc.provision();
    assert.ok(first.payment);
    // Builder that first returns first's A digest (collides), then unique
    // digests on retry, must succeed with a different tenant.
    let retryCalls = 0;
    const retrySvc = new DemoProvisioningService(db, async () => ({
      digest: retryCalls++ === 0 ? first.payment!.digest : unique(),
      ...base,
      gasRefs: [crypto.randomUUID()],
      gasBudget: "2000000",
    }));
    const second = await retrySvc.provision();
    assert.ok(second.payment);
    assert.notEqual(second.payment.digest, first.payment.digest);
    assert.notEqual(second.tenantId, first.tenantId);
    assert.equal(second.payment.amountSui, "0.001");
    assert.equal(second.payments!.B, null);
    assert.equal(second.payments!.C, null);
    // A/B/C are linked in one tenant.
    assert.ok(second.caseBId && second.caseCId);
    const cases = await admin.query(
      "SELECT count(*)::int AS n FROM morrow.cases WHERE tenant_id=$1",
      [second.tenantId],
    );
    assert.equal(cases.rows[0].n, 3);
    await admin.end();
    await db.end();
  },
);

test(
  "B2 idempotency: same key resumes the same run without creating a duplicate",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const app = makeApp(db);
    const key = crypto.randomUUID();
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": key },
        payload: {},
      });
      assert.equal(first.statusCode, 201);
      const second = await app.inject({
        method: "POST",
        url: "/api/v1/demo/sessions",
        headers: { "idempotency-key": key },
        payload: {},
      });
      assert.equal(second.statusCode, 200);
      assert.equal(second.json().resumed, true);
      assert.equal(second.json().caseId, first.json().caseId);
      assert.equal(second.json().token, first.json().token);
      assert.deepEqual(second.json().payments, first.json().payments);
      const tenants = await admin.query(
        "SELECT count(*)::int AS n FROM morrow.demo_provisioning_keys WHERE key_hash=$1",
        [createHash("sha256").update(key).digest("hex")],
      );
      assert.equal(tenants.rows[0].n, 1);
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);

test(
  "lost response and concurrent retries recover the same capability without provider work; reset stays revoked",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
    let builds = 0;
    const svc = new DemoProvisioningService(db, async () => {
      builds++;
      return fakeIntent();
    });
    const key = crypto.randomUUID();
    try {
      const [a, b] = await Promise.all([
        svc.provision(key),
        svc.provision(key),
      ]);
      assert.equal(a.caseId, b.caseId);
      assert.equal(a.token, b.token);
      assert.equal(builds, 1);
      const recovered = await new DemoProvisioningService(db, async () => {
        throw Error("PROVIDER_OUTAGE");
      }).provision(key);
      assert.equal(recovered.token, a.token);
      assert.deepEqual(recovered.payments, a.payments);
      assert.equal(
        (await svc.provision(key, () => false)).caseId,
        a.caseId,
        "recovery does not consume creation quota",
      );
      const expiredKey = crypto.randomUUID(),
        expired = await svc.provision(expiredKey);
      await admin.query(
        "UPDATE morrow.demo_run_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1",
        [expired.tenantId],
      );
      await assert.rejects(() => svc.provision(expiredKey), {
        code: "DEMO_SESSION_EXPIRED",
      });
      const raw = await admin.query(
        "SELECT ciphertext FROM morrow.demo_run_receipts WHERE tenant_id=$1",
        [a.tenantId],
      );
      assert.equal(raw.rows[0].ciphertext.includes(a.token), false);
      await admin.query(
        "UPDATE morrow.demo_sessions SET used_requests=max_requests WHERE tenant_id=$1",
        [a.tenantId],
      );
      await assert.rejects(() => svc.provision(key), {
        code: "DEMO_SESSION_EXPIRED",
      });
    } finally {
      await admin.end();
      await db.end();
    }
  },
);

test(
  "shared gas is exclusively reserved, and conflicting run creation rolls back",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
    const ref = crypto.randomUUID();
    const svc = new DemoProvisioningService(db, async () => ({
      ...fakeIntent(),
      gasRefs: [ref],
    }));
    const key = crypto.randomUUID(),
      secondKey = crypto.randomUUID();
    try {
      const first = await svc.provision(key);
      await assert.rejects(() => svc.provision(secondKey), {
        code: "DEMO_PAYMENT_PENDING",
      });
      assert.equal((await svc.provision(key)).caseId, first.caseId);
      const orphan = await admin.query(
        "SELECT 1 FROM morrow.demo_provisioning_keys WHERE key_hash=$1",
        [createHash("sha256").update(secondKey).digest("hex")],
      );
      assert.equal(orphan.rowCount, 0);
    } finally {
      await admin.end();
      await db.end();
    }
  },
);

test(
  "B/C payments prepare sequentially after live confirmation, replay safely, and C refuses exact mismatch",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
    const svc = new DemoProvisioningService(db, async () => fakeIntent());
    const key = crypto.randomUUID();
    let available = false;
    const resolution = new ResolutionService(db, {
      getTransaction: async (digest) => {
        if (!available) throw Error("UNSIGNED");
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
    try {
      const run = await svc.provision(key),
        actor = {
          tenantId: run.tenantId,
          operatorId: run.operatorId,
          role: "judge" as const,
        };
      await assert.rejects(() => svc.prepare(actor, key, "B", resolution), {
        code: "PREVIOUS_PAYMENT_UNCONFIRMED",
      });
      available = true;
      const b = await svc.prepare(actor, key, "B", resolution);
      assert.ok(b.payments.B);
      assert.equal(b.payments.C, null);
      assert.deepEqual(
        (await svc.prepare(actor, key, "B", resolution)).payments.B,
        b.payments.B,
      );
      const c = await svc.prepare(actor, key, "C", resolution);
      assert.ok(c.payments.C);
      assert.equal(c.payments.C.amountMist, "1000001");
      assert.equal(c.payments.C.transactionAmountMist, "1000000");
      const checked = await resolution.investigate(actor, c.caseCId);
      assert.equal(checked.verdict, "MISMATCH");
      assert.equal(checked.reason, "RECIPIENT_ASSET_AMOUNT");
      await assert.rejects(
        () =>
          svc.prepare(
            { ...actor, tenantId: crypto.randomUUID() },
            key,
            "B",
            resolution,
          ),
        { code: "CASE_NOT_FOUND" },
      );
      const grants = await admin.query(
        "SELECT 1 FROM morrow.entitlements WHERE tenant_id=$1",
        [run.tenantId],
      );
      assert.equal(grants.rowCount, 0);
      await assert.rejects(
        () => svc.prepare({ ...actor, role: "merchant" }, key, "B", resolution),
        { code: "FORBIDDEN" },
      );
      await admin.query(
        "UPDATE morrow.operators SET active=false WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, actor.operatorId],
      );
      await assert.rejects(() => svc.prepare(actor, key, "B", resolution), {
        code: "FORBIDDEN",
      });
    } finally {
      await admin.end();
      await db.end();
    }
  },
);
