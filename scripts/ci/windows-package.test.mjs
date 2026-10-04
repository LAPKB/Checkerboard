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
import { SPEC, inspectWindowsPackage, parseNsisListing, peInfo, safeArchivePath, validateExtractedSizes, verifyPackageProof } from "./windows-package.mjs";

test("solid NSIS listing keeps optional Packed Size separate from logical Size", () => {
  const listing = (size, packed = "", solid = "+") => `Type = Nsis\nSolid = ${solid}\n\n----------\nPath = app.exe\n${size === undefined ? "" : `Size = ${size}\n`}Packed Size = ${packed}\nAttributes = A\nSolid = ${solid}\n`;
  assert.equal(parseNsisListing(listing("37"))[0].size, 37);
  assert.equal(parseNsisListing(listing("37"))[0].sizeIsEstimate, true);
  assert.equal(parseNsisListing(listing("37", "", "-"))[0].sizeIsEstimate, false);
  assert.equal(parseNsisListing(listing("0"))[0].size, 0);
  assert.equal(parseNsisListing(listing(""))[0].size, null);
  assert.throws(() => parseNsisListing(listing(undefined)), /Invalid NSIS Size/);
  assert.throws(() => parseNsisListing(listing("", "", "-")), /Invalid NSIS Size/);
  for (const size of ["-1", "1.5", "1e3", "NaN", " ", "1073741825", "9007199254740993"]) assert.throws(() => parseNsisListing(listing(size)), /NSIS Size/);
  assert.throws(() => parseNsisListing(listing("37", "not-a-size")), /NSIS Packed Size/);
});

test("extracted NSIS sizes distinguish solid estimates from exact lengths and retain bounds/closure", () => {
  const path = "$PLUGINSDIR/StartMenu.dll";
  const listing = (archiveSolid, itemSolid, size = "20996") => `Type = Nsis\nSolid = ${archiveSolid}\n\n----------\nPath = ${path}\nSize = ${size}\nAttributes = A\nSolid = ${itemSolid}\n`;
  const estimated = parseNsisListing(listing("+", "+"));
  const actual = new Map([[path, 12288]]);
  assert.equal(estimated[0].size, 20996);
  assert.equal(estimated[0].sizeIsEstimate, true);
  validateExtractedSizes(estimated, actual); // The concrete StartMenu.dll failure.
  validateExtractedSizes(parseNsisListing(listing("+", "+", "")), actual);
  validateExtractedSizes(parseNsisListing(listing("-", "-", "12288")), actual);
  for (const [archiveSolid, itemSolid] of [["-", "-"], ["-", "+"], ["+", "-"], ["+", ""]]) {
    const exact = parseNsisListing(listing(archiveSolid, itemSolid));
    assert.equal(exact[0].sizeIsEstimate, false);
    assert.throws(() => validateExtractedSizes(exact, actual), /Extracted size mismatch/);
    assert.throws(() => parseNsisListing(listing(archiveSolid, itemSolid, "")), /Invalid NSIS Size/);
  }
  for (const size of [-1, 1.5, NaN, 1073741825, 9007199254740992]) {
    assert.throws(() => validateExtractedSizes(estimated, new Map([[path, size]])), /Unsafe\/oversized extracted NSIS size/);
  }
  const two = [...estimated, { ...estimated[0], path: "support.bin" }];
  assert.throws(() => validateExtractedSizes(two, new Map([[path, 536870913], ["support.bin", 536870913]])), /Extracted NSIS size exceeded/);
  assert.throws(() => validateExtractedSizes(estimated, new Map()), /Missing extracted NSIS entry/);
  // Non-solid uninstall.exe still describes an encoded patch, not its rebuilt PE.
  validateExtractedSizes(parseNsisListing(listing("-", "-").replace(path, "$INSTDIR/uninstall.exe")), new Map([["$INSTDIR/uninstall.exe", 12288]]));
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
    const pluginPath = "$PLUGINSDIR/StartMenu.dll"; const supportPath = "$PLUGINSDIR/fixture-support.bin";
    const support = { [pluginPath]: readFileSync("/usr/share/nsis/Plugins/x86-unicode/StartMenu.dll"),
      [supportPath]: Buffer.from("genuine installer support fixture\n") };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(directory, name), bytes);
    writeFileSync(join(directory, "support.bin"), support[supportPath]);
    for (const tail of ["uninstaller", "payload"]) {
      // Keep the previously passing uninstaller construction free of plugins
      // and support files. Exercise the stock Unicode plugin's real command
      // only in the payload-tail archive, without an uninstaller patch.
      const pluginInstructions = tail === "payload" ? 'InitPluginsDir\nSetOutPath "$PLUGINSDIR"\nFile /oname=fixture-support.bin "support.bin"\nStartMenu::Init /autoadd "Listing fixture"\nPop $0\n' : "";
      writeFileSync(join(directory, "fixture.nsi"), `Unicode true\nName "Listing fixture"\nOutFile "${tail}.exe"\nRequestExecutionLevel user\nSetCompressor /SOLID lzma\nInstallDir "$LOCALAPPDATA\\Listing fixture"\nSection\n${pluginInstructions}SetOutPath "$INSTDIR"\nFile "first.bin"\nFile "second.bin"\n${tail === "payload" ? 'File "last.bin"\n' : 'WriteUninstaller "$INSTDIR\\uninstall.exe"\n'}SectionEnd\n${tail === "uninstaller" ? 'Section "Uninstall"\nDelete "$INSTDIR\\first.bin"\nSectionEnd\n' : ""}`);
      run("/usr/bin/makensis", ["fixture.nsi"]);
      const listing = run("/usr/bin/7z", ["l", "-slt", "--", `${tail}.exe`]);
      const fixtures = [{ name: "generated", listing }];
      if (tail === "payload") {
        fixtures.push({ name: "positive solid plugin estimate", pluginSize: 20996,
          listing: listing.replace(/^(Path = \$PLUGINSDIR\/StartMenu\.dll\r?\n)Size = [^\r\n]*/m, "$1Size = 20996"),
        });
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
          const expectedPaths = tail === "payload"
            ? ["first.bin", "second.bin", "last.bin", pluginPath, supportPath]
            : ["first.bin", "second.bin", "uninstall.exe"];
          assert.deepEqual(entries.map((entry) => entry.path).sort(), expectedPaths.sort());
          const last = entries.find((entry) => entry.path === lastPath);
          if (fixture.size !== undefined) assert.equal(last.size, fixture.size);
          if (tail === "payload") {
            const plugin = entries.find((entry) => entry.path === pluginPath);
            assert.equal(plugin.sizeIsEstimate, true);
            if (fixture.pluginSize !== undefined) assert.equal(plugin.size, fixture.pluginSize);
          }
          const extractedSizes = new Map();
          for (const entry of entries) {
            assert(!entry.directory);
            const bytes = readFileSync(join(directory, `${tail}-extracted`, entry.path));
            assert(bytes.length <= 1024 * 1024);
            extractedSizes.set(entry.path, bytes.length);
            if (entry.path === "uninstall.exe") {
              assert.equal(peInfo(bytes).machine, 0x14c);
              if (entry.size !== null) assert.notEqual(bytes.length, entry.size, "Rebuilt uninstaller is not the encoded patch length");
            } else {
              const input = files[entry.path] ?? support[entry.path]; assert(input, "Missing genuine fixture input");
              assert.deepEqual(bytes, input);
              assert.equal(bytes.length, input.length);
              assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(input).digest("hex"));
            }
          }
          validateExtractedSizes(entries, extractedSizes);
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
