import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createPool,
  tenantTransaction,
  assertRuntimeRole,
} from "../../src/database.js";
import { ResolutionService } from "../../src/resolution.js";
import { seedCase } from "../fixtures.js";
import type { PaymentGateway } from "../../src/payment.js";

const url = process.env.TEST_DATABASE_URL;
test(
  "approved repair persists once and confirms through a fresh read",
  { skip: !url },
  async () => {
    const db = createPool(url!);
    const runtime = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    try {
      await assertRuntimeRole(runtime);
      const fixture = await seedCase(db);
      const gateway: PaymentGateway = {
        getTransaction: async () => fixture.evidence,
      };
      const service = new ResolutionService(runtime, gateway);
      const check = await service.investigate(fixture.actor, fixture.caseId);
      assert.equal(check.verdict, "MATCH");
      const decision = await service.decide(fixture.actor, {
        caseId: fixture.caseId,
        caseVersion: 1,
        policyVersion: 1,
        kind: "APPROVED",
      });
      const request = {
        caseId: fixture.caseId,
        decisionId: decision.id,
        idempotencyKey: randomUUID(),
      };
      const repaired = await service.repair(fixture.actor, request);
      assert.equal(repaired.status, "READBACK_CONFIRMED");
      assert.equal(
        (await service.repair(fixture.actor, request)).repairId,
        repaired.repairId,
      );
      const count = await tenantTransaction(db, fixture.actor.tenantId, (tx) =>
        tx.query(
          "SELECT count(*)::int AS n FROM morrow.entitlements WHERE tenant_id=$1 AND order_id=$2",
          [fixture.actor.tenantId, fixture.orderId],
        ),
      );
      assert.equal(count.rows[0].n, 1);
    } finally {
      await runtime.end();
      await db.end();
    }
  },
);
