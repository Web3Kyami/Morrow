(() => {
  const { api, el, friendlyError, motion } = window.Morrow;
  const caseId = location.pathname.split("/").pop();
  let pending = false,
    loaded = false;
  function step(id, state, text) {
    el(id + "-step").dataset.state = state;
    el(id + "-detail").textContent = text;
  }
  async function load() {
    if (pending) return;
    pending = true;
    el("error-notice").hidden = true;
    el("loading").hidden = loaded;
    for (const id of ["refresh", "retry-status"]) {
      el(id).disabled = true;
      el(id).setAttribute("aria-busy", "true");
    }
    try {
      let token;
      try {
        token = localStorage.getItem("morrow-case-" + caseId);
      } catch {}
      if (!token) throw Object.assign(new Error("NO_ACCESS"), { status: 403 });
      const data = await api("/api/v1/help-cases/" + caseId, {
          headers: { authorization: "Bearer " + token },
        }),
        verdict = data.payment.verdict;
      el("status-title").textContent = data.access.entitled
        ? "Access confirmed."
        : verdict === "MISMATCH"
          ? "Payment needs review."
          : "Your case is open.";
      el("status-sub").textContent = "Case #" + caseId.slice(-6);
      el("case-state").textContent = data.access.entitled
        ? "Access confirmed"
        : verdict === "UNKNOWN"
          ? "Payment unavailable"
          : verdict === "MISMATCH"
            ? "Payment mismatch"
            : data.decision?.kind === "APPROVED" && data.decision.current
              ? "Repair not confirmed"
              : verdict === "MATCH"
                ? "Awaiting merchant review"
                : "Payment not checked";
      el("case-state").className =
        "chip " +
        (data.access.entitled ? "ok" : verdict === "MISMATCH" ? "bad" : "warn");
      el("case-state").hidden = false;
      step("order", "confirmed", "Order ownership confirmed");
      step(
        "payment",
        verdict === "MATCH"
          ? "confirmed"
          : verdict === "MISMATCH"
            ? "refused"
            : "pending",
        verdict === "MATCH"
          ? "Payment matches this order"
          : verdict === "MISMATCH"
            ? "Payment does not match this order"
            : verdict === "UNKNOWN"
              ? "Verification unavailable"
              : "Not checked yet",
      );
      if (data.repair)
        step("merchant", "confirmed", "Approved. Repair recorded");
      else if (data.access.entitled)
        step("merchant", "confirmed", "No repair needed");
      else if (data.decision && !data.decision.current)
        step("merchant", "pending", "New review required");
      else if (data.decision?.kind === "APPROVED")
        step("merchant", "approved", "Approved. Repair not confirmed");
      else if (data.decision?.kind === "REJECTED")
        step("merchant", "refused", "Repair declined");
      else step("merchant", "pending", "Not authorized yet");
      step(
        "access",
        data.access.entitled ? "confirmed" : "pending",
        data.access.entitled
          ? "Access readback confirmed"
          : "No confirmed readback",
      );
      el("main").dataset.state = "ready";
      el("status").hidden = false;
      if (!loaded) motion(el("status"), [{ opacity: 0 }, { opacity: 1 }], 160);
      loaded = true;
    } catch (error) {
      el("main").dataset.state = "error";
      el("status-error").textContent =
        error.status === 403 || error.status === 404
          ? "Reopen the case using your order reference and receipt email."
          : friendlyError(error, "Status couldn't be refreshed. Try again.");
      el("error-notice").hidden = false;
    } finally {
      pending = false;
      el("loading").hidden = true;
      for (const id of ["refresh", "retry-status"]) {
        el(id).disabled = false;
        el(id).removeAttribute("aria-busy");
      }
    }
  }
  el("refresh").onclick = load;
  el("retry-status").onclick = load;
  load();
})();
