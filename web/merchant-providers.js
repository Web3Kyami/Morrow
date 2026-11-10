(() => {
  const { api, el, busy, friendlyError, signOut } = window.Morrow;
  let run = 0;
  const badge = (id, text, tone) => {
    const node = el(id);
    node.textContent = text;
    node.className = `merchant-status ${tone}`;
  };
  function render(data) {
    const tatum = data.tatum;
    if (tatum.state === "CONNECTED") {
      badge("tatum-state", "Reachable · Testnet", "ok");
      el("tatum-detail").textContent =
        "Read-only Sui service check passed. Each payment still needs fresh transaction evidence bound to its exact order.";
    } else if (tatum.state === "NOT_CONFIGURED") {
      badge("tatum-state", "Not configured", "warn");
      el("tatum-detail").textContent =
        "Payment verification cannot run until the provider is configured. No payment can be approved from a missing check.";
    } else {
      badge("tatum-state", "Unavailable", "bad");
      el("tatum-detail").textContent =
        "Payment verification may be UNKNOWN. Retry the check or escalate; never treat provider downtime as a mismatch.";
    }
    el("tatum-evidence").textContent = tatum.chainId
      ? "Read-only status check. No payment was requested."
      : "No transaction was requested by this status check.";

    if (data.database.state === "CONNECTED") {
      badge("database-state", "Database reachable", "ok");
    } else {
      badge("database-state", "Unavailable", "bad");
    }

    const walrus = data.walrus;
    el("walrus-network").textContent =
      walrus.network === "testnet"
        ? "Testnet"
        : walrus.network === "mainnet"
          ? "Mainnet"
          : "";
    if (walrus.state === "NOT_CONFIGURED") {
      badge("walrus-state", "Not configured", "warn");
      el("walrus-detail").textContent =
        "Memory storage and recall are unavailable until Walrus Testnet is configured.";
    } else if (walrus.state === "DEFERRED") {
      badge("walrus-state", "Mainnet deferred", "warn");
      el("walrus-detail").textContent =
        "This build uses Walrus Testnet. Mainnet storage and the ten-memory gate remain deferred.";
    } else {
      badge("walrus-state", "Configured · Testnet", "info");
      const latest = walrus.latestLesson;
      const status = latest?.state;
      if (!latest)
        el("walrus-detail").textContent =
          "No lesson writes are recorded for this workspace.";
      else if (status === "ACCEPTED" || status === "PENDING")
        el("walrus-detail").textContent =
          "The latest write was accepted and is waiting for provider completion. It is not stored yet.";
      else if (status === "COMPLETED" && latest.blobPresent)
        el("walrus-detail").textContent =
          "The latest write completed and a blob ID is recorded. Fresh-session recall is still required.";
      else if (status === "RECALL_VERIFIED" && latest.blobPresent)
        el("walrus-detail").textContent =
          "The latest lesson has a recorded blob and a successful fresh-session recall.";
      else if (status === "FAILED")
        el("walrus-detail").textContent =
          "The latest write failed. No stored-memory claim is available.";
      else if (status === "UNKNOWN")
        el("walrus-detail").textContent =
          "The latest write status is unknown. Reconcile it before starting another write.";
      else
        el("walrus-detail").textContent =
          "A lesson is approved, but no completed storage proof is recorded.";
    }
    const latest = walrus.latestLesson;
    el("walrus-evidence").textContent = latest?.recalledAt
      ? `Fresh recall verified ${new Date(latest.recalledAt).toLocaleString()}.`
      : latest?.completedAt
        ? `Completed ${new Date(latest.completedAt).toLocaleString()}; no fresh recall is recorded.`
        : "No live Walrus probe was run. Status above comes from configuration and persisted lesson evidence.";
    el("provider-checked").textContent =
      `Read-only status checked ${new Date(data.checkedAt).toLocaleString()}.`;
    el("provider-checked").hidden = false;
  }

  async function load() {
    const current = ++run;
    el("provider-content").hidden = true;
    el("provider-error").hidden = true;
    el("provider-checked").hidden = true;
    el("provider-loading").hidden = false;
    try {
      const data = await api("/api/v1/merchant/providers");
      if (current !== run) return;
      render(data);
      el("provider-loading").hidden = true;
      el("provider-content").hidden = false;
      el("main").dataset.state = "ready";
    } catch (error) {
      if (current !== run) return;
      el("provider-loading").hidden = true;
      el("provider-error").hidden = false;
      el("provider-error-text").textContent = friendlyError(
        error,
        "Provider status is unavailable. Retry when the service is reachable.",
      );
      el("main").dataset.state = "error";
      if (error.status === 401) location.href = "/merchant/login";
    }
  }

  el("retry-providers").addEventListener("click", () =>
    busy(el("retry-providers"), load),
  );
  el("retry-provider-error").addEventListener("click", () =>
    busy(el("retry-provider-error"), load),
  );
  el("sign-out").addEventListener("click", () => signOut(el("sign-out")));
  load();
})();
