(() => {
  const { api, el, friendlyError, setFieldError, watchField } = window.Morrow;
  const checks = {
    email: () =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el("email").value.trim())
        ? ""
        : "Enter a valid email address.",
    password: () =>
      el("password").value.length >= 8 ? "" : "Enter your password.",
  };
  for (const [id, check] of Object.entries(checks)) watchField(el(id), check);
  el("login-form").onsubmit = async (event) => {
    event.preventDefault();
    const button = el("submit");
    if (button.disabled) return;
    el("form-error").hidden = true;
    for (const [id, check] of Object.entries(checks))
      setFieldError(el(id), check());
    const invalid = el("login-form").querySelector('[aria-invalid="true"]');
    if (invalid) {
      invalid.focus();
      return;
    }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Signing in…";
    try {
      await api("/api/v1/merchant/session", {
        method: "POST",
        body: JSON.stringify({
          email: el("email").value.trim(),
          password: el("password").value,
        }),
      });
      location.href = "/merchant/cases";
    } catch (error) {
      // Backend distinguishes demo-disabled (AUTHENTICATION_REQUIRED)
      // from wrong credentials (INVALID_CREDENTIALS); do not blame the
      // password when sign-in itself is unavailable.
      if (error.status === 401 && error.message === "INVALID_CREDENTIALS") {
        setFieldError(el("password"), "Email or password is incorrect.");
        el("password").focus();
      } else if (error.status === 401) {
        el("form-error").textContent =
          "Sign-in is not available right now. Nothing was changed. Try the demo or try again later.";
        el("form-error").hidden = false;
        el("email").focus();
      } else {
        el("form-error").textContent = friendlyError(
          error,
          "Sign-in is unavailable. Try again.",
        );
        el("form-error").hidden = false;
      }
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Sign in to your workspace";
    }
  };
})();
