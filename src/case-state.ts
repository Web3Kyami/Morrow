/** One read-only projection; mutation guards remain authoritative server-side. */
export type CaseFacts = {
  payment: {
    verdict: "MATCH" | "MISMATCH" | "UNKNOWN" | "NOT_CHECKED";
    checkedAt?: Date | string | null;
  };
  intentExpiresAt?: Date | string | null;
  decision: { kind: string; current: boolean } | null;
  policyEnabled: boolean;
  entitled: boolean;
  executed: boolean;
};
export function projectCase(
  f: CaseFacts,
  audience: "merchant" | "demo" | "customer",
  now = Date.now(),
) {
  const age = now - new Date(f.payment.checkedAt ?? 0).getTime();
  const fresh = Number.isFinite(age) && age >= -5000 && age < 60000;
  const matched = f.payment.verdict === "MATCH" && fresh;
  const approved =
    f.decision?.current === true && f.decision.kind === "APPROVED";
  const rejected =
    f.decision?.current === true &&
    ["REJECTED", "CANCELLED"].includes(f.decision.kind);
  const privileged = audience !== "customer";
  const display = f.entitled
    ? "ACCESS_PRESENT"
    : f.executed
      ? "READBACK_UNKNOWN"
      : !f.policyEnabled
        ? "POLICY_BLOCKED"
        : rejected
          ? "DECLINED"
          : f.payment.verdict === "MISMATCH"
            ? "REFUSED"
            : !matched
              ? "NEEDS_CHECK"
              : approved
                ? "APPROVED"
                : "NEEDS_REVIEW";
  return {
    display,
    payment: { ...f.payment, fresh },
    decision: f.decision,
    execution: f.executed ? "COMMITTED" : "NONE",
    access: f.entitled ? "CONFIRMED" : f.executed ? "UNKNOWN" : "MISSING",
    allowed: {
      checkPayment: true,
      review: privileged && !f.entitled && !f.executed,
      approve:
        privileged && matched && f.policyEnabled && !f.entitled && !f.executed,
      repair:
        privileged &&
        approved &&
        matched &&
        f.policyEnabled &&
        !f.entitled &&
        !f.executed,
      createLesson: privileged && f.entitled && f.executed,
    },
  };
}
