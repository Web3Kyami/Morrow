/* The run is server-owned. Browser state contains only a scoped capability. */
(() => {
  const { api, el, openDialog, closeDialog, setupDialog, busy, setFieldError } =
    window.Morrow;
  const dialogs = [el("review-dialog"), el("lesson-dialog"), el("how-dialog")];
  dialogs.forEach(setupDialog);
  let credential = null,
    view = null,
    draft = null,
    chapter = "A",
    working = false,
    timer = null,
    sequence = 0,
    proposalAttempted = false;
  try {
    credential = JSON.parse(sessionStorage.getItem("morrow-journey") || "null");
  } catch {}
  const remember = () => {
    try {
      sessionStorage.setItem("morrow-journey", JSON.stringify(credential));
    } catch {}
  };
  const headers = () => ({
    authorization: "Bearer " + credential.token,
    "idempotency-key": credential.key,
  });
  const message = (id, text = "") => {
    el(id).textContent = text;
    el(id).hidden = !text;
  };
  function expired(e) {
    if (e?.morrowExpired) return true;
    if (
      ![
        "SESSION_UNAVAILABLE",
        "DEMO_SESSION_EXPIRED",
        "SESSION_EXPIRED",
      ].includes(e?.message)
    )
      return false;
    try {
      e.morrowExpired = true;
    } catch {}
    credential = { key: crypto.randomUUID(), token: null };
    remember();
    view = null;
    chapter = "A";
    proposalAttempted = false;
    const returnFocusFromDialog = dialogs.some((dialog) => dialog.open);
    for (const dialog of dialogs) {
      if (dialog.dataset.locked === "true") lock(dialog, false);
      dialog.classList.remove("is-closing");
      if (dialog.open) dialog.close();
    }
    message(
      "journey-error",
      "This demo expired. Start a new demo to continue.",
    );
    render();
    if (returnFocusFromDialog)
      el("primary-action").focus({ preventScroll: true });
    return true;
  }
  const getState = async () => {
    try {
      return await api("/api/v1/demo/state", { headers: headers() });
    } catch (e) {
      expired(e);
      throw e;
    }
  };
  const request = async (path, body) => {
    try {
      return await api("/api/v1/demo/" + path, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(body ?? {}),
      });
    } catch (e) {
      expired(e);
      throw e;
    }
  };
  function errorText(e) {
    return (
      {
        PAYMENT_NOT_CONFIRMED:
          "Payment needs a fresh check. Close this review and check again.",
        READBACK_UNKNOWN:
          "The repair may have been recorded, but access is not confirmed yet. Retry the check.",
        STALE_REVIEW:
          "The case changed. Close this review and check the case again.",
        STALE_INVESTIGATION:
          "The case changed during investigation. Check again.",
        COMPARISON_BUSY: "This comparison is already running. Please wait.",
        COMPARISON_RETRY_LIMIT:
          "The comparison could not finish. Exit and try again later.",
        AGENT_RATE_LIMITED:
          "The free investigation service is busy. Try again shortly.",
        AGENT_BUSY: "An investigation is already running. Please wait.",
        AGENT_RETRY_LIMIT:
          "The investigation could not finish. Start a new demo or try again later.",
        STALE_DRAFT:
          "This draft changed. Close it and open the latest version.",
        LESSON_BUSY: "This lesson approval is already being recorded.",
        MEMORY_UNAVAILABLE: "Memory storage is unavailable. Try again later.",
        SESSION_UNAVAILABLE: "This demo expired. Start a new demo to continue.",
        DEMO_SESSION_EXPIRED:
          "This demo session has expired. Exit and start again.",
        INTAKE_RATE_LIMITED: "The demo is busy. Try again later.",
        CASE_A_REQUIRED: "Complete Case A’s lesson before opening Case B.",
        CASE_B_REQUIRED:
          "Complete the Case B comparison before opening Case C.",
        CASE_C_PAYMENT_PENDING:
          "The Case C payment is still being prepared. Wait and retry the check.",
      }[e.message] || "That action did not complete. Try again."
    );
  }
  const priorDisabled = new WeakMap();
  const lock = (dialog, on) => {
    if (dialog.dataset.locked === String(on)) return;
    dialog.dataset.locked = String(on);
    dialog.setAttribute("aria-busy", String(on));
    dialog.querySelectorAll("button,input,textarea").forEach((b) => {
      if (on) {
        priorDisabled.set(b, b.disabled);
        b.disabled = true;
      } else {
        b.disabled = priorDisabled.get(b) ?? false;
        priorDisabled.delete(b);
      }
    });
  };
  const bars = (id, count) =>
    el(id)
      .querySelectorAll("i")
      .forEach((b, i) => b.classList.toggle("active", i < count));
  const defaultReply = () =>
    matchMedia("(max-width:700px)").matches
      ? "I’ll check payment and access first."
      : "I’ll check the payment and your access before suggesting a fix.";
  function heading() {
    const small = matchMedia("(max-width:700px)").matches;
    if (!view) el("agent-message").textContent = defaultReply();
    el("story-title").textContent =
      chapter === "B"
        ? "Same problem. Different customer."
        : chapter === "C"
          ? view?.caseC.summary.payment.verdict === "MISMATCH"
            ? "This payment does not match the order."
            : "Check this payment against its order."
          : view?.caseA.summary.access === "CONFIRMED"
            ? "Mira can open her course."
            : small
              ? "Mira paid. Course locked."
              : "Mira paid. Her course is locked.";
    el("story-context").textContent =
      chapter === "B"
        ? "Alex Imani · Studio Template Bundle · Order #1078"
        : chapter === "C"
          ? "Noor · Layered Lessons · Order #1093"
          : "Layered Lessons · Order #1042";
  }
  matchMedia("(max-width:700px)").addEventListener("change", render);
  function render() {
    heading();
    el("case-a").hidden = chapter !== "A";
    el("case-b").hidden = chapter !== "B";
    el("case-c").hidden = chapter !== "C";
    for (const c of ["a", "b", "c"]) {
      el("chapter-" + c).classList.toggle(
        "active",
        chapter === c.toUpperCase(),
      );
      el("chapter-" + c).toggleAttribute(
        "aria-current",
        chapter === c.toUpperCase(),
      );
      if (chapter === c.toUpperCase())
        el("chapter-" + c).setAttribute("aria-current", "step");
    }
    el("chapter-b").disabled = view?.stage !== "A_COMPLETE";
    const cUnlocked =
      view?.baseline?.state === "COMPLETE" && !!view?.baseline?.result;
    el("chapter-c").disabled = !cUnlocked;
    const cMismatch = view?.caseC?.summary?.payment?.verdict === "MISMATCH";
    el("chapter-proof").disabled = !cMismatch;
    const primary = el("primary-action");
    primary.disabled = working;
    el("exit").textContent = matchMedia("(max-width:700px)").matches
      ? "Exit"
      : "Exit demo";
    if (!view) {
      if (matchMedia("(max-width:700px)").matches) {
        el("payment-state").textContent = "Payment unknown";
        el("access-state").textContent = "Access missing";
      } else {
        el("payment-state").textContent = "Checking needed";
        el("access-state").textContent = "Missing";
      }
      primary.textContent = working
        ? "Checking…"
        : credential?.key
          ? "Start a new demo"
          : "Start demo";
      renderC();
      return;
    }
    const summary = view.caseA.summary,
      pay = summary.payment.verdict;
    el("payment-state").textContent =
      pay === "MATCH"
        ? "Matched"
        : pay === "MISMATCH"
          ? "Mismatch"
          : "Payment unknown";
    el("payment-state").className =
      "state-pill " +
      (pay === "MATCH" ? "ok" : pay === "MISMATCH" ? "bad" : "warn");
    el("access-state").textContent =
      summary.access === "CONFIRMED" ? "Access present" : "Access missing";
    el("access-state").className =
      "state-pill " + (summary.access === "CONFIRMED" ? "ok" : "bad");
    const stage = view.stage,
      job = view.jobs.find((j) => j.role === "A");
    const labels = {
      CHECK: job?.working ? "Checking payment…" : "Check payment",
      INVESTIGATE: "Investigate case",
      REVIEW: "Review repair",
      REPAIR: "Check repair",
      LESSON: "Remember this fix",
      OPEN_B: "Open Case B",
      WAIT: "Please wait",
      PENDING: "Investigating…",
      BLOCKED: "Policy changed",
      STORAGE: "View lesson status",
      DECLINED: "Repair declined",
      RETRY_PAYMENT: "Check payment",
    };
    primary.textContent = working
      ? "Checking…"
      : labels[view.nextAction] || "Check payment";
    primary.disabled =
      working ||
      ["DECLINED", "WAIT", "PENDING", "BLOCKED"].includes(view.nextAction);
    el("case-badge").textContent =
      stage === "A_COMPLETE"
        ? "Lesson verified"
        : summary.access === "CONFIRMED"
          ? "Access restored"
          : stage === "REVIEW_READY"
            ? "Needs review"
            : stage === "DECLINED"
              ? "Declined"
              : "Needs verification";
    el("case-badge").className =
      "state-pill " +
      (summary.access === "CONFIRMED"
        ? "ok"
        : stage === "DECLINED"
          ? "bad"
          : "warn");
    el("action-title").textContent =
      stage === "A_COMPLETE"
        ? "This fix can guide the next case."
        : summary.access === "CONFIRMED"
          ? "Access is restored."
          : stage === "REVIEW_READY"
            ? "The payment matches this order."
            : stage === "DECLINED"
              ? "No repair was made."
              : "Start with the payment.";
    el("agent-message").textContent =
      view.caseA.proposal?.reason ||
      (summary.access === "CONFIRMED"
        ? "Access is confirmed in the merchant record."
        : "I’ll check the payment and your access before suggesting a fix.");
    const storage = view.caseA.lesson;
    if (storage && ["STORING", "RECALL_PENDING"].includes(stage))
      message(
        "action-note",
        storage.state === "COMPLETED"
          ? "The lesson is stored. Fresh recall is still being checked."
          : storage.state === "APPROVED"
            ? "The approved lesson is queued for storage."
            : "The storage request is pending.",
      );
    else
      message(
        "action-note",
        stage === "POLICY_BLOCKED"
          ? "Current policy does not permit this step. Exit and start a new demo."
          : "",
      );
    if (job?.state === "FAILED" || job?.state === "CANCELLED")
      message(
        "journey-error",
        "The payment could not be completed. Exit and start a new demo.",
      );
    if (el("lesson-dialog").open && storage) renderStorage();
    el("exit").textContent = matchMedia("(max-width:700px)").matches
      ? "Exit"
      : "Exit demo";
    if (chapter === "B") renderB();
    renderC();
  }
  function renderC() {
    const job = view?.jobs?.find((item) => item.role === "C");
    const summary = view?.caseC?.summary;
    const verdict = summary?.payment?.verdict || "NOT_CHECKED";
    const access = view?.caseC?.access || "MISSING";
    const mismatch = verdict === "MISMATCH";
    const preparing =
      !!job &&
      ["QUEUED", "PREPARING", "RESERVED", "SUBMITTING"].includes(job.state);
    el("case-c-payment").textContent =
      verdict === "MISMATCH"
        ? "Mismatch confirmed"
        : verdict === "MATCH"
          ? "Matched"
          : verdict === "UNKNOWN"
            ? "Payment unknown"
            : job?.state === "FAILED"
              ? "Payment unavailable"
              : job?.state === "CANCELLED"
                ? "Payment cancelled"
                : "Not checked";
    el("case-c-payment").className =
      "state-pill " + (mismatch ? "bad" : verdict === "MATCH" ? "ok" : "warn");
    el("case-c-access").textContent =
      access === "RESTORED" ? "Access present" : "Access missing";
    el("case-c-access").className =
      "state-pill " + (access === "RESTORED" ? "ok" : "bad");
    el("case-c-badge").textContent = mismatch
      ? "Safe refusal"
      : !job
        ? "Ready"
        : preparing
          ? "Payment pending"
          : "Needs verification";
    el("case-c-badge").className = "state-pill " + (mismatch ? "ok" : "warn");
    el("case-c-title").textContent = mismatch
      ? "No access was granted."
      : job?.state === "FAILED" || job?.state === "CANCELLED"
        ? "Payment could not be checked."
        : "Start with the payment.";
    el("case-c-message").textContent = mismatch
      ? "The transaction succeeded, but its amount does not match this order. No repair or refund was made."
      : "I’ll check the payment against this order. No access or refund will be changed.";
    const action = el("case-c-action");
    action.textContent = !job
      ? "Open Case C"
      : preparing
        ? "Preparing payment…"
        : mismatch
          ? "Mismatch confirmed"
          : job.state === "FAILED" || job.state === "CANCELLED"
            ? "Payment unavailable"
            : verdict === "UNKNOWN"
              ? "Retry payment check"
              : "Check payment";
    action.disabled =
      working ||
      preparing ||
      mismatch ||
      job?.state === "FAILED" ||
      job?.state === "CANCELLED";
    el("continue-proof").hidden = !mismatch;
    el("continue-proof").disabled = working;
  }
  function schedule() {
    clearTimeout(timer);
    if (!credential?.token) return;
    const active =
      working ||
      view?.stage !== "A_COMPLETE" ||
      (chapter === "B" && !view?.comparison) ||
      (chapter === "C" &&
        view?.caseC?.summary?.payment?.verdict !== "MISMATCH");
    timer = setTimeout(
      () => refresh().catch(() => {}),
      document.hidden ? 15000 : active ? 4000 : 15000,
    );
  }
  async function refresh() {
    if (working) {
      schedule();
      return;
    }
    const current = ++sequence;
    try {
      const next = await getState();
      if (current !== sequence) return;
      view = next;
      message("journey-error");
      render();
      if (
        view.stage === "INVESTIGATION_READY" &&
        !proposalAttempted &&
        chapter === "A"
      ) {
        proposalAttempted = true;
        await investigate();
      }
    } catch (e) {
      if (current === sequence && !expired(e))
        message(
          chapter === "B"
            ? "comparison-error"
            : chapter === "C"
              ? "case-c-error"
              : "journey-error",
          errorText(e),
        );
    } finally {
      schedule();
    }
  }
  async function action(task) {
    if (working) return;
    working = true;
    sequence++;
    render();
    message("journey-error");
    message("case-c-error");
    try {
      await task();
    } catch (e) {
      if (!expired(e))
        message(
          chapter === "C" ? "case-c-error" : "journey-error",
          errorText(e),
        );
    } finally {
      working = false;
      render();
      schedule();
    }
  }
  async function start() {
    if (!credential?.key) {
      credential = { key: crypto.randomUUID(), token: null };
      remember();
    }
    const run = await api("/api/v1/demo/sessions", {
      method: "POST",
      headers: { "idempotency-key": credential.key },
      body: "{}",
    });
    credential.token = run.token;
    remember();
    view = await getState();
    render();
  }
  async function investigate() {
    await action(async () => {
      message("action-note", "Morrow is checking the case.");
      view = await request("investigate");
    });
  }
  async function review() {
    view = await getState();
    render();
    if (!view.caseA.summary.allowed.approve) {
      message(
        "journey-error",
        "Check the payment again before reviewing this repair.",
      );
      return;
    }
    message("review-error");
    message("review-progress");
    el("review-title").textContent = "Approve this repair?";
    el("review-step").textContent = "Step 1 of 3";
    bars("review-bars", 1);
    el("review-access").textContent = "Missing";
    el("review-access").className = "state-pill bad";
    for (const id of ["reject", "cancel-review", "approve-repair"])
      el(id).hidden = false;
    el("approve-repair").textContent = "Approve & check";
    el("review-remember").hidden = true;
    openDialog(el("review-dialog"), el("primary-action"));
  }
  async function repair(decisionId) {
    const result = await request("repair", { decisionId });
    if (result.status !== "READBACK_CONFIRMED") throw Error("READBACK_UNKNOWN");
    view = await getState();
    render();
    el("review-title").textContent = "Access restored";
    el("review-step").textContent = "Step 3 of 3";
    bars("review-bars", 3);
    el("review-access").textContent = "Confirmed";
    el("review-access").className = "state-pill ok";
    message(
      "review-progress",
      "Access was read back from the merchant record.",
    );
    for (const id of ["reject", "cancel-review", "approve-repair"])
      el(id).hidden = true;
    el("review-remember").hidden = false;
  }
  el("primary-action").onclick = async () => {
    if (working) return;
    if (!credential?.token) {
      await action(start);
      if (view) await refresh();
      return;
    }
    const next = view?.nextAction;
    if (next === "REVIEW") {
      try {
        await review();
      } catch (e) {
        if (!expired(e)) message("journey-error", errorText(e));
      }
      return;
    }
    if (next === "LESSON" || next === "STORAGE") {
      await openLesson();
      return;
    }
    if (next === "OPEN_B") {
      await openB();
      return;
    }
    if (next === "INVESTIGATE") {
      proposalAttempted = true;
      await investigate();
      return;
    }
    if (next === "REPAIR") {
      const decisionId = view.caseA.decision?.id ?? view.caseA.repairDecisionId;
      await action(async () => {
        const result = await request("repair", { decisionId });
        if (result.status !== "READBACK_CONFIRMED")
          throw Error("READBACK_UNKNOWN");
        view = await getState();
      });
      return;
    }
    await action(async () => {
      view = await request("check");
    });
    if (view?.stage === "INVESTIGATION_READY") await investigate();
  };
  el("approve-repair").onclick = async () => {
    const dialog = el("review-dialog");
    if (dialog.dataset.locked === "true") return;
    lock(dialog, true);
    message("review-error");
    el("review-title").textContent = "Checking approval…";
    try {
      const prior =
        view.caseA.decision?.kind === "APPROVED"
          ? view.caseA.decision.id
          : view.caseA.repairDecisionId;
      const decision = prior
        ? { id: prior }
        : await request("decision", {
            kind: "APPROVED",
            caseVersion: view.caseA.caseVersion,
            policyVersion: view.caseA.policyVersion,
          });
      el("review-title").textContent = "Restoring access";
      el("review-step").textContent = "Step 2 of 3";
      bars("review-bars", 2);
      message("review-progress", "Checking the result in the merchant record…");
      await repair(decision.id);
    } catch (e) {
      if (!expired(e)) message("review-error", errorText(e));
      view = await getState().catch(() => view);
      render();
      if (view?.caseA.summary.access === "CONFIRMED") {
        el("review-title").textContent = "Access confirmed";
        el("review-step").textContent = "Step 3 of 3";
        bars("review-bars", 3);
        for (const id of ["reject", "cancel-review", "approve-repair"])
          el(id).hidden = true;
        el("review-remember").hidden = false;
      } else if (view?.caseA.decision?.kind === "APPROVED")
        el("approve-repair").textContent = "Retry check";
    } finally {
      lock(dialog, false);
    }
  };
  el("reject").onclick = () =>
    busy(el("reject"), async () => {
      try {
        await request("decision", {
          kind: "REJECTED",
          caseVersion: view.caseA.caseVersion,
          policyVersion: view.caseA.policyVersion,
        });
        await closeDialog(el("review-dialog"));
        await refresh();
      } catch (e) {
        message("review-error", errorText(e));
      }
    });
  el("review-remember").onclick = async () => {
    await closeDialog(el("review-dialog"));
    await openLesson();
  };
  const STEP_LABELS = {
    VERIFY_CURRENT_ORDER: "Verify the current order",
    VERIFY_PAYMENT_INTENT: "Verify payment intent",
    CHECK_CURRENT_POLICY: "Check current policy",
    CHECK_PERSISTED_ACCESS: "Read current access",
    REQUEST_MERCHANT_APPROVAL: "Request merchant approval",
    GRANT_IDEMPOTENTLY: "Repair once",
    CONFIRM_READBACK: "Confirm access by readback",
    ESCALATE_UNKNOWN: "Escalate uncertain evidence",
  };
  const required = new Set([
    "VERIFY_PAYMENT_INTENT",
    "CHECK_CURRENT_POLICY",
    "REQUEST_MERCHANT_APPROVAL",
    "GRANT_IDEMPOTENTLY",
    "CONFIRM_READBACK",
  ]);
  function renderDraft() {
    el("lesson-title").textContent = "Remember this fix?";
    el("lesson-step").textContent = "Step 1 of 3";
    bars("lesson-bars", 1);
    el("lesson-review").hidden = false;
    el("lesson-editor").hidden = true;
    el("lesson-storage").hidden = true;
    el("lesson-actions").hidden = false;
    el("edit-lesson").hidden = false;
    el("approve-lesson").hidden = false;
    el("open-b").hidden = true;
    el("retry-lesson").hidden = true;
    const categories = draft.payload.applicableCategories || [
      draft.payload.productCategory,
    ];
    el("lesson-scope").textContent =
      "Applies to " + categories.join(" and ") + ".";
  }
  async function openLesson() {
    if (working) return;
    try {
      message("lesson-error");
      draft = await request("draft/open");
      renderDraft();
      openDialog(el("lesson-dialog"), el("primary-action"));
      if (view.caseA.lesson) renderStorage();
    } catch (e) {
      message("journey-error", errorText(e));
    }
  }
  function renderStorage() {
    const lesson = view.caseA.lesson;
    if (!lesson) return;
    el("lesson-review").hidden = true;
    el("lesson-editor").hidden = true;
    el("lesson-actions").hidden = false;
    el("lesson-storage").hidden = false;
    el("edit-lesson").hidden = true;
    el("approve-lesson").hidden = true;
    const verified = lesson.state === "RECALL_VERIFIED",
      failed = view.lessonJobs.some(
        (j) => j.lesson_id === lesson.id && j.state === "FAILED",
      );
    el("lesson-title").textContent = verified
      ? "Lesson remembered"
      : "Saving the lesson";
    el("lesson-step").textContent = verified ? "Step 3 of 3" : "Step 2 of 3";
    bars("lesson-bars", verified ? 3 : 2);
    el("storage-state").textContent = verified
      ? "Verified"
      : lesson.state === "COMPLETED"
        ? "Stored · recall pending"
        : lesson.state === "APPROVED"
          ? "Queued"
          : lesson.state === "FAILED" || failed
            ? "Unavailable"
            : "Accepted · pending";
    el("storage-state").className =
      "state-pill " + (verified ? "ok" : failed ? "bad" : "warn");
    el("storage-message").textContent = verified
      ? "The stored lesson was retrieved and its exact content verified."
      : failed
        ? "Storage or recall did not complete. You can retry safely."
        : lesson.state === "COMPLETED"
          ? "A blob is stored. Fresh recall is still being checked."
          : "Storage is not confirmed yet.";
    el("storage-job").textContent = lesson.job_id || "Waiting";
    el("storage-blob").textContent = lesson.blob_id || "Waiting";
    el("open-b").hidden = !verified;
    el("retry-lesson").hidden = !failed;
  }
  el("edit-lesson").onclick = () => {
    el("lesson-review").hidden = true;
    el("lesson-actions").hidden = true;
    el("lesson-editor").hidden = false;
    el("lesson-title").textContent = "Edit the lesson";
    const container = el("procedure-options");
    container.replaceChildren();
    for (const [key, label] of Object.entries(STEP_LABELS)) {
      const row = document.createElement("label");
      row.className = "check-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = key;
      input.name = "procedure";
      input.checked = draft.payload.procedure.includes(key);
      input.disabled = required.has(key);
      row.append(input, document.createTextNode(label));
      container.append(row);
    }
    const categories = draft.payload.applicableCategories || [
      draft.payload.productCategory,
    ];
    el("scope-course").checked = categories.includes("course");
    el("scope-download").checked = categories.includes("download");
  };
  el("cancel-edit").onclick = renderDraft;
  el("lesson-editor").onsubmit = (e) => {
    e.preventDefault();
    busy(el("save-draft"), async () => {
      try {
        message("draft-error");
        const procedure = [
            ...el("procedure-options").querySelectorAll("input:checked"),
          ].map((i) => i.value),
          applicableCategories = ["course", "download"].filter(
            (c) => el("scope-" + c).checked,
          );
        if (!applicableCategories.length) {
          message("draft-error", "Choose at least one product type.");
          el("scope-course").focus();
          return;
        }
        draft = await request("draft", {
          version: draft.version,
          procedure,
          applicableCategories,
        });
        renderDraft();
      } catch (err) {
        message("draft-error", errorText(err));
      }
    });
  };
  el("approve-lesson").onclick = async () => {
    const dialog = el("lesson-dialog");
    if (dialog.dataset.locked === "true") return;
    lock(dialog, true);
    message("lesson-error");
    try {
      await request("lesson/approve", { version: draft.version });
      view = await getState();
      render();
      renderStorage();
    } catch (e) {
      message("lesson-error", errorText(e));
    } finally {
      lock(dialog, false);
      schedule();
    }
  };
  el("retry-lesson").onclick = () =>
    busy(el("retry-lesson"), async () => {
      try {
        view = await request("lesson/retry");
        render();
        renderStorage();
      } catch (e) {
        message("lesson-error", errorText(e));
      }
    });
  async function openB() {
    if (working) return;
    await action(async () => {
      view = await request("start-b");
      if (el("lesson-dialog").open) await closeDialog(el("lesson-dialog"));
      chapter = "B";
      render();
      window.Morrow.motion(el("case-b"), [{ opacity: 0 }, { opacity: 1 }], 160);
    });
  }
  el("open-b").onclick = openB;
  el("chapter-b").onclick = openB;
  async function openC() {
    if (working) return;
    if (!view?.jobs.some((job) => job.role === "C")) {
      await action(async () => {
        view = await request("start-c");
        chapter = "C";
      });
      return;
    }
    chapter = "C";
    render();
  }
  el("chapter-c").onclick = openC;
  el("case-c-action").onclick = async () => {
    if (!view?.jobs.some((job) => job.role === "C")) {
      await openC();
      return;
    }
    if (el("case-c-action").disabled) return;
    await action(async () => {
      view = await request("check-c");
    });
  };
  el("continue-proof").onclick = () => {
    if (!el("continue-proof").disabled) location.href = "/proof";
  };
  el("chapter-proof").onclick = () => {
    if (!el("chapter-proof").disabled) location.href = "/proof";
  };
  el("chapter-a").onclick = () => {
    chapter = "A";
    render();
    window.Morrow.motion(el("case-a"), [{ opacity: 0 }, { opacity: 1 }], 160);
  };
  function renderB() {
    const job = view.jobs.find((j) => j.role === "B"),
      baseline = view.baseline;
    const running =
      baseline?.lease_until &&
      new Date(baseline.lease_until).getTime() > Date.now();
    const off = baseline?.off_result,
      result = baseline?.result;
    if (result) message("comparison-error");
    el("run-off").disabled =
      working || running || !!off || job?.state !== "CONFIRMED";
    el("run-on").disabled = working || running || !off || !!result;
    el("run-off").textContent = off
      ? "Baseline complete"
      : baseline?.state === "OFF_RUNNING" || working
        ? "Investigating…"
        : "Run without memory";
    el("run-on").textContent = result
      ? "Comparison complete"
      : baseline?.state === "ON_RUNNING"
        ? "Retrieving & investigating…"
        : off
          ? "Run with memory"
          : "Run after baseline";
    el("off-result").textContent =
      off?.proposal.reason ||
      (job?.state !== "CONFIRMED"
        ? job?.state === "FAILED"
          ? "Payment unavailable. Exit and try again later."
          : "Checking this order’s payment…"
        : "No result yet.");
    el("on-result").textContent =
      result?.on.proposal.reason || "No result yet.";
    const outcome = result?.comparison.outcome;
    message(
      "comparison-outcome",
      outcome
        ? {
            EQUAL: "Both runs reached the same conclusion.",
            GUIDANCE_DIFFERENCE:
              "The recalled lesson changed the guidance. This does not establish a faster or better outcome.",
            INCONCLUSIVE:
              "Comparison inconclusive. Evidence changed or eligible memory could not be verified.",
          }[outcome] || "Comparison unavailable."
        : "",
    );
  }
  async function compare(mode) {
    if (working) return;
    await action(async () => {
      message("comparison-error");
      try {
        view = await request("comparison/" + mode);
      } catch (e) {
        message("comparison-error", errorText(e));
        view = await getState();
      }
    });
  }
  el("run-off").onclick = () => compare("off");
  el("run-on").onclick = () => compare("on");
  el("how").onclick = () => openDialog(el("how-dialog"), el("how"));
  el("exit").onclick = () =>
    busy(el("exit"), async () => {
      try {
        if (credential?.token) await request("reset");
      } catch (e) {
        if (e.status !== 401 && e.status !== 410) {
          message("journey-error", errorText(e));
          return;
        }
      }
      sessionStorage.removeItem("morrow-journey");
      location.href = "/";
    });

  render();
  if (credential?.key) {
    if (credential.token) refresh().catch(() => {});
    else action(start).then(() => refresh());
  }
})();
