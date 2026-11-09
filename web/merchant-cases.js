/* Explicit queue, case and filter states; case actions are shared with direct case URLs. */
(() => {
  const { api, el, busy, friendlyError, motion } = window.Morrow;
  let cases = [],
    selected = null,
    current = null,
    filter = "ALL",
    queueRun = 0,
    caseRun = 0;
  const params = new URLSearchParams(location.search);
  const directId = location.pathname.split("/").filter(Boolean)[2];
  el("search").value = params.get("q") || "";
  const menu = el("status-menu"),
    trigger = el("case-filter");
  const mobileQueueTab = document.querySelector(
    ".mobile-workspace-nav button[aria-controls='case-rail']",
  );
  const mobileViewport = matchMedia("(max-width: 767px)");
  function labelCasePanel() {
    const selectedTab = [
      ...el("case-list").querySelectorAll("[role=tab]"),
    ].find((tab) => tab.dataset.caseId === selected);
    if (mobileViewport.matches)
      el("case-panel").setAttribute("aria-labelledby", "preview-title");
    else if (selectedTab)
      el("case-panel").setAttribute("aria-labelledby", selectedTab.id);
  }
  mobileViewport.addEventListener("change", labelCasePanel);
  function setMobileQueueOpen(open) {
    if (!mobileViewport.matches) return;
    const wasOpen = el("main").classList.contains("mobile-queue-open");
    el("main").classList.toggle("mobile-queue-open", open);
    mobileQueueTab.setAttribute("aria-expanded", String(open));
    const behavior = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth";
    if (open)
      requestAnimationFrame(() =>
        el("case-rail").scrollIntoView({
          block: "start",
          behavior,
        }),
      );
    else if (wasOpen)
      requestAnimationFrame(() =>
        el("case-panel").scrollIntoView({ block: "start", behavior }),
      );
  }
  const visible = (id, show) => {
    el(id).hidden = !show;
  };
  function classification(c) {
    if (c.summary)
      return (
        {
          ACCESS_PRESENT: "RESTORED",
          DECLINED: "DECLINED",
          APPROVED: "APPROVED",
          REFUSED: "REFUSED",
          NEEDS_REVIEW: "REVIEW",
          NEEDS_CHECK: "CHECK",
          POLICY_BLOCKED: "REFUSED",
          READBACK_UNKNOWN: "CHECK",
        }[c.summary.display] || "CHECK"
      );
    if (
      c.decision?.current &&
      c.decision.kind === "REJECTED" &&
      c.access !== "RESTORED"
    )
      return "DECLINED";
    if (
      c.decision?.current &&
      c.decision.kind === "APPROVED" &&
      c.access !== "RESTORED"
    )
      return "APPROVED";
    return c.access === "RESTORED"
      ? "RESTORED"
      : c.paymentVerdict === "MISMATCH"
        ? "REFUSED"
        : c.paymentAttested
          ? "REVIEW"
          : "CHECK";
  }
  const statusText = {
    RESTORED: "Access present",
    DECLINED: "Declined",
    APPROVED: "Approved",
    REFUSED: "Refused",
    REVIEW: "Needs review",
    CHECK: "Needs check",
  };
  function message(id, error, fallback) {
    el(id).textContent = friendlyError(error, fallback);
  }
  function renderCase(data) {
    current = data;
    visible("case-loading", false);
    visible("case-error", false);
    visible("case-content", true);
    const decision = data.decisions.find(
      (d) =>
        d.case_version === data.caseVersion &&
        d.policy_version === data.policy.policyVersion,
    );
    const declined = decision?.kind === "REJECTED",
      approved = decision?.kind === "APPROVED";
    const present = data.access === "RESTORED",
      verdict = data.evidence.latestCheck?.verdict;
    el("case-panel").dataset.state = "ready";
    el("case-panel").setAttribute("aria-busy", "false");
    el("preview-title").textContent = "Case #" + data.caseId.slice(-6);
    el("preview-context").textContent = "Order #" + data.orderId.slice(-6);
    el("preview-issue").textContent = data.issue || "";
    visible("preview-issue", !!data.issue);
    visible("message-empty", !data.issue);
    document.querySelector(".case-avatar").hidden = !data.issue;
    el("preview-payment").textContent =
      verdict === "MATCH"
        ? "Payment matched to order"
        : verdict === "MISMATCH"
          ? "Payment mismatch"
          : verdict === "UNKNOWN"
            ? "Payment unavailable"
            : "Payment not checked";
    el("preview-payment").className =
      verdict === "MATCH" ? "ok" : verdict === "MISMATCH" ? "bad" : "warn";
    el("preview-access").textContent = present
      ? "Access present"
      : "Access missing";
    el("preview-access").className = present ? "ok" : "bad";
    el("preview-state").textContent = present
      ? "Access present"
      : verdict === "MATCH"
        ? "Needs approval"
        : verdict === "MISMATCH"
          ? "Payment mismatch"
          : "Needs verification";
    if (!present && declined)
      el("preview-state").textContent = "Repair declined";
    else if (!present && approved)
      el("preview-state").textContent = "Approved. Repair pending";
    el("preview-state").className =
      "chip mobile-state " +
      (present ? "ok" : declined || verdict === "MISMATCH" ? "bad" : "warn");
    el("preview-review").textContent = present
      ? "Access confirmed"
      : declined
        ? "Review again"
        : approved
          ? "Check repair"
          : "Review repair";
    el("preview-review").disabled = present;
    motion(el("case-content"), [{ opacity: 0 }, { opacity: 1 }], 140);
  }
  async function select(c) {
    setMobileQueueOpen(false);
    selected = c.caseId;
    const run = ++caseRun;
    for (const tab of el("case-list").querySelectorAll("[role=tab]")) {
      const active = tab.dataset.caseId === selected;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    labelCasePanel();
    el("case-panel").dataset.state = "loading";
    el("case-panel").setAttribute("aria-busy", "true");
    visible("case-content", false);
    visible("case-error", false);
    visible("case-loading", true);
    try {
      const data = await api("/api/v1/merchant/cases/" + c.caseId);
      if (run !== caseRun) return;
      renderCase(data);
    } catch (error) {
      if (run !== caseRun) return;
      visible("case-loading", false);
      visible("case-error", true);
      el("case-panel").dataset.state = "error";
      el("case-panel").setAttribute("aria-busy", "false");
      message("case-error-text", error, "Try loading this case again.");
    }
  }
  function render() {
    const filtered = cases.filter(
        (c) => filter === "ALL" || classification(c) === filter,
      ),
      list = el("case-list");
    list.replaceChildren();
    visible("empty", !filtered.length);
    visible("case-panel", !!filtered.length);
    if (!filtered.length) {
      if (mobileViewport.matches) setMobileQueueOpen(true);
      caseRun++;
      current = null;
      el("main").dataset.state = "empty";
      const searched = filter !== "ALL" || el("search").value.trim();
      el("empty").querySelector("h3").textContent = searched
        ? "No matching cases"
        : "No cases yet";
      el("empty-text").textContent = searched
        ? ""
        : "New customer cases will appear here.";
      visible("clear-empty", !!searched);
      visible("empty-demo", !searched);
      return;
    }
    el("main").dataset.state = "ready";
    for (const c of filtered) {
      const kind = classification(c),
        button = document.createElement("button");
      button.type = "button";
      button.className = "case-choice";
      button.dataset.caseId = c.caseId;
      button.id = "case-tab-" + c.caseId;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", "case-panel");
      const avatar = document.createElement("span");
      avatar.className = "queue-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = c.caseId.slice(-2).toUpperCase();
      const content = document.createElement("span");
      content.className = "case-choice-content";
      const title = document.createElement("strong");
      title.textContent = "Case #" + c.caseId.slice(-6);
      const summary = document.createElement("span");
      summary.className = "case-choice-summary";
      summary.textContent =
        kind === "DECLINED"
          ? "Repair declined"
          : kind === "APPROVED"
            ? "Repair pending"
            : kind === "CHECK"
              ? "Verification needed"
              : kind === "REFUSED" || kind === "DECLINED"
                ? "Payment mismatch"
                : c.access === "RESTORED"
                  ? "Access present"
                  : "Access missing";
      const badge = document.createElement("span");
      badge.className =
        "chip " +
        (kind === "REFUSED" || kind === "DECLINED"
          ? "bad"
          : kind === "REVIEW"
            ? "warn"
            : kind === "RESTORED"
              ? "ok"
              : "neutral");
      badge.textContent = statusText[kind];
      content.append(title, summary, badge);
      button.append(avatar, content);
      button.onclick = () => select(c);
      list.append(button);
    }
    select(
      filtered.find((c) => c.caseId === selected) ||
        filtered.find((c) => c.caseId === directId) ||
        filtered[0],
    );
  }
  async function load() {
    const run = ++queueRun;
    caseRun++;
    el("main").dataset.state = "loading";
    visible("queue-error", false);
    visible("loading", true);
    visible("queue", false);
    try {
      const query = el("search").value.trim();
      const data = await api(
        "/api/v1/merchant/cases" +
          (query ? "?q=" + encodeURIComponent(query) : ""),
      );
      if (run !== queueRun) return;
      cases = data.cases;
      if (directId && !query && !cases.some((c) => c.caseId === directId)) {
        const direct = await api("/api/v1/merchant/cases/" + directId);
        if (run !== queueRun) return;
        cases.unshift({
          caseId: direct.caseId,
          paymentAttested: direct.paymentAttested,
          paymentVerdict: direct.evidence.latestCheck?.verdict,
          access: direct.access,
        });
      }
      visible("loading", false);
      visible("queue", true);
      render();
    } catch (error) {
      if (run !== queueRun) return;
      visible("loading", false);
      if (error?.status === 401) {
        location.href = "/merchant/login";
        return;
      }
      el("main").dataset.state = "error";
      visible("queue-error", true);
      message(
        "queue-error-text",
        error,
        "Check your connection and try again.",
      );
    }
  }
  async function closeMenu() {
    if (!menu.matches(":popover-open")) return;
    await motion(
      menu,
      [
        { opacity: 1, transform: "translateY(0)" },
        { opacity: 0, transform: "translateY(-4px)" },
      ],
      120,
    );
    if (menu.matches(":popover-open")) menu.hidePopover();
  }
  trigger.onclick = () => {
    if (menu.matches(":popover-open")) {
      closeMenu();
      return;
    }
    const r = trigger.getBoundingClientRect();
    menu.style.left =
      Math.max(12, Math.min(innerWidth - 252, r.right - 240)) + "px";
    menu.style.top = r.bottom + 6 + "px";
    menu.showPopover();
    const menuHeight = menu.getBoundingClientRect().height;
    menu.style.top =
      (r.bottom + menuHeight + 6 <= innerHeight
        ? r.bottom + 6
        : Math.max(12, r.top - menuHeight - 6)) + "px";
    motion(
      menu,
      [
        { opacity: 0, transform: "translateY(-4px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      160,
    );
  };
  menu.addEventListener("toggle", () =>
    trigger.setAttribute(
      "aria-expanded",
      String(menu.matches(":popover-open")),
    ),
  );
  for (const option of menu.querySelectorAll("[data-filter]"))
    option.onclick = async () => {
      filter = option.dataset.filter;
      el("filter-label").textContent =
        filter === "ALL" ? "All" : option.textContent.trim();
      for (const other of menu.querySelectorAll("[data-filter]"))
        other.setAttribute("aria-selected", String(other === option));
      await closeMenu();
      trigger.focus();
      render();
    };
  trigger.onkeydown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!menu.matches(":popover-open")) trigger.click();
      menu.querySelector('[aria-selected="true"]').focus();
    }
  };
  menu.onkeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu().then(() => trigger.focus());
      return;
    }
    const options = [...menu.querySelectorAll("[role=option]")],
      index = options.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      options[
        (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
          options.length
      ].focus();
    }
  };
  el("case-list").onkeydown = (event) => {
    const tabs = [...el("case-list").querySelectorAll("[role=tab]")],
      index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    let next;
    if (event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  };
  el("search-toggle").onclick = () => {
    const open = el("search-form").hidden;
    visible("search-form", open);
    el("search-toggle").setAttribute("aria-expanded", String(open));
    if (open) el("search").focus();
  };
  el("search-form").onsubmit = (event) => {
    event.preventDefault();
    history.replaceState(
      null,
      "",
      "?q=" + encodeURIComponent(el("search").value.trim()),
    );
    load();
  };
  const clear = () => {
    filter = "ALL";
    el("search").value = "";
    el("filter-label").textContent = "All";
    for (const option of menu.querySelectorAll("[data-filter]"))
      option.setAttribute(
        "aria-selected",
        String(option.dataset.filter === "ALL"),
      );
    history.replaceState(null, "", location.pathname);
    load();
  };
  el("clear").onclick = clear;
  el("clear-empty").onclick = clear;
  mobileQueueTab.onclick = () =>
    setMobileQueueOpen(mobileQueueTab.getAttribute("aria-expanded") !== "true");
  el("retry-queue").onclick = load;
  el("retry-case").onclick = () => select({ caseId: selected });
  el("preview-review").onclick = () =>
    busy(el("preview-review"), async () => {
      try {
        await window.MorrowCaseActions.review(current, el("preview-review"));
      } catch (error) {
        visible("case-error", true);
        message(
          "case-error-text",
          error,
          "The review could not be loaded. Try again.",
        );
      }
    });
  el("preview-details").onclick = () =>
    window.MorrowCaseActions.evidence(current);
  el("preview-context").onclick = () =>
    window.MorrowCaseActions.evidence(current);
  window.MorrowCaseActions.configure(async (data) => {
    const row = cases.find((c) => c.caseId === data.caseId);
    if (row) {
      row.access = data.access;
      row.paymentAttested = data.paymentAttested;
      row.paymentVerdict = data.evidence.latestCheck?.verdict;
      const decision = data.decisions.find(
        (d) =>
          d.case_version === data.caseVersion &&
          d.policy_version === data.policy.policyVersion,
      );
      row.decision = decision ? { kind: decision.kind, current: true } : null;
    }
    render();
  });
  el("sign-out").onclick = () =>
    busy(el("sign-out"), async () => {
      try {
        await api("/api/v1/merchant/session/logout", { method: "POST" });
        location.href = "/merchant/login";
      } catch (error) {
        visible("queue-error", true);
        message("queue-error-text", error, "Sign out failed. Try again.");
      }
    });
  load();
})();
