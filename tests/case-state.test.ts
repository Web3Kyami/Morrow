import assert from "node:assert/strict";
import test from "node:test";
import { projectCase, type CaseFacts } from "../src/case-state.js";
const now = Date.parse("2026-11-08T12:00:00Z");
const facts: CaseFacts = {
  payment: { verdict: "MATCH", checkedAt: new Date(now).toISOString() },
  intentExpiresAt: new Date(now + 60000).toISOString(),
  decision: null,
  policyEnabled: true,
  entitled: false,
  executed: false,
};
test("approval is separate from execution and a stale check cannot authorize repair", () => {
  assert.equal(projectCase(facts, "merchant", now).display, "NEEDS_REVIEW");
  const approved = {
    ...facts,
    decision: { kind: "APPROVED", current: true } as const,
  };
  assert.equal(projectCase(approved, "merchant", now).display, "APPROVED");
  assert.equal(projectCase(approved, "merchant", now).access, "MISSING");
  assert.equal(projectCase(approved, "merchant", now).allowed.repair, true);
  assert.equal(
    projectCase(approved, "merchant", now + 61000).allowed.repair,
    false,
  );
});
test("readback and policy dominate proposals; customer never gets merchant actions", () => {
  assert.equal(
    projectCase({ ...facts, executed: true }, "merchant", now).display,
    "READBACK_UNKNOWN",
  );
  assert.equal(
    projectCase({ ...facts, executed: true, entitled: true }, "merchant", now)
      .display,
    "ACCESS_PRESENT",
  );
  assert.equal(
    projectCase({ ...facts, policyEnabled: false }, "merchant", now).allowed
      .approve,
    false,
  );
  assert.equal(projectCase(facts, "customer", now).allowed.approve, false);
  assert.equal(
    projectCase(
      { ...facts, decision: { kind: "REJECTED", current: true } },
      "merchant",
      now,
    ).display,
    "DECLINED",
  );
  assert.equal(
    projectCase(
      {
        ...facts,
        payment: {
          verdict: "MISMATCH",
          checkedAt: new Date(now).toISOString(),
        },
      },
      "merchant",
      now,
    ).allowed.repair,
    false,
  );
});

test("a transaction paid inside its intent window remains eligible after that window closes", () => {
  assert.equal(
    projectCase(
      { ...facts, intentExpiresAt: new Date(now - 1000).toISOString() },
      "merchant",
      now,
    ).allowed.approve,
    true,
  );
});
