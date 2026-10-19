import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AuthView, SeatReference, SeatStatus } from "./types";
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
  const [mountedAccountId, setMountedAccountId] = useState<string | null>(null);
  const mountedAccountIdRef = useRef<string | null>(null);
  const [seatBusy, setSeatBusy] = useState(false);
  const [seatError, setSeatError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let pending = false;
    let requestGeneration = 0;
    let watchdog: number | undefined;
    let unlisten: (() => void) | undefined;

    const applyStatus = (view: AuthView) => {
      const nextAccountId = view.accountId;
      const previousAccountId = mountedAccountIdRef.current;
      if (
        previousAccountId &&
        nextAccountId &&
        previousAccountId !== nextAccountId &&
        view.phase !== "authenticated"
      ) {
        // A correctly returned status identified a different account while no
        // verified session exists. Dispose the old tree now; only a later
        // authenticated view may mount the replacement.
        mountedAccountIdRef.current = null;
        setMountedAccountId(null);
        setAuthView(view);
        return;
      }
      if (view.phase === "authenticated" && nextAccountId) {
        if (nextAccountId !== mountedAccountIdRef.current) {
          // A verified authenticated replacement disposes the old tree and
          // mounts the fresh keyed tree in the same commit.
          mountedAccountIdRef.current = nextAccountId;
          setMountedAccountId(nextAccountId);
        }
      }
      setAuthView(view);
    };

    const clearWatchdog = () => {
      if (watchdog !== undefined) {
        window.clearTimeout(watchdog);
        watchdog = undefined;
      }
    };

    const refreshStatus = () => {
      if (!active || pending) return;

      if (watchdog === undefined) {
        watchdog = window.setTimeout(() => {
          if (!active) return;
          requestGeneration += 1;
          pending = false;
          watchdog = undefined;
          setAuthView(null);
          setAuthStatusError("The LAPKB access check timed out.");
        }, AUTH_STATUS_TIMEOUT_MS);
      }

      pending = true;
      const requestId = ++requestGeneration;
      void invoke<AuthView>("auth_status")
        .then((view) => {
          if (!active || requestId !== requestGeneration) return;
          applyStatus(view);
          setAuthStatusError(null);
          clearWatchdog();
        })
        .catch((reason: unknown) => {
          if (!active || requestId !== requestGeneration) return;
          setAuthView(null);
          setAuthStatusError(formatError(reason));
          clearWatchdog();
        })
        .finally(() => {
          if (requestId === requestGeneration) pending = false;
        });
    };

    const invalidateInFlight = () => {
      requestGeneration += 1;
      pending = false;
    };

    // The event is a wakeup only. It never carries authorization or status, so
    // an in-flight reply must be abandoned before a fresh status read starts.
    const onStatusChanged = () => {
      if (!active) return;
      invalidateInFlight();
      refreshStatus();
    };

    refreshStatus();
    void listen("auth-status-changed", onStatusChanged)
      .then((stopListening) => {
        if (!active) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        // Close the registration race where the permit completed before the
        // listener existed. A pending first read already covers this.
        refreshStatus();
      })
      .catch(() => {
        // Polling remains the fallback when event registration is unavailable.
      });

    const timer = window.setInterval(
      refreshStatus,
      AUTH_STATUS_POLL_INTERVAL_MS,
    );
    return () => {
      active = false;
      requestGeneration += 1;
      window.clearInterval(timer);
      if (watchdog !== undefined) {
        window.clearTimeout(watchdog);
      }
      unlisten?.();
    };
  }, [formatError]);

  const accountId =
    authView?.phase === "authenticated" ? authView.accountId : null;
  const unlocked = accountId !== null && accountId === mountedAccountId;

  const useHere = async (target: SeatReference | null) => {
    if (seatBusy) return;
    setSeatBusy(true);
    setSeatError(null);
    try {
      // The fenced status poll is the only view writer. A queued action reply
      // is not permission and must not overwrite a newer poll.
      await invoke<AuthView>("auth_use_here", { target });
    } catch (reason) {
      setSeatError(formatError(reason));
    } finally {
      setSeatBusy(false);
    }
  };

  const workspace = mountedAccountId ? (
    <div
      key={mountedAccountId}
      aria-hidden={!unlocked}
      inert={!unlocked}
      style={{
        display: unlocked ? "contents" : "none",
        pointerEvents: unlocked ? undefined : "none",
      }}
    >
      {children(mountedAccountId)}
    </div>
  ) : null;

  const checkingPhase = authView === null || authView.phase === "restoring";
  const showStartupShell =
    !unlocked &&
    mountedAccountId === null &&
    (checkingPhase || authStatusError !== null);
  const showLock = !unlocked && !showStartupShell;
  const header = (
    <header className="app-header">
      <div className="brand">
        <img className="brand-mark" src={logo} alt="Checkmate logo" />
        <span>
          Checkmate <small>v{buildVersion}</small>
        </span>
      </div>
    </header>
  );

  return (
    <>
      {workspace}
      {showStartupShell && (
        <div className="app-shell access-locked">
          {header}
          <main className="access-gate" aria-live="polite">
            <section className="access-card startup-card">
              <h1>Preparing Checkmate</h1>
              <p role="status">
                {authStatusError
                  ? `Could not check LAPKB access: ${authStatusError}`
                  : "Checking shared LAPKB access…"}
              </p>
              {authStatusError && (
                <button
                  className="primary-button"
                  onClick={() => void openLauncher()}
                >
                  Open Launcher
                </button>
              )}
              {launcherError && (
                <p className="access-error" role="alert">
                  {launcherError}
                </p>
              )}
            </section>
          </main>
        </div>
      )}
      {showLock && (
        <div className="app-shell access-locked">
          {header}
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
              {authView?.seat && (
                <SeatPanel
                  seat={authView.seat}
                  busy={seatBusy}
                  error={seatError}
                  onUseHere={(target) => void useHere(target)}
                />
              )}
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
      )}
    </>
  );
}

function SeatPanel({
  seat,
  busy,
  error,
  onUseHere,
}: {
  seat: SeatStatus;
  busy: boolean;
  error: string | null;
  onUseHere: (target: SeatReference | null) => void;
}) {
  if (seat.state === "acquiring" || seat.state === "pending") {
    return (
      <p className="seat-status" role="status">
        {seat.state === "acquiring"
          ? "Acquiring access on this computer…"
          : "Moving access to this computer…"}
      </p>
    );
  }
  if (seat.state === "granted") {
    return (
      <p className="seat-status" role="status">
        Access is ready for this computer.
      </p>
    );
  }
  if (seat.state === "locked") {
    return (
      <p className="seat-status" role="status">
        Access for this computer is locked. Open LAPKB Launcher to manage it.
      </p>
    );
  }

  const hidden = Math.max(0, seat.detail.totalHolders - seat.detail.holders.length);
  return (
    <div className="seat-panel">
      <p role="status">
        {seat.reason === "seat_moved"
          ? `Access for this computer moved to another computer. ${seat.detail.totalHolders} of ${seat.detail.capacity} places are reserved.`
          : `No place is free for Checkmate. ${seat.detail.totalHolders} of ${seat.detail.capacity} places are reserved.`}
      </p>
      {seat.detail.holders.length > 0 && (
        <ul className="seat-holders">
          {seat.detail.holders.map((holder) => (
            <li key={`${holder.reservationId}:${holder.generation}`}>
              <span className="seat-holder-label">{holder.deviceLabel}</span>
              <span className="seat-holder-detail">
                Generation {holder.generation}
              </span>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() =>
                  onUseHere({
                    reservation_id: holder.reservationId,
                    generation: holder.generation,
                  })
                }
              >
                Use here
              </button>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p>
          Showing {seat.detail.holders.length} of {seat.detail.totalHolders}{" "}
          reservations; {hidden} more {hidden === 1 ? "is" : "are"} not listed.
        </p>
      )}
      {seat.reason === "seat_moved" && (
        <button
          type="button"
          className="primary-button"
          disabled={busy}
          onClick={() => onUseHere(null)}
        >
          Use free capacity here
        </button>
      )}
      {error && (
        <p className="access-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
