/* One case-action controller shared by the queue and a direct case URL. */
(() => {
  const { api, el, busy, friendlyError, openDialog, closeDialog, setupDialog } =
    window.Morrow;
  const review = el("review-dialog"),
    evidence = el("evidence-dialog"),
    lesson = el("lesson-dialog");
  for (const dialog of [review, evidence, lesson]) setupDialog(dialog);
  let current = null,
    refresh = async () => {},
    approval = null,
    lessonDraft = null,
    lessonDirty = false;
  const path = (data, suffix = "") =>
    "/api/v1/merchant/cases/" + data.caseId + suffix;
  const message = (id, text = "") => {
    el(id).textContent = text;
    el(id).hidden = !text;
  };
  const date = (value) =>
    value ? new Date(value).toLocaleString() : "Not recorded";
  function node(tag, text, cls) {
    const n = document.createElement(tag);
    n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function facts(rows) {
    const dl = document.createElement("dl");
    dl.className = "evidence-facts";
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.append(node("dt", label), node("dd", String(value)));
      dl.append(row);
    }
    return dl;
  }
  function locked(dialog, value) {
    dialog.dataset.locked = String(value);
    dialog.setAttribute("aria-busy", String(value));
    for (const button of dialog.querySelectorAll("button"))
      button.disabled = value;
    if (!value && dialog === review && current)
      el("confirm-approve").disabled = !canApprove(current);
  }
  function canApprove(data) {
    const age = Date.now() - Date.parse(data.evidence.latestCheck?.checkedAt);
    return (
      data.access === "MISSING" &&
      data.policy.grantEnabled &&
      data.paymentAttested &&
      age >= -5000 &&
      age < 60000
    );
  }
  function renderReview(data) {
    review.dataset.mode = "decision";
    const allowed = canApprove(data);
    const decision = data.decisions.find(
      (d) =>
        d.kind === "APPROVED" &&
        d.case_version === data.caseVersion &&
        d.policy_version === data.policy.policyVersion,
    );
    approval = decision ? { id: decision.id } : null;
    el("review-title").textContent = "Approve this repair?";
    el("review-description").textContent =
      "Restore access to this order. No refund.";
    el("review-payment").textContent =
      data.evidence.latestCheck?.verdict === "MATCH"
        ? "Matched"
        : data.evidence.latestCheck?.verdict === "MISMATCH"
          ? "Mismatch"
          : "Not verified";
    el("review-payment").className = data.paymentAttested ? "ok" : "warn";
    el("review-access").textContent =
      data.access === "RESTORED" ? "Present" : "Missing";
    el("review-access").className = data.access === "RESTORED" ? "ok" : "bad";
    el("review-operation").textContent = "Restore one entitlement";
    el("correction-field").hidden = true;
    el("correct-btn").hidden = data.access === "RESTORED";
    el("submit-correction").hidden = true;
    el("submit-correction").disabled = false;
    el("correction-target").value = "";
    window.Morrow.setFieldError(el("correction-target"), "");
    el("correction-note").value = "";
    window.Morrow.setFieldError(el("correction-note"), "");
    el("close-review").textContent = "Cancel";
    el("confirm-approve").hidden = !!approval || data.access === "RESTORED";
    el("confirm-approve").disabled = !allowed;
    el("retry-repair").hidden = !approval || data.access === "RESTORED";
    el("reject-btn").hidden = data.access === "RESTORED";
    message("review-error");
    message(
      "review-progress",
      allowed || approval
        ? ""
        : data.access === "RESTORED"
          ? "Access is already present."
          : !data.policy.grantEnabled
            ? "Current policy does not permit a repair."
            : "Verify payment before approval.",
    );
  }
  async function fresh(data) {
    return api(path(data));
  }
  async function changed(data) {
    current = await fresh(data);
    await refresh(current);
    return current;
  }
  async function execute(data, decision) {
    message("review-error");
    message("review-progress", "Repair requested. Checking access…");
    locked(review, true);
    try {
      const result = await api(path(data, "/repairs"), {
        method: "POST",
        body: JSON.stringify({
          decisionId: decision.id,
          idempotencyKey: "merchant-" + decision.id,
        }),
      });
      const updated = await changed(data);
      if (
        result.status !== "READBACK_CONFIRMED" ||
        updated.access !== "RESTORED"
      )
        throw new Error("READBACK_UNKNOWN");
      el("review-title").textContent = "Access restored";
      el("review-operation").textContent = "Entitlement confirmed";
      el("review-access").textContent = "Confirmed";
      el("review-access").className = "ok";
      message(
        "review-progress",
        "Access was read back from the merchant record.",
      );
      el("confirm-approve").hidden = true;
      el("retry-repair").hidden = true;
      el("reject-btn").hidden = true;
    } catch (error) {
      message("review-progress");
      message(
        "review-error",
        friendlyError(
          error,
          "Repair is not confirmed. Recheck access before retrying.",
        ),
      );
      el("confirm-approve").hidden = true;
      el("retry-repair").hidden = false;
    } finally {
      locked(review, false);
    }
  }
  el("confirm-approve").onclick = async () => {
    if (review.dataset.locked === "true" || !current) return;
    const data = current;
    locked(review, true);
    message("review-error");
    message("review-progress", "Checking approval…");
    try {
      approval = await api(path(data, "/decisions"), {
        method: "POST",
        body: JSON.stringify({
          kind: "APPROVED",
          caseVersion: data.caseVersion,
          policyVersion: data.policy.policyVersion,
        }),
      });
      await execute(data, approval);
    } catch (error) {
      message("review-progress");
      message(
        "review-error",
        friendlyError(
          error,
          "The case changed. Close this review and check the case again.",
        ),
      );
    } finally {
      locked(review, false);
      if (!approval) el("confirm-approve").disabled = !canApprove(data);
    }
  };
  el("retry-repair").onclick = async () => {
    if (review.dataset.locked === "true" || !current) return;
    const data = current;
    locked(review, true);
    message("review-error");
    message("review-progress", "Rechecking access…");
    try {
      const updated = await changed(data);
      if (updated.access === "RESTORED") {
        el("review-title").textContent = "Access confirmed";
        el("review-operation").textContent = "No further repair needed";
        el("review-access").textContent = "Confirmed";
        el("review-access").className = "ok";
        el("retry-repair").hidden = true;
        el("reject-btn").hidden = true;
        message("review-progress", "Access is present in the merchant record.");
      } else if (approval) await execute(updated, approval);
      else {
        renderReview(updated);
        message("review-error", "A new approval is required.");
      }
    } catch (error) {
      message("review-progress");
      message(
        "review-error",
        friendlyError(error, "Access could not be checked. Try again."),
      );
    } finally {
      locked(review, false);
    }
  };
  el("reject-btn").onclick = async () => {
    if (review.dataset.locked === "true" || !current) return;
    const data = current;
    locked(review, true);
    message("review-error");
    try {
      await api(path(data, "/decisions"), {
        method: "POST",
        body: JSON.stringify({
          kind: "REJECTED",
          caseVersion: data.caseVersion,
          policyVersion: data.policy.policyVersion,
        }),
      });
      await changed(data);
      el("review-title").textContent = "Repair declined";
      message("review-progress", "No access change was made.");
      el("confirm-approve").hidden = true;
      el("retry-repair").hidden = true;
      el("reject-btn").hidden = true;
    } catch (error) {
      message(
        "review-error",
        friendlyError(
          error,
          "The rejection was not recorded. Check the case again.",
        ),
      );
    } finally {
      locked(review, false);
    }
  };
  el("correct-btn").onclick = () => {
    review.dataset.mode = "correction";
    el("review-title").textContent = "Request a correction";
    el("review-description").textContent =
      "Update the source record, then recheck it here. Access is unchanged.";
    el("review-operation").textContent = "No access change";
    message("review-progress");
    el("correction-field").hidden = false;
    el("correct-btn").hidden = true;
    el("submit-correction").hidden = false;
    el("reject-btn").hidden = true;
    el("confirm-approve").hidden = true;
    el("retry-repair").hidden = true;
    el("correction-target").focus();
  };
  el("correction-target").addEventListener("change", () => {
    window.Morrow.setFieldError(
      el("correction-target"),
      el("correction-target").value
        ? ""
        : "Choose the case detail that needs correction.",
    );
  });
  el("submit-correction").onclick = async () => {
    if (review.dataset.locked === "true" || !current) return;
    const data = current,
      correctionTarget = el("correction-target").value,
      reason = el("correction-note").value.trim();
    window.Morrow.setFieldError(
      el("correction-target"),
      correctionTarget ? "" : "Choose the case detail that needs correction.",
    );
    window.Morrow.setFieldError(
      el("correction-note"),
      reason.length < 8
        ? "Add a short reason so the case can be reviewed again."
        : "",
    );
    if (!correctionTarget) {
      el("correction-target").focus();
      return;
    }
    if (reason.length < 8) {
      el("correction-note").focus();
      return;
    }
    locked(review, true);
    message("review-error");
    message("review-progress", "Recording the correction request…");
    let outcomeUncertain = false;
    try {
      await api(path(data, "/decisions"), {
        method: "POST",
        body: JSON.stringify({
          kind: "CORRECTED",
          caseVersion: data.caseVersion,
          policyVersion: data.policy.policyVersion,
          correctionTarget,
          reason,
        }),
      });
      review.dataset.mode = "result";
      el("review-title").textContent = "Correction requested";
      message(
        "review-progress",
        "Update the source record, then recheck it before reviewing again.",
      );
      el("review-operation").textContent = "No access was changed.";
      for (const id of [
        "confirm-approve",
        "retry-repair",
        "reject-btn",
        "correct-btn",
        "submit-correction",
      ])
        el(id).hidden = true;
      el("correction-field").hidden = true;
      el("close-review").textContent = "Return to case";
      try {
        await changed(data);
      } catch {
        message(
          "review-progress",
          "Correction recorded. Close and reopen the case to refresh its details.",
        );
      }
    } catch (error) {
      const confirmedClientError =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status < 500;
      outcomeUncertain = !confirmedClientError;
      message("review-progress");
      message(
        "review-error",
        confirmedClientError
          ? friendlyError(
              error,
              "The correction was not recorded. Check the case and try again.",
            )
          : "We could not confirm whether the correction was recorded. Close and reopen the case before trying again.",
      );
    } finally {
      locked(review, false);
      if (outcomeUncertain) el("submit-correction").disabled = true;
    }
  };
  function renderEvidence(data) {
    const check = data.evidence.latestCheck,
      intent = data.evidence.intent;
    el("evidence-content").replaceChildren(
      facts([
        ["Order", data.orderId],
        ["Payment", check ? check.verdict : "Not checked"],
        ["Checked", date(check?.checkedAt)],
        ["Payment network", intent?.network ?? "Not recorded"],
        ["Transaction", intent?.digest ?? "Not recorded"],
        ["Access", data.access === "RESTORED" ? "Present" : "Missing"],
        ["Current policy", "v" + data.policy.policyVersion],
        ["Repair allowed", data.policy.grantEnabled ? "Yes" : "No"],
      ]),
    );
    const recommendation = data.events.find(
      (event) => event.kind === "AGENT_RECOMMENDATION",
    );
    if (recommendation?.data?.reason) {
      el("evidence-content").append(
        node("h3", "Recommendation"),
        node("p", recommendation.data.reason),
      );
    }
    el("case-activity").replaceChildren();
    for (const event of data.events)
      el("case-activity").append(
        node(
          "p",
          event.kind.replaceAll("_", " ") +
            (event.data?.reason ? " · " + event.data.reason : "") +
            " · " +
            date(event.created_at),
        ),
      );
    if (!data.events.length)
      el("case-activity").append(node("p", "No activity yet.", "muted"));
    el("open-lesson").disabled =
      data.access !== "RESTORED" || !data.repairs.length;
    el("open-lesson").textContent = el("open-lesson").disabled
      ? "Repair required for lesson"
      : "Review lesson";
    el("open-lesson").title = el("open-lesson").disabled
      ? "A confirmed repair is required"
      : "";
  }
  el("check-payment").onclick = () =>
    busy(el("check-payment"), async () => {
      const data = current;
      message("evidence-error");
      try {
        const result = await api(path(data, "/investigations"), {
          method: "POST",
        });
        const updated = await changed(data);
        renderEvidence(updated);
        if (result.verdict === "UNKNOWN")
          message(
            "evidence-error",
            "Payment can't be checked right now. Retry the check.",
          );
      } catch (error) {
        message(
          "evidence-error",
          friendlyError(error, "Payment could not be checked. Try again."),
        );
      }
    });
  const procedure = [
    "VERIFY_CURRENT_ORDER",
    "VERIFY_PAYMENT_INTENT",
    "CHECK_CURRENT_POLICY",
    "CHECK_PERSISTED_ACCESS",
    "REQUEST_MERCHANT_APPROVAL",
    "GRANT_IDEMPOTENTLY",
    "CONFIRM_READBACK",
    "ESCALATE_UNKNOWN",
  ];
  const procedureLabels = {
    VERIFY_CURRENT_ORDER: "Verify the current order",
    VERIFY_PAYMENT_INTENT: "Verify the payment intent",
    CHECK_CURRENT_POLICY: "Check current policy",
    CHECK_PERSISTED_ACCESS: "Read persisted access",
    REQUEST_MERCHANT_APPROVAL: "Require merchant approval",
    GRANT_IDEMPOTENTLY: "Repair access once",
    CONFIRM_READBACK: "Confirm access by readback",
    ESCALATE_UNKNOWN: "Escalate uncertain evidence",
  };
  const categories = ["course", "download", "subscription", "pass", "service"];
  function buildLessonControls() {
    if (el("lesson-procedures").childElementCount) return;
    for (const value of procedure) {
      const label = document.createElement("label");
      label.className = "check-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      input.dataset.procedure = "";
      label.append(input, document.createTextNode(procedureLabels[value]));
      el("lesson-procedures").append(label);
    }
    for (const value of categories) {
      const label = document.createElement("label");
      label.className = "check-option";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      input.dataset.category = "";
      label.append(
        input,
        document.createTextNode(value[0].toUpperCase() + value.slice(1)),
      );
      el("lesson-applicability").append(label);
    }
    el("lesson-editor").addEventListener("change", () => {
      lessonDirty = true;
      el("lesson-approve").disabled = true;
    });
  }
  function setLessonForm(payload) {
    el("lesson-category").value = payload?.productCategory ?? "";
    const chosenSteps = new Set(payload?.procedure ?? procedure);
    for (const input of el("lesson-procedures").querySelectorAll("input"))
      input.checked = chosenSteps.has(input.value);
    const chosenCategories = new Set(
      payload?.applicableCategories ??
        (payload?.productCategory ? [payload.productCategory] : []),
    );
    for (const input of el("lesson-applicability").querySelectorAll("input"))
      input.checked = chosenCategories.has(input.value);
    lessonDirty = false;
  }
  function lessonInput() {
    const productCategory = el("lesson-category").value,
      applicableCategories = [
        ...el("lesson-applicability").querySelectorAll("input:checked"),
      ].map((input) => input.value),
      steps = [
        ...el("lesson-procedures").querySelectorAll("input:checked"),
      ].map((input) => input.value);
    window.Morrow.setFieldError(
      el("lesson-category"),
      categories.includes(productCategory)
        ? ""
        : "Choose the product category for this case.",
    );
    const requiredSteps = [
      "VERIFY_PAYMENT_INTENT",
      "REQUEST_MERCHANT_APPROVAL",
      "GRANT_IDEMPOTENTLY",
      "CONFIRM_READBACK",
    ];
    const validSteps =
      steps.length >= 5 && requiredSteps.every((step) => steps.includes(step));
    const validScope =
      applicableCategories.length > 0 &&
      applicableCategories.includes(productCategory);
    el("lesson-procedure-error").textContent = validSteps
      ? ""
      : "Choose at least five steps, including payment, approval, repair and readback.";
    el("lesson-scope-error").textContent = validScope
      ? ""
      : "Choose a scope that includes this product category.";
    el("lesson-procedures").setAttribute("aria-invalid", String(!validSteps));
    el("lesson-applicability").setAttribute(
      "aria-invalid",
      String(!validScope),
    );
    return categories.includes(productCategory) && validSteps && validScope
      ? { productCategory, applicableCategories, procedure: steps }
      : null;
  }
  function renderLesson(data, savedDraft = null) {
    const saved = data.lessons[0];
    el("lesson-content").replaceChildren();
    buildLessonControls();
    lessonDraft = savedDraft;
    if (saved) {
      el("lesson-content").append(
        facts([
          ["Lesson", saved.id],
          ["Network", saved.network],
          ["Storage job", saved.job_id ?? "Not started"],
          ["Blob", saved.blob_id ?? "Not recorded"],
          [
            "Fresh recall",
            saved.recalled_at ? date(saved.recalled_at) : "Not verified",
          ],
        ]),
      );
    } else {
      el("lesson-editor").hidden = false;
      setLessonForm(
        savedDraft?.payload ?? {
          productCategory: data.scenario?.category ?? "",
          applicableCategories: data.scenario?.category
            ? [data.scenario.category]
            : [],
          procedure,
        },
      );
    }
    el("lesson-editor").hidden = !!saved;
    el("lesson-state").textContent = saved
      ? ({
          APPROVED: "Approved. Not stored.",
          ACCEPTED: "Write accepted. Not stored.",
          PENDING: "Storage pending.",
          UNKNOWN: "Storage status unknown.",
          COMPLETED: "Storage confirmed. Recall not checked.",
          RECALL_VERIFIED: "Storage and recall confirmed.",
          FAILED: "Storage failed.",
        }[saved.state] ?? "Storage status unknown.")
      : savedDraft
        ? `Draft v${savedDraft.version} saved. Approval is separate.`
        : "No lesson approved yet.";
    el("lesson-save").hidden = !!saved;
    el("lesson-save").textContent = savedDraft ? "Save changes" : "Save draft";
    el("lesson-approve").hidden = !!saved || !savedDraft;
    el("lesson-approve").disabled =
      !savedDraft ||
      lessonDirty ||
      data.access !== "RESTORED" ||
      !data.repairs.length;
    el("lesson-advance").hidden =
      !saved ||
      !["APPROVED", "ACCEPTED", "PENDING", "UNKNOWN"].includes(saved.state);
    el("lesson-advance").textContent =
      saved?.state === "APPROVED" ? "Store lesson" : "Check storage status";
    el("lesson-recall").hidden = saved?.state !== "COMPLETED";
  }
  el("open-lesson").onclick = async () => {
    await closeDialog(evidence);
    message("lesson-error");
    lessonDraft = null;
    try {
      lessonDraft = await api(path(current, "/lesson-draft"));
    } catch (error) {
      message(
        "lesson-error",
        friendlyError(error, "The lesson could not be loaded."),
      );
      return;
    }
    renderLesson(current, lessonDraft);
    openDialog(lesson);
  };
  el("lesson-save").onclick = () =>
    busy(el("lesson-save"), async () => {
      const data = current,
        input = lessonInput();
      if (!input) return;
      message("lesson-error");
      try {
        if (!lessonDraft) {
          lessonDraft = await api(path(data, "/lesson-draft"), {
            method: "POST",
            body: JSON.stringify({ productCategory: input.productCategory }),
          });
        }
        lessonDraft = await api(path(data, "/lesson-draft"), {
          method: "PUT",
          body: JSON.stringify({ version: lessonDraft.version, ...input }),
        });
        renderLesson(data, lessonDraft);
      } catch (error) {
        message(
          "lesson-error",
          friendlyError(error, "The draft was not saved. Try again."),
        );
      }
    });
  el("lesson-approve").onclick = () =>
    busy(el("lesson-approve"), async () => {
      const data = current;
      if (lessonDirty || !lessonDraft) {
        message("lesson-error", "Save the current draft before approving it.");
        return;
      }
      message("lesson-error");
      try {
        await api(path(data, "/lesson-draft/approve"), {
          method: "POST",
          body: JSON.stringify({ version: lessonDraft.version }),
        });
        lessonDraft = null;
        const updated = await changed(data);
        renderLesson(updated);
      } catch (error) {
        message(
          "lesson-error",
          friendlyError(error, "The lesson was not approved. Try again."),
        );
      }
    });
  for (const [id, action] of [
    ["lesson-advance", "advance"],
    ["lesson-recall", "recall"],
  ])
    el(id).onclick = () =>
      busy(el(id), async () => {
        const data = current,
          saved = data.lessons[0];
        if (!saved) return;
        message("lesson-error");
        try {
          await api(path(data, "/lesson/" + saved.id + "/" + action), {
            method: "POST",
          });
          renderLesson(await changed(data));
        } catch (error) {
          message(
            "lesson-error",
            friendlyError(error, "Storage could not be checked. Try again."),
          );
        }
      });
  for (const mode of ["OFF", "ON"])
    el("fair-" + mode.toLowerCase() + "-btn").onclick = () =>
      busy(el("fair-" + mode.toLowerCase() + "-btn"), async () => {
        message("fair-error");
        try {
          const result = await api(path(current, "/fair"), {
            method: "POST",
            body: JSON.stringify({ mode }),
          });
          el("fair-" + mode.toLowerCase()).textContent =
            result.plan.join(" → ");
        } catch (error) {
          message(
            "fair-error",
            friendlyError(error, "The plan could not be loaded."),
          );
        }
      });
  window.MorrowCaseActions = {
    configure(callback) {
      refresh = callback;
    },
    async review(data, returnTarget) {
      current = await fresh(data);
      renderReview(current);
      openDialog(review, returnTarget);
    },
    evidence(data) {
      current = data;
      message("evidence-error");
      renderEvidence(data);
      openDialog(evidence);
    },
  };
})();
