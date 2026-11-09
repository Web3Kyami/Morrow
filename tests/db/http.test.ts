import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { seedCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
test(
  "HTTP bearer session -> payment investigation -> decision -> durable repair/readback",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin),
      other = await seedCase(admin);
    const service = new ResolutionService(db, {
      getTransaction: async () => ({
        ...f.evidence,
        checkedAt: new Date().toISOString(),
      }),
    });
    const app = createApp(db, service, { demoEnabled: true });
    const token = randomBytes(32).toString("base64url");
    const headers = { authorization: `Bearer ${token}` };
    await admin.query(
      `INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests) VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes',20)`,
      [
        createHash("sha256").update(token).digest("hex"),
        f.actor.tenantId,
        f.actor.operatorId,
      ],
    );
    const route = `/api/v1/cases/${f.caseId}`;
    try {
      assert.equal((await app.inject({ url: route })).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: route,
            headers: { ...headers, origin: "https://untrusted.example" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await app.inject({ url: `/api/v1/cases/${other.caseId}`, headers }))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            url: route,
            headers: { ...headers, "x-tenant-id": other.actor.tenantId },
          })
        ).json().caseId,
        f.caseId,
      );
      const checked = await app.inject({
        method: "POST",
        url: `${route}/investigations`,
        headers,
      });
      assert.equal(checked.statusCode, 200);
      assert.equal(checked.json().verdict, "MATCH");
      const spoof = await app.inject({
        method: "POST",
        url: `${route}/decisions`,
        headers,
        payload: {
          kind: "APPROVED",
          caseVersion: 1,
          policyVersion: 1,
          operatorId: other.actor.operatorId,
        },
      });
      assert.equal(spoof.statusCode, 400);
      const approved = await app.inject({
        method: "POST",
        url: `${route}/decisions`,
        headers,
        payload: { kind: "APPROVED", caseVersion: 1, policyVersion: 1 },
      });
      assert.equal(approved.statusCode, 201);
      const repaired = await app.inject({
        method: "POST",
        url: `${route}/repairs`,
        headers,
        payload: {
          decisionId: approved.json().id,
          idempotencyKey: "http-proof-00001",
        },
      });
      assert.equal(repaired.statusCode, 200);
      assert.equal(repaired.json().status, "READBACK_CONFIRMED");
      const readback = await app.inject({ url: route, headers });
      assert.equal(readback.json().entitled, true);
      assert.equal(readback.json().payment.verdict, "MATCH");
      assert.equal(readback.json().repair.id, repaired.json().repairId);
      assert.deepEqual(readback.json().lessons, []);
      assert.equal(readback.headers["cache-control"], "no-store");
      await admin.query(
        "UPDATE morrow.demo_sessions SET used_requests=max_requests WHERE token_hash=$1",
        [createHash("sha256").update(token).digest("hex")],
      );
      assert.equal((await app.inject({ url: route, headers })).statusCode, 401);
      await admin.query(
        "UPDATE morrow.demo_sessions SET used_requests=0,expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
        [createHash("sha256").update(token).digest("hex")],
      );
      assert.equal((await app.inject({ url: route, headers })).statusCode, 401);
    } finally {
      await app.close();
      await db.end();
      await admin.end();
    }
  },
);

test(
  "unconfigured production sign-in and disabled demo remain closed",
  { skip: !url },
  async () => {
    const db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const service = new ResolutionService(db, {
      getTransaction: async () => {
        throw new Error("UNCONFIGURED");
      },
    });
    const app = createApp(db, service, { demoEnabled: false });
    try {
      assert.equal((await app.inject({ url: "/health" })).statusCode, 200);
      assert.equal(
        (
          await app.inject({
            url: "/api/v1/cases/00000000-0000-4000-8000-000000000001",
            headers: {
              authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
            },
          })
        ).statusCode,
        401,
      );
    } finally {
      await app.close();
      await db.end();
    }
  },
);

test(
  "reset revokes only the presented demo session",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const app = createApp(
      db,
      new ResolutionService(db, {
        getTransaction: async () => {
          throw new Error("UNUSED");
        },
      }),
      { demoEnabled: true },
    );
    const tokens = [
      randomBytes(32).toString("base64url"),
      randomBytes(32).toString("base64url"),
    ];
    try {
      for (const token of tokens)
        await admin.query(
          `INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests) VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes',20)`,
          [
            createHash("sha256").update(token).digest("hex"),
            f.actor.tenantId,
            f.actor.operatorId,
          ],
        );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/demo/reset",
            headers: { authorization: `Bearer ${tokens[0]}` },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/cases/${f.caseId}`,
            headers: { authorization: `Bearer ${tokens[0]}` },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/cases/${f.caseId}`,
            headers: { authorization: `Bearer ${tokens[1]}` },
          })
        ).statusCode,
        200,
        "a separate visitor session must remain usable",
      );
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
