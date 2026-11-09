import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicPlanner } from "../src/agent.js";

const CASE = "00000000-0000-4000-8000-000000000001";
const CHECK = "00000000-0000-4000-8000-000000000002";

function run(evidence: Array<{ id: string; kind: string; facts: unknown }>) {
  return new DeterministicPlanner().investigate({
    caseId: CASE,
    policyVersion: 2,
    evidence,
    lessons: [],
  });
}

test("S6 planner escalates when no payment check has run", async () => {
  const rec = await run([]);
  assert.equal(rec.action, "ESCALATE");
  assert.match(rec.reason, /no payment check/i);
});

test("S6 planner refuses when the payment mismatches", async () => {
  const rec = await run([
    {
      id: CHECK,
      kind: "payment_check",
      facts: { verdict: "MISMATCH", entitled: false },
    },
  ]);
  assert.equal(rec.action, "REFUSE");
  assert.deepEqual(rec.evidenceIds, [CHECK]);
});

test("S6 planner requests merchant review when payment matches and access is missing", async () => {
  const rec = await run([
    {
      id: CHECK,
      kind: "payment_check",
      facts: { verdict: "MATCH", entitled: false },
    },
  ]);
  assert.equal(rec.action, "REQUEST_MERCHANT_REVIEW");
  assert.deepEqual(rec.evidenceIds, [CHECK]);
  assert.match(rec.reason, /merchant/);
});

test("S6 planner refuses a repair when access is already restored", async () => {
  const rec = await run([
    {
      id: CHECK,
      kind: "payment_check",
      facts: { verdict: "MATCH", entitled: true },
    },
  ]);
  assert.equal(rec.action, "REFUSE");
  assert.match(rec.reason, /already/i);
});

test("S6 planner escalates on unknown provider state", async () => {
  const rec = await run([
    {
      id: CHECK,
      kind: "payment_check",
      facts: { verdict: "UNKNOWN", entitled: false },
    },
  ]);
  assert.equal(rec.action, "ESCALATE");
});

test("S6 recalled lessons never change the verdict", async () => {
  const rec = await new DeterministicPlanner().investigate({
    caseId: CASE,
    policyVersion: 2,
    evidence: [
      {
        id: CHECK,
        kind: "payment_check",
        facts: { verdict: "MISMATCH", entitled: false },
      },
    ],
    lessons: [
      {
        blobId: "blob-1",
        procedure: [
          "VERIFY_PAYMENT_INTENT",
          "REQUEST_MERCHANT_APPROVAL",
          "GRANT_IDEMPOTENTLY",
          "CONFIRM_READBACK",
        ],
      },
    ],
  });
  assert.equal(
    rec.action,
    "REFUSE",
    "a recalled lesson cannot turn a mismatch into a review",
  );
});
