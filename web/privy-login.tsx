import { createRoot } from "react-dom/client";
import { useEffect, useRef, useState } from "react";
import { PrivyProvider, useModalStatus, usePrivy } from "@privy-io/react-auth";

function LoginButton({ errorNode }: { errorNode: HTMLElement }) {
  const { ready, authenticated, error, getAccessToken, login, logout } =
    usePrivy();
  const { isOpen } = useModalStatus();
  const [busy, setBusy] = useState(false);
  const exchanging = useRef(false);

  const exchangeForSession = async () => {
    if (exchanging.current) return;
    exchanging.current = true;
    setBusy(true);
    errorNode.textContent = "";
    errorNode.hidden = true;
    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("PRIVY_TOKEN_UNAVAILABLE");
      const response = await fetch("/api/v1/merchant/session/privy", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (response.status === 401) {
          errorNode.textContent =
            "This Privy account is not linked to a merchant workspace.";
          await logout().catch(() => undefined);
          return;
        }
        if (response.status === 429) {
          throw new Error("Try again in a minute.");
        }
        throw new Error(payload?.error ?? "Sign-in is unavailable.");
      }
      window.location.assign("/merchant/cases");
    } catch (error) {
      const uncertain = await fetch("/api/v1/merchant/cases", {
        cache: "no-store",
      })
        .then((response) => response.ok)
        .catch(() => false);
      if (uncertain) {
        window.location.assign("/merchant/cases");
        return;
      }
      errorNode.textContent =
        error instanceof Error && error.message.startsWith("Try again")
          ? error.message
          : "Sign-in could not finish. Try again.";
    } finally {
      errorNode.hidden = !errorNode.textContent;
      setBusy(false);
      exchanging.current = false;
    }
  };

  useEffect(() => {
    if (ready && authenticated) void exchangeForSession();
  }, [ready, authenticated]);

  useEffect(() => {
    if (error) {
      errorNode.textContent =
        "Secure sign-in could not start. Refresh and try again.";
      errorNode.hidden = false;
    }
  }, [error]);

  return (
    <button
      className="btn"
      type="button"
      disabled={!ready || busy || isOpen}
      aria-busy={busy}
      onClick={() => {
        if (authenticated) void exchangeForSession();
        else login();
      }}
    >
      {busy
        ? "Signing in…"
        : isOpen
          ? "Complete secure sign-in…"
          : ready
            ? "Continue with Privy"
            : "Loading sign-in…"}
    </button>
  );
}

export function mountPrivyLogin(
  appId: string,
  rootNode: HTMLElement,
  errorNode: HTMLElement,
) {
  createRoot(rootNode).render(
    <PrivyProvider appId={appId}>
      <LoginButton errorNode={errorNode} />
    </PrivyProvider>,
  );
}
