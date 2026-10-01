// @vitest-environment jsdom
import { StrictMode, act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { AuthGate } from "./AuthGate";
import type { AuthView } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const statusMock = vi.mocked(invoke) as unknown as Mock<
  (...args: unknown[]) => Promise<AuthView>
>;
const launcherMock = vi.fn<() => Promise<void>>();
const mountedAccounts: string[] = [];
const unmountedAccounts: string[] = [];

const authenticated = (accountId: string | null = "account-a"): AuthView => ({
  phase: "authenticated",
  user: accountId
    ? { subject: accountId, displayName: accountId, email: null }
    : null,
  accountId,
  message: null,
});

const signedOut = (): AuthView => ({
  phase: "signed_out",
  user: null,
  accountId: null,
  message: "Open LAPKB Launcher to sign in.",
});

const formatError = (reason: unknown) =>
  reason instanceof Error ? reason.message : "unexpected error";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const Probe = ({ accountId }: { accountId: string }) => {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    mountedAccounts.push(accountId);
    return () => {
      unmountedAccounts.push(accountId);
    };
  }, [accountId]);

  return (
    <section data-account={accountId}>
      <input
        aria-label="Unsaved draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </section>
  );
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderGate(strict = false) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const gate = (
    <AuthGate
      buildVersion="0.8.0"
      formatError={formatError}
      launcherError={null}
      logo="checkmate-logo.png"
      openLauncher={launcherMock}
    >
      {(accountId) => <Probe accountId={accountId} />}
    </AuthGate>
  );
  await act(async () => {
    root?.render(strict ? <StrictMode>{gate}</StrictMode> : gate);
  });
  await settle();
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function getInput(): HTMLInputElement {
  const input = container?.querySelector<HTMLInputElement>(
    'input[aria-label="Unsaved draft"]',
  );
  if (!input) throw new Error("Protected draft input is not mounted");
  return input;
}

async function editDraft(value: string) {
  const input = getInput();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) throw new Error("Input value setter is unavailable");
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function unmountGate() {
  if (!root) return;
  await act(async () => root?.unmount());
  root = null;
}

beforeEach(() => {
  vi.useFakeTimers();
  statusMock.mockReset();
  launcherMock.mockReset().mockResolvedValue(undefined);
  mountedAccounts.length = 0;
  unmountedAccounts.length = 0;
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
});

afterEach(async () => {
  await unmountGate();
  container?.remove();
  container = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Checkmate AuthGate rendered behavior", () => {
  it("locks and unmounts an authenticated workspace when status rejects", async () => {
    const rejectedStatus = deferred<AuthView>();
    statusMock
      .mockReturnValueOnce(Promise.resolve(authenticated("account-a")))
      .mockReturnValueOnce(rejectedStatus.promise);

    await renderGate();
    expect(mountedAccounts).toEqual(["account-a"]);

    await advance(1000);
    rejectedStatus.reject(new Error("broker unavailable"));
    await settle();

    expect(container?.querySelector("[data-account]")).toBeNull();
    expect(unmountedAccounts).toEqual(["account-a"]);
    expect(container?.textContent).toContain(
      "Could not check LAPKB access: broker unavailable",
    );
  });

  it("locks a hung status request at its two-second deadline and keeps polling singleflight", async () => {
    statusMock
      .mockReturnValueOnce(Promise.resolve(authenticated("account-a")))
      .mockImplementation(() => new Promise<AuthView>(() => undefined));

    await renderGate();
    expect(
      container?.querySelector("[data-account='account-a']"),
    ).not.toBeNull();
    expect(mountedAccounts).toEqual(["account-a"]);

    await advance(1000);
    await advance(1000);
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(
      container?.querySelector("[data-account='account-a']"),
    ).not.toBeNull();
    expect(mountedAccounts).toEqual(["account-a"]);

    await advance(1000);
    expect(container?.querySelector("[data-account]")).toBeNull();
    expect(unmountedAccounts).toEqual(["account-a"]);
    expect(container?.textContent).toContain("access check timed out");
  });

  it("ignores a positive reply that arrives after the status deadline", async () => {
    const delayedStatus = deferred<AuthView>();
    statusMock.mockReturnValue(delayedStatus.promise);
    const intervalSpy = vi.spyOn(window, "setInterval");

    await renderGate();
    const interval = intervalSpy.mock.results.find(
      (_, index) => intervalSpy.mock.calls[index]?.[1] === 1000,
    )?.value;
    if (interval === undefined)
      throw new Error("AuthGate polling interval was not installed");
    window.clearInterval(interval);

    await advance(2000);
    expect(container?.querySelector("[data-account]")).toBeNull();
    delayedStatus.resolve(authenticated("late-account"));
    await settle();

    expect(container?.querySelector("[data-account]")).toBeNull();
    expect(mountedAccounts).toEqual([]);
  });

  it("accepts B after A times out and ignores A when its positive reply arrives late", async () => {
    const requestA = deferred<AuthView>();
    const requestB = deferred<AuthView>();
    statusMock
      .mockReturnValueOnce(requestA.promise)
      .mockReturnValueOnce(requestB.promise)
      .mockResolvedValue(signedOut());

    await renderGate();
    await advance(2000);
    expect(container?.querySelector("[data-account]")).toBeNull();
    await advance(1000);
    expect(statusMock).toHaveBeenCalledTimes(2);

    requestB.resolve(authenticated("account-b"));
    await settle();
    expect(
      container?.querySelector("[data-account='account-b']"),
    ).not.toBeNull();
    expect(mountedAccounts).toEqual(["account-b"]);

    requestA.resolve(authenticated("account-a"));
    await settle();
    expect(
      container?.querySelector("[data-account='account-b']"),
    ).not.toBeNull();
    expect(container?.querySelector("[data-account='account-a']")).toBeNull();
    expect(mountedAccounts).toEqual(["account-b"]);
    expect(unmountedAccounts).toEqual([]);
  });

  it("never mounts an authenticated status without a verified accountId", async () => {
    statusMock.mockResolvedValue(authenticated(null));

    await renderGate();

    expect(container?.querySelector("[data-account]")).toBeNull();
    expect(mountedAccounts).toEqual([]);
    expect(container?.textContent).toContain("Checkmate access is locked");
  });

  it("unmounts cleanly and cannot resurrect a workspace from a pending reply", async () => {
    const delayedStatus = deferred<AuthView>();
    statusMock.mockReturnValue(delayedStatus.promise);

    await renderGate();
    expect(vi.getTimerCount()).toBe(2);
    await unmountGate();
    expect(vi.getTimerCount()).toBe(0);

    delayedStatus.resolve(authenticated("account-a"));
    await settle();

    expect(container?.querySelector("[data-account]")).toBeNull();
    expect(mountedAccounts).toEqual([]);
    expect(launcherMock).not.toHaveBeenCalled();
  });

  it("disposes A's workspace and draft when the verified account changes to B", async () => {
    let current = authenticated("account-a");
    statusMock.mockImplementation(() => Promise.resolve(current));

    await renderGate();
    await editDraft("private A draft");
    current = authenticated("account-b");
    await advance(1000);

    expect(unmountedAccounts).toEqual(["account-a"]);
    expect(container?.querySelector("[data-account='account-a']")).toBeNull();
    expect(
      container?.querySelector("[data-account='account-b']"),
    ).not.toBeNull();
    expect(getInput().value).toBe("");
    expect(mountedAccounts).toEqual(["account-a", "account-b"]);
  });

  it("ignores the disposed StrictMode effect and accepts only its active request", async () => {
    const disposedStatus = deferred<AuthView>();
    const activeStatus = deferred<AuthView>();
    statusMock
      .mockReturnValueOnce(disposedStatus.promise)
      .mockReturnValueOnce(activeStatus.promise);

    await renderGate(true);
    expect(statusMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);

    disposedStatus.resolve(authenticated("disposed-account"));
    await settle();
    expect(container?.querySelector("[data-account]")).toBeNull();

    activeStatus.resolve(authenticated("active-account"));
    await settle();
    expect(
      container?.querySelector("[data-account='active-account']"),
    ).not.toBeNull();
    expect(mountedAccounts).toEqual(["active-account", "active-account"]);
    expect(unmountedAccounts).toEqual(["active-account"]);
  });

  it("keeps the locked view's Open Launcher action wired to the app callback", async () => {
    statusMock.mockResolvedValue(signedOut());

    await renderGate();
    const button = container?.querySelector<HTMLButtonElement>(
      ".access-card button",
    );
    if (!button) throw new Error("Open Launcher button is not rendered");
    await act(async () => button.click());

    expect(launcherMock).toHaveBeenCalledOnce();
  });
});
