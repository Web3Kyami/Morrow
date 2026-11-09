import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "../../src/database.js";
import {
  DemoProvisioningService,
  type ReservedIntent,
} from "../../src/demo-provisioning.js";
import { DemoJourneyService } from "../../src/demo-journey.js";
import {
  DemoPaymentWorker,
  type DemoChain,
} from "../../src/demo-payment-worker.js";
import { DemoLessonWorker } from "../../src/demo-lesson-worker.js";
import { ResolutionService } from "../../src/resolution.js";
import { InvestigationService } from "../../src/investigation.js";
import { FairComparisonService } from "../../src/fair.js";
import { DeterministicPlanner, type AgentPlanner } from "../../src/agent.js";
import type { ScopedMemory } from "../../src/lesson-factory.js";
test("isolated A requires explicit repair and lesson approvals; editable drafts, durable storage and fresh recall unlock B", async () => {
  const admin = createPool(process.env.TEST_DATABASE_URL!),
    db = createPool(process.env.TEST_RUNTIME_DATABASE_URL!);
  const provisioning = new DemoProvisioningService(db, undefined, {
      deferPayments: true,
    }),
    key = crypto.randomUUID(),
    run = await provisioning.provision(key),
    actor = {
      tenantId: run.tenantId,
      operatorId: run.operatorId,
      role: "judge" as const,
    };
  const sent = new Set<string>();
  const suffix = crypto.randomUUID();
  let pending = true,
    stored = "",
    freshClients = 0;
  const chain: DemoChain = {
    prepare: async (): Promise<ReservedIntent> => ({
      digest: crypto.randomUUID().replaceAll("-", "").replaceAll("0", "1"),
      transactionBytes: "dGVzdA==",
      amount: "1000000",
      gasBudget: "2000000",
      gasRefs: [crypto.randomUUID()],
      sender: "0x" + "1".repeat(64),
      recipient: "0x" + "2".repeat(64),
    }),
    observe: async (d) => (sent.has(d) ? "SUCCESS" : "ABSENT"),
    submit: async (i) => {
      sent.add(i.digest);
    },
  };
  const resolution = new ResolutionService(db, {
    getTransaction: async (digest) => {
      if (!sent.has(digest)) throw Error("ABSENT");
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
  const scope = (tenantId: string): ScopedMemory => {
    assert.equal(tenantId, run.tenantId);
    freshClients++;
    return {
      tenantConfig: {
        network: "testnet",
        accountId: "0x" + "1".repeat(64),
        key: "test-only",
        namespace: `morrow-testnet:${tenantId}`,
      },
      gateway: {
        remember: async (text) => {
          stored = text;
          return { jobId: "job-" + suffix };
        },
        status: async () =>
          pending
            ? { job_id: "job-" + suffix, status: "pending" }
            : {
                job_id: "job-" + suffix,
                status: "done",
                blob_id: "blob-" + suffix,
              },
        recall: async () => [{ blobId: "blob-" + suffix, text: stored }],
        close: () => {},
      },
      close: () => {},
    };
  };
  const investigation = new InvestigationService(
    db,
    resolution,
    new Map([["fixture", new DeterministicPlanner()]]),
    "fixture",
  );
  const contexts: Array<Parameters<AgentPlanner["investigate"]>[0]> = [];
  const fair = new FairComparisonService(db, resolution, scope, {
    name: "fixture",
    planner: {
      investigate: async (context) => {
        contexts.push(structuredClone(context));
        return new DeterministicPlanner().investigate(context);
      },
    },
  });
  const journey = new DemoJourneyService(
      db,
      resolution,
      provisioning,
      investigation,
      scope,
      fair,
    ),
    payments = new DemoPaymentWorker(db, chain, resolution);
  try {
    await assert.rejects(() => journey.openDraft(actor, key), {
      code: "REPAIR_NOT_CONFIRMED",
    });
    await assert.rejects(() => journey.startB(actor, key), {
      code: "CASE_A_REQUIRED",
    });
    await assert.rejects(() => journey.startC(actor, key), {
      code: "CASE_B_REQUIRED",
    });
    assert.equal(await payments.runOne(run.caseId), "CONFIRMED");
    let state = await journey.propose(actor, key);
    assert.equal(state.stage, "REVIEW_READY");
    await journey.propose(actor, key);
    const events = await admin.query(
      "SELECT 1 FROM morrow.case_events WHERE tenant_id=$1 AND kind='AGENT_RECOMMENDATION'",
      [run.tenantId],
    );
    assert.equal(
      events.rowCount,
      1,
      "lost response reuses persisted inference",
    );
    const decision = await journey.decide(actor, key, {
      kind: "APPROVED",
      caseVersion: state.caseA.caseVersion,
      policyVersion: state.caseA.policyVersion,
    });
    assert.equal(
      (await journey.view(actor, key)).caseA.summary.access,
      "MISSING",
    );
    await assert.rejects(() => journey.openDraft(actor, key), {
      code: "REPAIR_NOT_CONFIRMED",
    });
    assert.equal(
      (await journey.repair(actor, key, decision.id)).status,
      "READBACK_CONFIRMED",
    );
    const draft = await journey.openDraft(actor, key);
    const saved = await journey.saveDraft(actor, key, {
      version: draft.version,
      procedure: draft.payload.procedure.filter(
        (s: string) => s !== "ESCALATE_UNKNOWN",
      ),
      applicableCategories: ["course", "download"],
    });
    await assert.rejects(
      () => journey.approveLesson(actor, key, draft.version),
      { code: "STALE_DRAFT" },
    );
    assert.equal(
      (
        await admin.query("SELECT 1 FROM morrow.lessons WHERE tenant_id=$1", [
          run.tenantId,
        ])
      ).rowCount,
      0,
      "saving is not approval",
    );
    const approved = await journey.approveLesson(actor, key, saved.version);
    assert.equal(
      (await journey.approveLesson(actor, key, saved.version)).id,
      approved.id,
    );
    await assert.rejects(
      () =>
        journey.saveDraft(actor, key, {
          version: saved.version,
          procedure: saved.payload.procedure,
          applicableCategories: ["course"],
        }),
      { code: "STALE_DRAFT" },
    );
    const memory = new DemoLessonWorker(db, scope);
    assert.equal(await memory.runOne(approved.id), "PENDING");
    assert.notEqual((await journey.view(actor, key)).stage, "A_COMPLETE");
    pending = false;
    await admin.query(
      "UPDATE morrow.demo_lesson_jobs SET not_before=clock_timestamp() WHERE tenant_id=$1",
      [run.tenantId],
    );
    assert.equal(await memory.runOne(approved.id), "RECALL_VERIFIED");
    assert.ok(freshClients >= 2);
    assert.equal(stored.includes("Mira"), false);
    assert.equal(stored.includes("example.test"), false);
    state = await journey.view(actor, key);
    assert.equal(state.stage, "A_COMPLETE");
    assert.equal(state.caseA.summary.access, "CONFIRMED");
    await journey.startB(actor, key);
    assert.equal(await payments.runOne(run.caseBId), "CONFIRMED");
    await assert.rejects(() => journey.compare(actor, key, "ON"), {
      code: "BASELINE_REQUIRED",
    });
    await journey.compare(actor, key, "OFF");
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]!.lessons.length, 0, "OFF has no lesson");
    const resumed = new FairComparisonService(db, resolution, scope, {
      name: "fixture",
      planner: {
        investigate: async (context) => {
          contexts.push(structuredClone(context));
          return new DeterministicPlanner().investigate(context);
        },
      },
    });
    await resumed.start(actor, run.caseId, run.caseBId);
    assert.equal(
      contexts.length,
      1,
      "lost OFF response/process restart reuses baseline",
    );
    const finished = await resumed.finish(actor, run.caseId, run.caseBId);
    assert.equal(contexts.length, 2);
    assert.deepEqual(
      contexts[0]!.evidence,
      contexts[1]!.evidence,
      "same frozen payment observation",
    );
    assert.equal(
      contexts[1]!.lessons.length,
      1,
      "explicitly approved course/download scope admits A lesson for B download",
    );
    assert.equal(finished.result.comparison.onLessons, 1);
    assert.equal(finished.result.comparison.readOnly, true);
    await resumed.finish(actor, run.caseId, run.caseBId);
    assert.equal(
      contexts.length,
      2,
      "lost ON response does not invoke model twice",
    );
    const changedModel = new FairComparisonService(db, resolution, scope, {
      name: "different",
      planner: new DeterministicPlanner(),
    });
    await assert.rejects(
      () => changedModel.finish(actor, run.caseId, run.caseBId),
      { code: "COMPARISON_MODEL_CHANGED" },
    );
    await journey.startC(actor, key);
    assert.equal(await payments.runOne(run.caseCId), "MISMATCH");
    const refused = await journey.view(actor, key);
    assert.equal(refused.caseC.summary.payment.verdict, "MISMATCH");
    assert.equal(refused.caseC.access, "MISSING");
    assert.equal(refused.caseC.repairs.length, 0);
    await assert.rejects(
      () =>
        resolution.decide(actor, {
          caseId: run.caseCId,
          kind: "APPROVED",
          caseVersion: 1,
          policyVersion: 1,
        }),
      { code: "CASE_REFUSED" },
    );
    await assert.rejects(
      () =>
        resolution.repair(actor, {
          caseId: run.caseCId,
          decisionId: crypto.randomUUID(),
          idempotencyKey: "case-c-refusal-0001",
        }),
      { code: "CASE_REFUSED" },
    );
    const proof = await journey.proof(actor, key);
    assert.equal(proof.c.status, "PASS");
    assert.equal(proof.c.payment.successfulTransaction, true);
    assert.equal(proof.c.payment.expectedAmountMist, "1000001");
    assert.equal(proof.c.payment.observedAmountMist, "1000000");
    assert.equal(proof.mainnet.status, "DEFERRED");
    const grants = await admin.query(
      "SELECT 1 FROM morrow.entitlements WHERE tenant_id=$1",
      [run.tenantId],
    );
    assert.equal(grants.rowCount, 1);
    await assert.rejects(
      () => journey.view({ ...actor, tenantId: crypto.randomUUID() }, key),
      { code: "CASE_NOT_FOUND" },
    );
  } finally {
    await admin.end();
    await db.end();
  }
});
