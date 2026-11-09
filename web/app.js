/* Morrow S4 frontend helpers — no framework, direct API calls only. */

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const error = new Error(
      (data && data.error) || `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.requestId = data && data.requestId;
    throw error;
  }
  return data;
}

function friendlyError(error, fallback) {
  if (error && error.status === 404)
    return window.location.pathname === "/help"
      ? "We couldn't find that order. Check the reference and email on your receipt and try again."
      : "This case is not available. Return to your cases or help page and try again.";
  if (error && error.status === 429)
    return "Too many attempts. Wait a minute and try again. Nothing was changed.";
  if (error && error.status === 401)
    return "The demo is not available right now. Nothing was changed.";
  if (error instanceof TypeError)
    return "We couldn't reach the server. Your details are still here. Try again.";
  return fallback || "Something went wrong. Nothing was changed. Try again.";
}

function el(id) {
  return document.getElementById(id);
}

function setFieldError(input, message) {
  const errorEl = document.getElementById(`${input.id}-error`);
  if (errorEl) errorEl.textContent = message || "";
  input.setAttribute("aria-invalid", message ? "true" : "false");
}

function watchField(input, validate) {
  input.addEventListener("blur", () => setFieldError(input, validate()));
  input.addEventListener("input", () => {
    if (input.getAttribute("aria-invalid") === "true")
      setFieldError(input, validate());
  });
}

function validCaseId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

async function busy(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function keepDialogFocus(dialog) {
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey)
      return;
    const targets = [
      ...dialog.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
      ),
    ].filter((node) => node.getClientRects().length > 0);
    const first = targets[0],
      last = targets.at(-1);
    if (!first) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}

const motionRuns = new WeakMap();
const dialogReturns = new WeakMap();
function motion(element, keyframes, duration = 160) {
  motionRuns.get(element)?.cancel();
  if (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    !element.animate
  )
    return Promise.resolve();
  const animation = element.animate(keyframes, {
    duration,
    easing: "cubic-bezier(0.16,1,0.3,1)",
  });
  motionRuns.set(element, animation);
  return animation.finished.catch(() => {});
}
function openDialog(dialog, returnTarget = document.activeElement) {
  motionRuns.get(dialog)?.cancel();
  dialog.classList.remove("is-closing");
  if (!dialog.open) {
    dialogReturns.set(dialog, returnTarget);
    dialog.showModal();
  }
  const sheet = window.matchMedia("(max-width: 767px)").matches;
  const offset =
    !sheet && dialog.classList.contains("evidence-drawer")
      ? "translateX(16px)"
      : sheet
        ? "translateY(16px)"
        : "translateY(8px)";
  return motion(
    dialog,
    [
      { opacity: 0, transform: offset },
      { opacity: 1, transform: "translateY(0)" },
    ],
    240,
  );
}
async function closeDialog(dialog) {
  if (dialog.dataset.locked === "true" || !dialog.open) return;
  dialog.classList.add("is-closing");
  await motion(
    dialog,
    [
      { opacity: 1, transform: "translateY(0)" },
      { opacity: 0, transform: "translateY(8px)" },
    ],
    160,
  );
  if (dialog.classList.contains("is-closing")) {
    dialog.close();
    dialog.classList.remove("is-closing");
    const target = dialogReturns.get(dialog);
    if (
      target?.isConnected &&
      !target.disabled &&
      target.getClientRects().length
    )
      target.focus({ preventScroll: true });
    else
      document
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.focus({ preventScroll: true });
  }
}
function setupDialog(dialog) {
  keepDialogFocus(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog(dialog);
  });
  for (const button of dialog.querySelectorAll("[data-close]"))
    button.onclick = () => closeDialog(dialog);
}

window.Morrow = {
  api,
  friendlyError,
  el,
  setFieldError,
  watchField,
  validCaseId,
  busy,
  keepDialogFocus,
  motion,
  openDialog,
  closeDialog,
  setupDialog,
};
