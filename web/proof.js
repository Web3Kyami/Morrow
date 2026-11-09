(() => {
  const { api, el, busy, friendlyError } = window.Morrow;
  let credential = null;
  try {
    credential = JSON.parse(sessionStorage.getItem("morrow-journey") || "null");
  } catch {}
  const active =
    typeof credential?.token === "string" &&
    typeof credential?.key === "string";

  function status(id, text, tone) {
    const node = el(id);
    node.textContent = text;
    node.className = `proof-status ${tone}`;
  }
  const paymentText = (payment) => {
    if (!payment || payment.verdict === "NOT_CHECKED")
      return "Payment has not been verified.";
    if (payment.verdict === "UNKNOWN")
      return "The provider did not return a confirmed result.";
    return payment.verdict === "MATCH"
      ? "Payment matches the order."
      : "Payment does not match the order.";
  };

  function render(data) {
    const aPass = data.a.status === "PASS";
    el("proof-a-detail").textContent = aPass
      ? `${paymentText(data.a.payment)} Repair executed; access read back as ${data.a.entitlement.after.toLowerCase()}.`
      : `${paymentText(data.a.payment)} A repair and confirmed access readback are both required.`;
    status(
      "proof-a-state",
      aPass ? "Verified · Sui Testnet" : "Unverified",
      aPass ? "ok" : "warn",
    );

    const lesson = data.a.lesson;
    const remembered = lesson?.state === "RECALL_VERIFIED" && !!lesson.blobId;
    el("proof-memory-detail").textContent = remembered
      ? `Sanitized lesson stored on Walrus ${lesson.network}; fresh-session recall verified.`
      : lesson
        ? `Lesson state: ${lesson.state}. A recorded blob and fresh-session recall are required.`
        : "No approved lesson is recorded for this run.";
    status(
      "proof-memory-state",
      remembered ? "Fresh recall verified · Testnet" : "Not verified",
      remembered ? "ok" : "warn",
    );

    const outcome = data.b.outcome;
    const bDetail =
      {
        GUIDANCE_DIFFERENCE:
          "The recalled lesson changed the guidance. This does not prove a faster or better outcome.",
        EQUAL: "Both arms reached the same guidance. No benefit was measured.",
        INCONCLUSIVE:
          "The comparison could not verify a fair, complete result.",
      }[outcome] || "The Case B comparison has not run.";
    el("proof-b-detail").textContent = bDetail;
    status(
      "proof-b-state",
      outcome === "GUIDANCE_DIFFERENCE"
        ? "Guidance differed"
        : outcome === "EQUAL"
          ? "Equal guidance"
          : "Inconclusive",
      outcome === "INCONCLUSIVE" || outcome === "NOT_RUN" ? "warn" : "info",
    );

    const cPass = data.c.status === "PASS";
    const amounts =
      data.c.payment.observedAmountMist && data.c.payment.expectedAmountMist
        ? `Observed ${data.c.payment.observedAmountMist} MIST; expected ${data.c.payment.expectedAmountMist} MIST. `
        : "";
    el("proof-c-detail").textContent = cPass
      ? `${amounts}No entitlement or repair was recorded. No refund was initiated.`
      : data.c.status === "UNVERIFIED"
        ? "A successful mismatched transaction has not been independently confirmed yet. No repair is permitted."
        : "Safe refusal failed its evidence check. Do not treat Case C as passed.";
    status(
      "proof-c-state",
      cPass
        ? "Mismatch refused · no grant"
        : data.c.status === "UNVERIFIED"
          ? "Unverified"
          : "Failed",
      cPass ? "ok" : data.c.status === "UNVERIFIED" ? "warn" : "bad",
    );

    const mainnet = data.mainnet;
    el("mainnet-deferred").textContent =
      `Mainnet remains deferred · ${mainnet.memories} of ${mainnet.required} distinct stored and retrievable memories.`;
    el("proof-loading").hidden = true;
    el("proof-empty").hidden = true;
    el("proof-content").hidden = false;
    el("proof-error").hidden = true;
    el("retry-proof").hidden = true;
    el("main").dataset.state = "ready";
  }

  async function load() {
    if (!active) {
      el("proof-loading").hidden = true;
      el("proof-content").hidden = true;
      el("proof-empty").hidden = false;
      el("proof-actions").hidden = true;
      el("main").dataset.state = "empty";
      return;
    }
    el("proof-error").hidden = true;
    el("retry-proof").hidden = true;
    el("proof-content").hidden = true;
    el("proof-empty").hidden = true;
    el("proof-loading").hidden = false;
    try {
      const data = await api("/api/v1/demo/proof", {
        headers: {
          authorization: `Bearer ${credential.token}`,
          "idempotency-key": credential.key,
        },
      });
      render(data);
    } catch (error) {
      el("proof-loading").hidden = true;
      el("proof-error").hidden = false;
      el("proof-error").textContent = friendlyError(
        error,
        "Proof is unavailable. Try again.",
      );
      el("retry-proof").hidden = false;
      el("main").dataset.state = "error";
      if (error.status === 401 || error.status === 410) {
        el("proof-error").textContent =
          "This demo session expired. Start a new demo to create fresh proof.";
      }
    }
  }

  async function reset() {
    if (!active) {
      location.href = "/";
      return;
    }
    try {
      await api("/api/v1/demo/reset", {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "idempotency-key": credential.key,
        },
      });
    } catch (error) {
      if (error.status !== 401 && error.status !== 410) {
        el("proof-error").hidden = false;
        el("proof-error").textContent = friendlyError(
          error,
          "The demo session could not be reset. Try again.",
        );
        return;
      }
    }
    sessionStorage.removeItem("morrow-journey");
    location.href = "/";
  }

  el("retry-proof").addEventListener("click", () =>
    busy(el("retry-proof"), load),
  );
  el("reset-demo").addEventListener("click", () =>
    busy(el("reset-demo"), reset),
  );
  el("exit-demo").addEventListener("click", () => busy(el("exit-demo"), reset));
  load();
})();
