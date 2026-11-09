import assert from "node:assert/strict";
import test from "node:test";
import { createPool, tenantTransaction } from "../../src/database.js";
import { ResolutionService } from "../../src/resolution.js";
import { LessonService } from "../../src/lessons.js";
import type { Lesson, MemoryGateway } from "../../src/memory.js";
import { seedCase } from "../fixtures.js";

const url = process.env.TEST_DATABASE_URL;
test(
  "approved sanitized lesson retains accepted/pending/completed/fresh-recall distinctions",
  { skip: !url },
  async () => {
    const admin = createPool(url!),
      db = createPool(process.env.TEST_RUNTIME_DATABASE_URL ?? url!);
    try {
      const f = await seedCase(admin);
      const jobId = `fake_job_${f.caseId}`,
        blobId = `fake_blob_${f.caseId}`;
      let status: unknown = { job_id: jobId, status: "running" },
        text = "";
      const gateway: MemoryGateway = {
        remember: async (value) => {
          text = value;
          return { jobId };
        },
        status: async () => status,
        recall: async () => [{ blobId, text }],
        close() {},
      };
      const config = {
        network: "testnet" as const,
        namespace: `morrow-test:${f.actor.tenantId}`,
        accountId: `0x${"3".repeat(64)}`,
        key: "test-only",
      };
      const lessons = new LessonService(db, config, gateway);
      const lesson: Lesson = {
        sourceCaseId: f.caseId,
        policyVersion: 1,
        productCategory: "course",
        problem: "PAID_ACCESS_MISSING",
        procedure: [
          "VERIFY_PAYMENT_INTENT",
          "CHECK_PERSISTED_ACCESS",
          "REQUEST_MERCHANT_APPROVAL",
          "GRANT_IDEMPOTENTLY",
          "CONFIRM_READBACK",
        ],
        outcome: "READBACK_CONFIRMED",
        fictional: true,
      };
      await assert.rejects(lessons.approve(f.actor, lesson), {
        code: "REPAIR_NOT_CONFIRMED",
      });
      const service = new ResolutionService(db, {
        getTransaction: async () => ({
          ...f.evidence,
          checkedAt: new Date().toISOString(),
        }),
      });
      await service.investigate(f.actor, f.caseId);
      const decision = await service.decide(f.actor, {
        caseId: f.caseId,
        caseVersion: 1,
        policyVersion: 1,
        kind: "APPROVED",
      });
      await service.repair(f.actor, {
        caseId: f.caseId,
        decisionId: decision.id,
        idempotencyKey: "lesson-proof-0001",
      });
      const approved = await lessons.approve(f.actor, lesson);
      assert.equal(
        (await lessons.advance(f.actor.tenantId, approved.id)).state,
        "PENDING",
      );
      await assert.rejects(
        lessons.verifyRecall(f.actor.tenantId, approved.id, gateway),
        { code: "MEMORY_NOT_COMPLETED" },
      );
      status = { job_id: jobId, status: "uploaded", blob_id: blobId };
      assert.equal(
        (await lessons.advance(f.actor.tenantId, approved.id)).state,
        "PENDING",
      );
      status = { job_id: jobId, status: "done", blob_id: blobId };
      assert.equal(
        (await lessons.advance(f.actor.tenantId, approved.id)).state,
        "COMPLETED",
      );
      const wrongRecall = {
        ...gateway,
        recall: async () => [{ blobId: "wrong_blob", text }],
      };
      await assert.rejects(
        lessons.verifyRecall(f.actor.tenantId, approved.id, wrongRecall),
        { code: "FRESH_RECALL_NOT_CONFIRMED" },
      );
      assert.equal(
        (await lessons.verifyRecall(f.actor.tenantId, approved.id, gateway))
          .state,
        "RECALL_VERIFIED",
      );
      assert.equal(text.includes(f.evidence.sender!), false);
      await assert.rejects(
        lessons.approve(f.actor, {
          ...lesson,
          procedure: ["customer@example.com"] as never,
        }),
        /Invalid/,
      );
      const row = await tenantTransaction(admin, f.actor.tenantId, (tx) =>
        tx.query(
          "SELECT state,job_id,blob_id,recalled_at FROM morrow.lessons WHERE tenant_id=$1 AND id=$2",
          [f.actor.tenantId, approved.id],
        ),
      );
      assert.equal(row.rows[0].state, "RECALL_VERIFIED");
      assert.ok(row.rows[0].recalled_at);
    } finally {
      await db.end();
      await admin.end();
    }
  },
);
