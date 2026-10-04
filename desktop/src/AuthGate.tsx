import { Fragment, useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

import type { AuthView } from "./types";
const AUTH_STATUS_POLL_INTERVAL_MS = 1000;
const AUTH_STATUS_TIMEOUT_MS = 2000;

interface AuthGateProps {
  buildVersion: string;
  children: (accountId: string) => ReactNode;
  formatError: (reason: unknown) => string;
  launcherError: string | null;
  logo: string;
  openLauncher: () => Promise<void>;
}

export function AuthGate({
  buildVersion,
  children,
  formatError,
  launcherError,
  logo,
  openLauncher,
}: AuthGateProps) {
  const [authView, setAuthView] = useState<AuthView | null>(null);
  const [authStatusError, setAuthStatusError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    let requestGeneration = 0;
    let pendingDeadline: number | undefined;

    const refreshStatus = () => {
      if (!active || pending) return;

      pending = true;
      const requestId = ++requestGeneration;
      const deadline = window.setTimeout(() => {
        if (!active || requestId !== requestGeneration) return;
        requestGeneration += 1;
        pending = false;
        pendingDeadline = undefined;
        setAuthView(null);
        setAuthStatusError("The LAPKB access check timed out.");
      }, AUTH_STATUS_TIMEOUT_MS);
      pendingDeadline = deadline;

      void invoke<AuthView>("auth_status")
        .then((view) => {
          if (!active || requestId !== requestGeneration) return;
          setAuthView(view);
          setAuthStatusError(null);
        })
        .catch((reason: unknown) => {
          if (!active || requestId !== requestGeneration) return;
          setAuthView(null);
          setAuthStatusError(formatError(reason));
        })
        .finally(() => {
          window.clearTimeout(deadline);
          if (pendingDeadline === deadline) pendingDeadline = undefined;
          if (requestId === requestGeneration) pending = false;
        });
    };

    refreshStatus();
    const timer = window.setInterval(
      refreshStatus,
      AUTH_STATUS_POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      requestGeneration += 1;
      window.clearInterval(timer);
      if (pendingDeadline !== undefined) {
        window.clearTimeout(pendingDeadline);
      }
    };
  }, [formatError]);

  if (authView?.phase === "authenticated" && authView.accountId) {
    return (
      <Fragment key={authView.accountId}>
        {children(authView.accountId)}
      </Fragment>
    );
  }

  return (
    <div className="app-shell access-locked">
      <header className="app-header">
        <div className="brand">
          <img className="brand-mark" src={logo} alt="Checkmate logo" />
          <span>
            Checkmate <small>v{buildVersion}</small>
          </span>
        </div>
      </header>
      <main className="access-gate" aria-live="polite">
        <section className="access-card">
          <h1>Checkmate access is locked</h1>
          <p>
            {authView?.message ??
              (authStatusError
                ? `Could not check LAPKB access: ${authStatusError}`
                : "Checking shared LAPKB access…")}
          </p>
          <p className="help-text">
            Sign in or restore your Checkmate license in LAPKB Launcher.
            Checkmate does not store sign-in credentials.
          </p>
          <button
            className="primary-button"
            onClick={() => void openLauncher()}
          >
            Open Launcher
          </button>
          {launcherError && (
            <p className="access-error" role="alert">
              {launcherError}
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
