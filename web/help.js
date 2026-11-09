(() => {
  const { api, el, friendlyError, setFieldError, watchField } = window.Morrow;
  const checks = {
    "order-ref": () =>
      /^MRW-[A-Z0-9]{4,16}$/i.test(el("order-ref").value.trim())
        ? ""
        : "Enter the reference from your receipt.",
    email: () =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el("email").value.trim())
        ? ""
        : "Enter a valid email address.",
    issue: () =>
      el("issue").value.trim().length >= 5 ? "" : "Describe what went wrong.",
  };
  for (const [id, check] of Object.entries(checks)) watchField(el(id), check);
  el("help-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = el("submit");
    if (button.disabled) return;
    el("form-error").hidden = true;
    for (const [id, check] of Object.entries(checks))
      setFieldError(el(id), check());
    const invalid = el("help-form").querySelector('[aria-invalid="true"]');
    if (invalid) {
      invalid.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Checking…";
    try {
      const data = await api("/api/v1/help-requests", {
        method: "POST",
        body: JSON.stringify({
          orderRef: el("order-ref").value.trim().toUpperCase(),
          email: el("email").value.trim(),
          issue: el("issue").value.trim(),
        }),
      });
      try {
        localStorage.setItem("morrow-case-" + data.caseId, data.accessToken);
      } catch {
        el("form-error").textContent =
          "Allow site storage to reopen this case, then try again.";
        el("form-error").hidden = false;
        return;
      }
      location.href = "/help/case/" + data.caseId + "?fresh=1";
    } catch (error) {
      if (error.status === 404) {
        setFieldError(el("order-ref"), "Check this order reference.");
        setFieldError(el("email"), "Use the email from the receipt.");
        el("order-ref").focus();
      } else {
        el("form-error").textContent = friendlyError(
          error,
          "Your case couldn't be opened. Try again.",
        );
        el("form-error").hidden = false;
      }
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Check my order";
    }
  };
})();
