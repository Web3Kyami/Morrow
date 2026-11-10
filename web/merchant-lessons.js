(() => {
  const { api, el, busy, friendlyError, openDialog, setupDialog, signOut } =
    window.Morrow;
  const dialog = el("lesson-details");
  setupDialog(dialog);
  let rows = [],
    run = 0,
    timer = null,
    hasLoaded = false;

  function stateFor(lesson) {
    if (lesson.approvalState === "DRAFT")
      return { label: "Draft · review required", tone: "warn" };
    if (lesson.approvalState === "APPROVING")
      return { label: "Approval in progress", tone: "warn" };
    switch (lesson.state) {
      case "ACCEPTED":
      case "PENDING":
        return { label: "Write accepted · not stored", tone: "warn" };
      case "COMPLETED":
        return lesson.blobId
          ? { label: "Stored · fresh recall needed", tone: "ok" }
          : { label: "Completion unverified", tone: "warn" };
      case "RECALL_VERIFIED":
        return { label: "Stored · fresh recall verified", tone: "ok" };
      case "FAILED":
        return { label: "Write failed", tone: "bad" };
      case "UNKNOWN":
        return { label: "Storage status unknown", tone: "warn" };
      default:
        return { label: "Approved · not stored", tone: "warn" };
    }
  }

  const titleFor = (item) =>
    item.productCategory[0].toUpperCase() +
    item.productCategory.slice(1) +
    (item.problem === "PAID_ACCESS_MISSING" ? " access repair" : " lesson");

  function detailRow(label, value, code = false) {
    const wrap = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value || "Not available";
    if (code && value) description.classList.add("mono");
    wrap.append(term, description);
    return wrap;
  }

  function inspect(item, returnTarget) {
    const status = stateFor(item);
    const isDraft =
      item.approvalState === "DRAFT" || item.approvalState === "APPROVING";
    const details = el("memory-details");
    details.replaceChildren(
      detailRow(
        "Lesson source",
        `${isDraft ? "Draft from" : "Merchant-approved outcome ·"} ${item.caseId.slice(-8)}`,
      ),
      detailRow("Merchant scope", "This authenticated merchant workspace"),
      ...(item.applicableCategories?.length
        ? [
            detailRow(
              "Applicable categories",
              item.applicableCategories.join(", "),
            ),
          ]
        : [detailRow("Product category", item.productCategory)]),
      ...(Number.isInteger(item.policyVersion)
        ? [detailRow("Policy version", `Version ${item.policyVersion}`)]
        : [detailRow("Policy version", "Recorded when approved")]),
      detailRow("Review", item.approvalState || "Approved"),
      detailRow("Write status", status.label),
      ...(item.jobId ? [detailRow("Storage job", item.jobId, true)] : []),
      detailRow("Network", item.network || "Walrus Testnet"),
      detailRow("Blob ID", item.blobId || "Not available yet", true),
      detailRow(
        "Fresh-session recall",
        item.recalledAt
          ? `Verified ${new Date(item.recalledAt).toLocaleString()}`
          : "Not verified yet",
      ),
    );
    openDialog(dialog, returnTarget);
  }

  function makeItem(item, isDraft = false) {
    const entry = document.createElement("article");
    entry.className = "lesson-entry";
    const heading = document.createElement("h3");
    heading.textContent = titleFor(item);
    const source = document.createElement("p");
    source.className = "lesson-entry-source";
    source.textContent = isDraft
      ? `Case ${item.caseId.slice(-8)} · version ${item.version}`
      : `Case ${item.caseId.slice(-8)} · ${item.applicableCategories.join(", ")}`;
    const badge = document.createElement("span");
    const status = stateFor(item);
    badge.className = `lesson-status ${status.tone}`;
    badge.textContent = status.label;
    const inspect = document.createElement("button");
    inspect.className = "text-button lesson-inspect";
    inspect.type = "button";
    inspect.textContent = "Inspect status";
    inspect.setAttribute("aria-label", `Inspect ${titleFor(item)} status`);
    inspect.addEventListener("click", () => thisInspect(item, inspect));
    const titleWrap = document.createElement("div");
    titleWrap.className = "lesson-entry-title";
    titleWrap.append(heading, badge);
    entry.append(titleWrap, source, inspect);
    return entry;
  }

  function thisInspect(item, target) {
    inspect(item, target);
  }

  function render() {
    const container = el("lesson-rows");
    container.replaceChildren();
    for (const item of rows)
      container.append(
        makeItem(
          item,
          item.approvalState === "DRAFT" || item.approvalState === "APPROVING",
        ),
      );
    el("lesson-empty").hidden =
      rows.length > 0 || !!el("lesson-search").value.trim();
    el("lesson-no-results").hidden =
      rows.length > 0 || !el("lesson-search").value.trim();
    el("library-status").textContent =
      `${rows.length} lesson${rows.length === 1 ? "" : "s"} shown`;
  }

  async function load() {
    const current = ++run;
    const preserveContent = hasLoaded;
    if (!preserveContent) {
      el("library-content").hidden = true;
      el("library-loading").hidden = false;
    } else {
      el("library-content").setAttribute("aria-busy", "true");
      el("library-status").textContent = "Updating lessons";
    }
    el("library-error").hidden = true;
    try {
      const q = el("lesson-search").value.trim();
      const data = await api(
        "/api/v1/merchant/lessons" + (q ? `?q=${encodeURIComponent(q)}` : ""),
      );
      if (current !== run) return;
      rows = [
        ...data.drafts.map((item) => ({
          ...item,
          approvalState: item.approvalState,
        })),
        ...data.lessons,
      ];
      el("library-loading").hidden = true;
      el("library-content").hidden = false;
      el("library-content").setAttribute("aria-busy", "false");
      el("main").dataset.state = "ready";
      hasLoaded = true;
      render();
    } catch (error) {
      if (current !== run) return;
      el("library-loading").hidden = true;
      el("library-error").hidden = false;
      el("library-error-text").textContent = hasLoaded
        ? "The search couldn't be updated. Existing lessons remain visible. Try again."
        : friendlyError(error, "The lesson library is unavailable. Try again.");
      el("library-content").hidden = !hasLoaded;
      el("library-content").setAttribute("aria-busy", "false");
      if (hasLoaded)
        el("library-status").textContent =
          "Search update failed. Existing lessons remain visible.";
      el("main").dataset.state = "error";
      if (error.status === 401) location.href = "/merchant/login";
    }
  }

  el("retry-library").addEventListener("click", () =>
    busy(el("retry-library"), load),
  );
  el("lesson-search").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 180);
  });
  el("sign-out").addEventListener("click", () => signOut(el("sign-out")));
  load();
})();
