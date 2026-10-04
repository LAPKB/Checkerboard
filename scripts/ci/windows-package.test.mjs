// Structural fixtures are not release packages or signatures. The packaging
// container also supplies its actual generated NSIS for the positive round trip.
// Neither kind of check establishes native Windows runtime acceptance. CI only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, linkSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SPEC, inspectWindowsPackage, parseNsisListing, peInfo, safeArchivePath, verifyPackageProof } from "./windows-package.mjs";

test("solid NSIS listing keeps optional Packed Size separate from logical Size", () => {
  const listing = (size, packed = "", solid = "+") => `Type = Nsis\nSolid = ${solid}\n\n----------\nPath = app.exe\n${size === undefined ? "" : `Size = ${size}\n`}Packed Size = ${packed}\nAttributes = A\nSolid = ${solid}\n`;
  assert.equal(parseNsisListing(listing("37"))[0].size, 37);
  assert.equal(parseNsisListing(listing("0"))[0].size, 0);
  assert.equal(parseNsisListing(listing(""))[0].size, null);
  assert.throws(() => parseNsisListing(listing(undefined)), /Invalid NSIS Size/);
  assert.throws(() => parseNsisListing(listing("", "", "-")), /Invalid NSIS Size/);
  for (const size of ["-1", "1.5", "1e3", "NaN", " ", "1073741825", "9007199254740993"]) assert.throws(() => parseNsisListing(listing(size)), /NSIS Size/);
  assert.throws(() => parseNsisListing(listing("37", "not-a-size")), /NSIS Packed Size/);
});

test("generated solid NSIS preserves known and unknown-size payloads and reconstructs its uninstaller", {
  skip: process.env.LAPKB_NSIS_LISTING_FIXTURE !== "1",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "windows-package-listing-"));
  const run = (binary, args) => {
    const result = spawnSync(binary, args, { cwd: directory, encoding: "utf8", timeout: 120000,
      maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
    assert(!result.error && result.status === 0, result.error?.message ?? result.stderr);
    return result.stdout;
  };
  try {
    const files = { "first.bin": Buffer.from("first payload\n"), "second.bin": Buffer.alloc(73, 42), "last.bin": Buffer.from("last payload\n") };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
    for (const tail of ["uninstaller", "payload"]) {
      // Keep the payload-tail archive free of an uninstaller patch: 7zip can
      // reorder that patch after the payload regardless of NSIS command order.
      writeFileSync(join(directory, "fixture.nsi"), `Unicode true\nName "Listing fixture"\nOutFile "${tail}.exe"\nRequestExecutionLevel user\nSetCompressor /SOLID lzma\nInstallDir "$LOCALAPPDATA\\Listing fixture"\nSection\nSetOutPath "$INSTDIR"\nFile "first.bin"\nFile "second.bin"\n${tail === "payload" ? 'File "last.bin"\n' : 'WriteUninstaller "$INSTDIR\\uninstall.exe"\n'}SectionEnd\n${tail === "uninstaller" ? 'Section "Uninstall"\nDelete "$INSTDIR\\first.bin"\nSectionEnd\n' : ""}`);
      run("/usr/bin/makensis", ["fixture.nsi"]);
      const listing = run("/usr/bin/7z", ["l", "-slt", "--", `${tail}.exe`]);
      const fixtures = [{ name: "generated", listing }];
      if (tail === "payload") {
        // Exercise both permitted Size forms independently of this 7zip build,
        // changing only the final payload's field in its real solid listing.
        for (const size of [files["last.bin"].length, null]) fixtures.push({
          name: size === null ? "explicitly unknown Size" : "known Size", size,
          listing: listing.replace(/^(Path = last\.bin\r?\n)Size = [^\r\n]*/m, `$1Size = ${size ?? ""}`),
        });
      }
      let fixture = fixtures[0];
      try {
        run("/usr/bin/7z", ["x", "-y", `-o${tail}-extracted`, "--", `${tail}.exe`]);
        for (fixture of fixtures) {
          const entries = parseNsisListing(fixture.listing);
          const lastPath = tail === "payload" ? "last.bin" : "uninstall.exe";
          assert.deepEqual(entries.map((entry) => entry.path).sort(), ["first.bin", "second.bin", lastPath].sort());
          const last = entries.find((entry) => entry.path === lastPath);
          if (fixture.size !== undefined) assert.equal(last.size, fixture.size);
          for (const entry of entries) {
            assert(!entry.directory);
            const bytes = readFileSync(join(directory, `${tail}-extracted`, entry.path));
            assert(bytes.length <= 1024 * 1024);
            if (entry.path === "uninstall.exe") {
              assert.equal(peInfo(bytes).machine, 0x14c);
              if (entry.size !== null) assert.notEqual(bytes.length, entry.size, "Rebuilt uninstaller is not the encoded patch length");
            } else {
              assert.deepEqual(bytes, files[entry.path]);
              assert.equal(bytes.length, files[entry.path].length);
              assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(files[entry.path]).digest("hex"));
              if (entry.size !== null) assert.equal(bytes.length, entry.size);
            }
          }
        }
      } catch (error) {
        console.error(`Generated ${tail}-tail NSIS listing (${fixture.name}):\n${fixture.listing}`);
        throw error;
      }
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test("actual generated NSIS has a reproducible payload and source/run provenance", {
  skip: !process.env.LAPKB_WINDOWS_PACKAGE_OUTPUT,
}, () => {
  const outputDirectory = process.env.LAPKB_WINDOWS_PACKAGE_OUTPUT;
  const appId = process.env.LAPKB_WINDOWS_PACKAGE_APP;
  const target = process.env.LAPKB_WINDOWS_PACKAGE_TARGET;
  const sourceCommit = process.env.LAPKB_WINDOWS_PACKAGE_SOURCE;
  const profile = process.env.LAPKB_WINDOWS_PACKAGE_PROFILE;
  const spec = SPEC[appId]; assert(spec);
  const proof = JSON.parse(readFileSync(join(outputDirectory, "windows-package.json"), "utf8"));
  const args = { appId, target, sourceCommit, outputDirectory, profile, version: proof.version,
    installerName: proof.installer.filename, appName: spec.exported };
  assert.equal(proof.build.runId, process.env.GITHUB_RUN_ID);
  assert.equal(proof.build.runAttempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(proof.build.profile, profile);
  if (appId !== "launcher") {
    const config = JSON.parse(readFileSync(join(spec.prefix, "tauri.conf.json"), "utf8"));
    assert.equal(config.bundle.windows.nsis.installerHooks, "windows-install-hooks.nsh");
    const hooks = readFileSync(join(spec.prefix, "windows-install-hooks.nsh"), "utf8");
    assert(hooks.includes("!macro NSIS_HOOK_PREINSTALL"));
    assert(hooks.includes('$INSTDIR != "$LOCALAPPDATA\\${PRODUCTNAME}"'));
    assert(hooks.includes("    Abort"));
  }
  assert.deepEqual(verifyPackageProof(args), proof);
  const directory = mkdtempSync(join(tmpdir(), "windows-package-actual-"));
  const owned = lstatSync(directory);
  try {
    copyFileSync(join(outputDirectory, args.installerName), join(directory, args.installerName));
    copyFileSync(join(outputDirectory, args.appName), join(directory, args.appName));
    // Re-extract the actual package. Equality covers every resource, bundled
    // DLL, support entry and imported system library, not just the exported PE.
    const inspected = inspectWindowsPackage({ appId, target, sourceCommit, outputDirectory: directory,
      runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, profile });
    assert.deepEqual(inspected, proof);
    assert.deepEqual(verifyPackageProof({ ...args, outputDirectory: directory }), proof);
    assert.throws(() => verifyPackageProof({ ...args, outputDirectory: directory, sourceCommit: "0".repeat(40) }));
    // These are unsigned packaging bytes; no release signature/native pass is invented.
    assert.equal(proof.nativeRuntime, "not executed");
    assert.equal(proof.updaterSignature, "not signed");
  } finally {
    const after = lstatSync(directory);
    assert(after.isDirectory() && !after.isSymbolicLink() && after.dev === owned.dev && after.ino === owned.ino);
    rmSync(directory, { recursive: true });
  }
});

function pe(machine) {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64);
  const optionalSize = machine === 0x14c ? 112 : 128;
  bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(1, 70); bytes.writeUInt16LE(optionalSize, 84);
  bytes.writeUInt16LE(0x2, 86);
  bytes.writeUInt16LE(machine === 0x14c ? 0x10b : 0x20b, 88); // no resources/import directories: cannot qualify as an app
  const section = 88 + optionalSize;
  bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(256, section + 16); bytes.writeUInt32LE(256, section + 20);
  return bytes;
}
test("NSIS x86 stub is not x64 contained-app identity/version evidence", () => {
  const stub = peInfo(pe(0x14c)); assert.equal(stub.machine, 0x14c); assert.equal(stub.version, null); assert.deepEqual(stub.products, []);
  assert.equal(peInfo(pe(0x8664)).machine, 0x8664);
  const mislabeled = pe(0x14c); mislabeled.writeUInt16LE(0x8664, 68);
  assert.throws(() => peInfo(mislabeled), /architecture mismatch/);
  for (const bytes of [Buffer.from("MZ"), Buffer.alloc(64), pe(0x8664).subarray(0, 70)]) assert.throws(() => peInfo(bytes));
});
test("NSIS inventory rejects traversal, drive/ADS/device and reparse-style paths", () => {
  for (const name of ["../app.exe", "/app.exe", "C:/app.exe", "a\\app.exe", "app.exe:stream", "CON", "LPT1.txt", "folder/../app", "name.", "a//b"]) assert.throws(() => safeArchivePath(name), name);
  assert.equal(safeArchivePath("data/model.txt"), "data/model.txt");
});
test("missing package proof is not a nonempty-installer pass", () => {
  const directory = mkdtempSync(join(tmpdir(), "windows-package-test-"));
  try {
    writeFileSync(join(directory, "launcher-nsis-installer.exe"), pe(0x14c));
    assert.throws(() => verifyPackageProof({ appId: "launcher", target: "x86_64-pc-windows-msvc", sourceCommit: "a".repeat(40), outputDirectory: directory, version: "0.1.9", installerName: "launcher-nsis-installer.exe", appName: "lapkb-launcher.exe" }), /ENOENT/);
  } finally { rmSync(directory, { recursive: true }); }
});
test("proof selection rejects wrong app, source, target, version, scope, digest and missing payload", () => {
  const directory = mkdtempSync(join(tmpdir(), "windows-package-test-"));
  const installer = pe(0x14c); const app = pe(0x8664);
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const args = { appId: "launcher", target: "x86_64-pc-windows-msvc", sourceCommit: "a".repeat(40),
    outputDirectory: directory, version: "0.1.9", installerName: "launcher-nsis-installer.exe", appName: "lapkb-launcher.exe" };
  // Shape fixtures have NO version resource, actual archive or signature and
  // intentionally cannot qualify even when their structural fields match.
  const shape = { schema: "lapkb-windows-package-v1", app: "launcher", target: "windows-x86_64",
    version: "0.1.9", sourceCommit: "a".repeat(40),
    build: { runId: process.env.GITHUB_RUN_ID ?? "123", runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? "1"), profile: "public-staging" },
    installer: { kind: "nsis", filename: args.installerName, size: installer.length, sha256: digest(installer), stubMachine: 0x14c },
    windowsPayload: { schema: "lapkb-windows-payload-v1", productName: "LAPKB Launcher", executable: "lapkb-launcher.exe",
      architecture: "x86_64", version: "0.1.9", installMode: "currentUser",
      files: [{ path: "lapkb-launcher.exe", size: app.length, sha256: digest(app) }] } };
  try {
    writeFileSync(join(directory, args.installerName), installer); writeFileSync(join(directory, args.appName), app);
    for (const change of [
      (p) => { p.app = "papir"; }, (p) => { p.sourceCommit = "b".repeat(40); },
      (p) => { p.target = "windows-aarch64"; }, (p) => { p.version = "0.1.8"; },
      (p) => { p.build.profile = "unconfigured"; }, (p) => { p.build.runAttempt = 0; },
      (p) => { p.installer.sha256 = "b".repeat(64); }, (p) => { p.windowsPayload.installMode = "perMachine"; },
      (p) => { p.windowsPayload.files = []; }, (p) => { p.windowsPayload.files[0].sha256 = "b".repeat(64); },
    ]) {
      const proof = structuredClone(shape); change(proof);
      writeFileSync(join(directory, "windows-package.json"), JSON.stringify(proof));
      assert.throws(() => verifyPackageProof(args));
    }
    writeFileSync(join(directory, "windows-package.json"), JSON.stringify(shape));
    assert.throws(() => verifyPackageProof({ ...args, target: "darwin-aarch64" }), /Unknown Windows target/);
    assert.throws(() => verifyPackageProof(args)); // absent authenticated payload/version evidence
  } finally { rmSync(directory, { recursive: true }); }
});

test("substituted/hardlinked proof is rejected before consuming identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "windows-package-test-"));
  const args = { appId: "launcher", target: "x86_64-pc-windows-msvc", sourceCommit: "a".repeat(40), outputDirectory: directory, version: "0.1.9", installerName: "launcher-nsis-installer.exe", appName: "lapkb-launcher.exe" };
  try {
    writeFileSync(join(directory, "other.json"), "{}"); linkSync(join(directory, "other.json"), join(directory, "windows-package.json"));
    assert.throws(() => verifyPackageProof(args), /Unsafe/);
    rmSync(join(directory, "windows-package.json"));
    symlinkSync(join(directory, "other.json"), join(directory, "windows-package.json"));
    assert.throws(() => verifyPackageProof(args), /Unsafe/);
  } finally { rmSync(directory, { recursive: true }); }
});
