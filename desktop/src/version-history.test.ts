import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import lock from "../package-lock.json";
import tauri from "../src-tauri/tauri.conf.json";
import cargo from "../src-tauri/Cargo.toml?raw";
import cargoLock from "../src-tauri/Cargo.lock?raw";
import history from "./version-history.json";
import { appVersion, VersionHistoryButton, VersionHistoryDialog } from "./VersionHistory";

describe("app version history", () => {
  it("keeps the displayed, packaged and latest documented versions aligned", () => {
    expect([appVersion, lock.version, lock.packages[""].version, tauri.version, history[0].version,
      cargo.match(/^version = "([^"]+)"$/m)?.[1],
      cargoLock.match(/name = "checkmate-desktop"\nversion = "([^"]+)"/)?.[1],
    ]).toEqual(Array(7).fill(pkg.version));
    expect(new Set(history.map((entry) => entry.version)).size).toBe(history.length);
    expect(history.every((entry) => entry.changes.length > 0 && entry.changes.every((note) => note.trim().length > 0))).toBe(true);
  });

  it("provides a version button and a labeled dialog containing every recorded version", () => {
    const button = renderToStaticMarkup(createElement(VersionHistoryButton));
    expect(button).toContain(`v${pkg.version}`);
    expect(button).toContain('aria-haspopup="dialog"');
    const dialog = renderToStaticMarkup(createElement(VersionHistoryDialog, { close: () => {} }));
    expect(dialog).toContain('aria-labelledby="version-history-title"');
    for (const entry of history) expect(dialog).toContain(`Version ${entry.version}`);
    expect(dialog).toContain("Close version history");
  });
});
