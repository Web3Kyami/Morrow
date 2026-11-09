import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMemoryJob,
  verifyMainnetRegister,
  describeLesson,
  type Lesson,
} from "../src/memory.js";

test("accepted and uploaded jobs never count as stored memories", () => {
  assert.equal(
    classifyMemoryJob({ job_id: "job1", status: "running" }).state,
    "PENDING",
  );
  assert.equal(
    classifyMemoryJob({ job_id: "job1", status: "uploaded", blob_id: "blob1" })
      .state,
    "PENDING",
  );
  assert.equal(
    classifyMemoryJob({ job_id: "job1", status: "done" }).state,
    "UNKNOWN",
  );
  assert.equal(
    classifyMemoryJob({ job_id: "job1", status: "done", blob_id: "blob1" })
      .state,
    "COMPLETED",
  );
});
test("ten local or Testnet entries are insufficient for Mainnet proof", () => {
  assert.equal(verifyMainnetRegister([]).status, "BLOCKED");
  const rows = Array.from({ length: 10 }, (_, i) => ({
    network: "testnet",
    fingerprint: String(i),
    blobId: String(i),
    jobId: String(i),
    freshRecall: true,
    approved: true,
    completedAt: new Date().toISOString(),
  }));
  assert.equal(verifyMainnetRegister(rows).status, "BLOCKED");
  assert.equal(
    verifyMainnetRegister(
      rows.map((r) => ({ ...r, network: "mainnet", blobId: "same-blob" })),
    ).status,
    "BLOCKED",
  );
});

test("Mainnet proof requires ten independently distinct rows, not independent column counts", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    network: "mainnet",
    fingerprint: String(i),
    blobId: "shared",
    jobId: String(i),
    freshRecall: true,
    approved: true,
    completedAt: new Date().toISOString(),
  }));
  rows.push(
    ...rows.map((r, i) => ({
      ...r,
      fingerprint: "shared",
      blobId: String(i),
      jobId: `extra${i}`,
    })),
  );
  assert.equal(verifyMainnetRegister(rows).status, "BLOCKED");
});

test("a different source case alone does not make a distinct operational memory", () => {
  const lesson: Lesson = {
    sourceCaseId: "00000000-0000-4000-8000-000000000001",
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
  const first = describeLesson(lesson),
    second = describeLesson({
      ...lesson,
      sourceCaseId: "00000000-0000-4000-8000-000000000002",
    });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.notEqual(first.contentHash, second.contentHash);
});
