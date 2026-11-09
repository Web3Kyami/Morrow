import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { createPool } from "../../src/database.js";
import { createApp } from "../../src/http.js";
import { ResolutionService } from "../../src/resolution.js";
import { InvestigationService } from "../../src/investigation.js";
import { DeterministicPlanner } from "../../src/agent.js";
import { seedCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;

test(
  "S6 recommendation persists and mismatch refuses",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    const f = await seedCase(admin);
    const service = new ResolutionService(db, {
      getTransaction: async () => ({
        ...f.evidence,
        checkedAt: new Date().toISOString(),
      }),
    });
    const investigation = new InvestigationService(
      db,
      service,
      new Map([["deterministic-v1", new DeterministicPlanner()]]),
      "deterministic-v1",
    );
    const app = createApp(
      db,
      service,
      { demoEnabled: true },
      undefined as never,
      undefined as never,
      investigation,
    );
    const token = randomBytes(32).toString("base64url");
    await admin.query(
      `INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests) VALUES ($1,$2,$3,clock_timestamp()+interval '5 minutes',20)`,
      [
        createHash("sha256").update(token).digest("hex"),
        f.actor.tenantId,
        f.actor.operatorId,
      ],
    );
    const headers = { authorization: `Bearer ${token}` };
    try {
      // No session → closed.
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/cases/${f.caseId}/recommendations`,
          })
        ).statusCode,
        401,
      );
      const rec = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${f.caseId}/recommendations`,
        headers,
        payload: {},
      });
      assert.equal(rec.statusCode, 200);
      const body = rec.json();
      assert.equal(body.action, "REQUEST_MERCHANT_REVIEW");
      assert.equal(body.planner, "deterministic-v1");
      assert.equal(body.check.verdict, "MATCH");

      // Persisted as a case event, read-only marked.
      const events = await admin.query(
        `SELECT data FROM morrow.case_events WHERE tenant_id=$1 AND case_id=$2 AND kind='AGENT_RECOMMENDATION'`,
        [f.actor.tenantId, f.caseId],
      );
      assert.equal(events.rowCount, 1);
      assert.equal(events.rows[0].data.readOnly, true);

      await admin.query(
        "UPDATE morrow.tenants SET grant_enabled=false WHERE id=$1",
        [f.actor.tenantId],
      );
      const denied = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${f.caseId}/recommendations`,
        headers,
        payload: {},
      });
      assert.equal(denied.statusCode, 200);
      assert.equal(
        denied.json().action,
        "REFUSE",
        "current policy blocks a repair proposal even when payment matches",
      );

      // OpenRouter adapter is absent without owner keys.
      const openRouter = await app.inject({
        method: "POST",
        url: `/api/v1/cases/${f.caseId}/recommendations`,
        headers,
        payload: { planner: "openrouter" },
      });
      assert.equal(openRouter.statusCode, 503);
      assert.equal(openRouter.json().error, "AGENT_UNAVAILABLE");
    } finally {
      await app.close();
      await admin.end();
      await db.end();
    }
  },
);
