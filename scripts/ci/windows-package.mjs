// Static NSIS/PE package inspection in the existing Windows container lane.
// Neither app nor installer is executed. This is build/package evidence, not
// native runtime acceptance or a signature. A protected signer must verify the
// final installer bytes and bind this inventory in the existing signed receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, openSync, fstatSync, lstatSync, readSync, closeSync, readFileSync,
  writeFileSync, readdirSync, mkdirSync, mkdtempSync, chmodSync, rmSync, realpathSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
export const SPEC = Object.freeze({
  launcher: { product: "LAPKB Launcher", executable: "lapkb-launcher.exe", exported: "lapkb-launcher.exe", installer: "launcher-nsis-installer.exe", prefix: "src-tauri", package: "package.json" },
  checkerboard: { product: "Checkmate", executable: "checkmate-desktop.exe", exported: "checkmate.exe", installer: "checkmate-nsis-installer.exe", prefix: "desktop/src-tauri", package: "desktop/package.json" },
  bdautodial: { product: "BDautodial", executable: "bdautodial.exe", exported: "bdautodial.exe", installer: "bdautodial-nsis-installer.exe", prefix: "src-tauri", package: "package.json" },
  bestdose: { product: "BestDose", executable: "bestdose.exe", exported: "bestdose.exe", installer: "bestdose-nsis-installer.exe", prefix: "src-tauri", package: "package.json" },
  papir: { product: "Papir", executable: "papir-v3.exe", exported: "papir-v3.exe", prefix: "src-tauri", package: "package.json" },
});
const MAX_FILE = 256 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
// Microsoft RoInitialize: ComBase.dll is Windows-provided from Windows 8 /
// Server 2012 (https://learn.microsoft.com/windows/win32/api/roapi/nf-roapi-roinitialize).
const SYSTEM_LIBRARIES = new Set(("kernel32.dll kernelbase.dll ntdll.dll user32.dll advapi32.dll ole32.dll oleaut32.dll combase.dll shell32.dll shlwapi.dll gdi32.dll gdi32full.dll comdlg32.dll comctl32.dll version.dll winmm.dll ws2_32.dll secur32.dll security.dll crypt32.dll bcrypt.dll bcryptprimitives.dll ncrypt.dll uxtheme.dll dwmapi.dll d3d11.dll dxgi.dll d2d1.dll dwrite.dll imm32.dll winhttp.dll wininet.dll psapi.dll iphlpapi.dll wtsapi32.dll msimg32.dll rpcrt4.dll cfgmgr32.dll setupapi.dll powrprof.dll normaliz.dll propsys.dll mpr.dll msvcrt.dll ucrtbase.dll dbghelp.dll dbgcore.dll dnsapi.dll netapi32.dll userenv.dll windowscodecs.dll opengl32.dll hid.dll cabinet.dll urlmon.dll avrt.dll winspool.drv mswsock.dll dhcpcsvc.dll dcomp.dll shcore.dll gdiplus.dll wintrust.dll win32u.dll d3d12.dll d3dcompiler_47.dll uiautomationcore.dll oleacc.dll").split(" "));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const UNBUNDLED_MARKER = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK");
const NSIS_MARKER = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS");
export function nsisApplicationBytes(compiled) {
  // Pinned Tauri CLI 2.11.4 / bundler 2.9.4 patches the first marker for
  // NSIS, then restores the compiled PE. Derive the expected installed bytes
  // from that independent PE, never from extraction; change nothing else.
  const offset = compiled.indexOf(UNBUNDLED_MARKER);
  assert(offset >= 0, "Compiled application lacks the unbundled Tauri marker");
  const expected = Buffer.from(compiled);
  NSIS_MARKER.copy(expected, offset);
  return expected;
}
function applicationMismatch(expected, actual) {
  let first = 0; let last = Math.max(expected.length, actual.length) - 1;
  while (first <= last && expected[first] === actual[first]) first++;
  while (last >= first && expected[last] === actual[last]) last--;
  return JSON.stringify({ expectedSize: expected.length, installedSize: actual.length,
    firstDifferingOffset: first, lastDifferingOffset: last,
    expectedNsisMarkerOffset: expected.indexOf(NSIS_MARKER), installedNsisMarkerOffset: actual.indexOf(NSIS_MARKER) });
}
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
function readRegular(path, maximum = MAX_FILE) {
  const before = lstatSync(path, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size >= 0 && before.size <= BigInt(maximum), "Unsafe/oversized package file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size && opened.nlink === 1n, "File substituted while opening");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset); assert(count > 0, "Truncated package file"); offset += count; }
    const after = lstatSync(path, { bigint: true });
    assert(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mode === before.mode && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs, "Package changed while reading");
    return bytes;
  } finally { closeSync(fd); }
}
export function safeArchivePath(path) {
  assert(typeof path === "string" && path.length > 0 && Buffer.byteLength(path) <= 1024 && !/[\x00-\x1f\x7f\\:<>"|?*]/.test(path), "Unsafe NSIS entry path");
  for (const name of path.split("/")) {
    assert(name && name !== "." && name !== ".." && !/[. ]$/.test(name), "Unsafe NSIS path component");
    assert(!/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name), "Windows device entry");
  }
  return path;
}
export function peInfo(bytes) {
  const range = (offset, count) => { assert(Number.isSafeInteger(offset) && offset >= 0 && count >= 0 && offset + count <= bytes.length, "PE field out of bounds"); return offset; };
  const u16 = (offset) => bytes.readUInt16LE(range(offset, 2));
  const u32 = (offset) => bytes.readUInt32LE(range(offset, 4));
  assert(bytes.length >= 64 && u16(0) === 0x5a4d, "Missing DOS header");
  const pe = u32(60); assert(pe >= 64 && pe <= 1048576 && u32(pe) === 0x4550, "Missing PE header");
  const machine = u16(pe + 4); const sections = u16(pe + 6); const optSize = u16(pe + 20); const opt = pe + 24;
  assert(sections > 0 && sections <= 96 && optSize >= 96, "Invalid PE optional header"); range(opt, optSize);
  const magic = u16(opt);
  assert([0x14c, 0x8664, 0xaa64].includes(machine), "Unsupported PE machine");
  assert.equal(magic, machine === 0x14c ? 0x10b : 0x20b, "PE machine/optional-header architecture mismatch");
  assert(u16(pe + 22) & 0x2, "PE is not an executable image");
  const directoryStart = opt + (magic === 0x20b ? 112 : 96);
  const directoryCount = u32(directoryStart - 4); assert(directoryCount <= 32 && directoryStart + directoryCount * 8 <= opt + optSize, "Invalid PE data directories");
  const imageBase = magic === 0x20b ? bytes.readBigUInt64LE(range(opt + 24, 8)) : BigInt(u32(opt + 28));
  const mappings = [];
  for (let index = 0; index < sections; index++) { const section = opt + optSize + index * 40; range(section, 40); mappings.push({ va: u32(section + 12), size: u32(section + 16), raw: u32(section + 20) }); }
  const rva = (address, length = 1) => {
    const matches = mappings.filter((item) => address >= item.va && address + length <= item.va + item.size);
    assert.equal(matches.length, 1, "Ambiguous/out-of-bounds PE RVA");
    return range(matches[0].raw + address - matches[0].va, length);
  };
  const directory = (index) => index < directoryCount ? [u32(directoryStart + index * 8), u32(directoryStart + index * 8 + 4)] : [0, 0];
  const ascii = (address) => { const start = rva(address); let end = start; while (end < bytes.length && bytes[end] && end - start < 256) end++; assert(end < bytes.length && bytes[end] === 0 && end > start, "Invalid PE import name"); const name = bytes.subarray(start, end).toString("ascii"); assert(/^[A-Za-z0-9_.-]+$/.test(name), "Unsafe import name"); return name.toLowerCase(); };
  const imports = new Set();
  for (const [index, stride] of [[1, 20], [13, 32]]) {
    const [address, length] = directory(index); if (!address && !length) continue;
    assert(address && length >= stride && length <= 1024 * 1024, "Invalid import directory");
    let ended = false;
    for (let offset = 0; offset + stride <= length; offset += stride) {
      const entry = rva(address + offset, stride);
      if (bytes.subarray(entry, entry + stride).every((byte) => byte === 0)) { ended = true; break; }
      let name = u32(entry + (index === 1 ? 12 : 4));
      if (index === 13 && !(u32(entry) & 1)) { const relative = BigInt(name) - imageBase; assert(relative >= 0n && relative <= 0xffffffffn, "Invalid delay import VA"); name = Number(relative); }
      imports.add(ascii(name));
      assert(imports.size <= 512, "Too many PE imports");
    }
    assert(ended, "Unterminated PE import directory");
  }
  let version = null; const products = [];
  const [resourceRva, resourceSize] = directory(2);
  if (resourceRva) {
    assert(resourceSize > 0 && resourceSize <= 16 * 1024 * 1024, "Oversized resource directory");
    const base = rva(resourceRva, resourceSize);
    const nodes = new Set(); const versions = [];
    const walk = (offset, level, versionResource) => {
      assert(level <= 3 && offset + 16 <= resourceSize && !nodes.has(offset), "Malformed/cyclic PE resource tree"); nodes.add(offset);
      const node = base + offset; const count = u16(node + 12) + u16(node + 14); assert(count <= 1024 && offset + 16 + count * 8 <= resourceSize, "Resource directory out of bounds");
      for (let i = 0; i < count; i++) {
        const entry = node + 16 + i * 8; const name = u32(entry); const data = u32(entry + 4);
        const isVersion = level === 0 ? name === 16 : versionResource;
        if (data & 0x80000000) { walk(data & 0x7fffffff, level + 1, isVersion); }
        else if (isVersion) { assert(data + 16 <= resourceSize, "Version leaf out of bounds"); const address = u32(base + data); const length = u32(base + data + 4); assert(length > 0 && length <= 1024 * 1024, "Oversized version resource"); versions.push(bytes.subarray(rva(address, length), rva(address, length) + length)); }
      }
    };
    walk(0, 0, false);
    const align = (n) => (n + 3) & ~3;
    for (const blob of versions) {
      const block = (offset, limit, depth) => {
        assert(depth <= 8 && offset + 6 <= limit, "Version block out of bounds");
        const length = blob.readUInt16LE(offset); const valueLength = blob.readUInt16LE(offset + 2); const type = blob.readUInt16LE(offset + 4);
        const end = offset + length; assert(length >= 6 && end <= limit, "Invalid version block length");
        let cursor = offset + 6; const start = cursor;
        while (cursor + 2 <= end && blob.readUInt16LE(cursor) !== 0) cursor += 2;
        assert(cursor + 2 <= end, "Unterminated version key"); const key = blob.subarray(start, cursor).toString("utf16le");
        cursor = align(cursor + 2); const valueBytes = type === 1 ? valueLength * 2 : valueLength;
        assert(cursor + valueBytes <= end, "Version value out of bounds");
        if (key === "VS_VERSION_INFO") {
          assert.equal(valueBytes, 52, "Missing fixed product version"); assert.equal(blob.readUInt32LE(cursor), 0xfeef04bd, "Invalid fixed version magic");
          const ms = blob.readUInt32LE(cursor + 16); const ls = blob.readUInt32LE(cursor + 20);
          // Installer support and DLLs can have genuine four-part versions.
          // Only the app comparison below requires our canonical app version.
          const current = `${ms >>> 16}.${ms & 65535}.${ls >>> 16}${ls & 65535 ? `.${ls & 65535}` : ""}`;
          assert(version === null || version === current, "Conflicting version resources"); version = current;
        }
        if (key === "ProductName") { assert(type === 1 && valueLength > 0, "Missing product name"); const text = blob.subarray(cursor, cursor + valueBytes).toString("utf16le"); assert(text.endsWith("\0") && !text.slice(0, -1).includes("\0"), "Invalid product name"); products.push(text.slice(0, -1)); }
        cursor = align(cursor + valueBytes);
        while (cursor + 6 <= end) { const consumed = block(cursor, end, depth + 1); assert(consumed > cursor, "Nonadvancing version block"); cursor = align(consumed); }
        return end;
      };
      block(0, blob.length, 0);
    }
  }
  return { machine, version, products, imports: [...imports].sort(), dll: Boolean(u16(pe + 22) & 0x2000) };
}
function appDetails(appId, repositoryRoot) {
  const spec = SPEC[appId]; assert(spec, "Unknown app");
  const pkg = JSON.parse(readFileSync(join(repositoryRoot, spec.package), "utf8"));
  const config = JSON.parse(readFileSync(join(repositoryRoot, spec.prefix, "tauri.conf.json"), "utf8"));
  const cargo = readFileSync(join(repositoryRoot, spec.prefix, "Cargo.toml"), "utf8").split(/^\[/m)[1];
  const cargoVersion = cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  assert.match(pkg.version ?? "", /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);
  assert.equal(cargoVersion, pkg.version, "Package/Cargo version mismatch");
  assert.equal(config.version ?? pkg.version, pkg.version, "Tauri version mismatch");
  assert.equal(config.productName, spec.product, "Product mismatch");
  assert.equal(config.bundle.windows?.nsis?.installMode, "currentUser", "Installer scope must be explicit");
  return { spec, config, version: pkg.version };
}
function command(args) {
  const result = spawnSync("/usr/bin/7z", args, { encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  assert(!result.error && result.status === 0, `NSIS inspection failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
export function parseNsisListing(listing) {
  const separator = listing.indexOf("----------"); assert(separator >= 0, "Missing NSIS entry listing");
  const header = listing.slice(0, separator);
  assert(/^Type = Nsis$/m.test(header), "Not an NSIS archive");
  const solid = /^Solid = \+$/m.test(header);
  const numeric = (value, maximum, field, path) => {
    assert(typeof value === "string" && /^[0-9]+$/.test(value), `Invalid NSIS ${field}: ${path}`);
    const size = Number(value);
    assert(Number.isSafeInteger(size) && size <= maximum, `Oversized NSIS ${field}: ${path}`);
    return size;
  };
  return listing.slice(separator + 10).trim().split(/\r?\n\r?\n/).filter(Boolean).map((block) => {
    const fields = Object.create(null);
    for (const line of block.split(/\r?\n/).filter((line) => line.includes(" = "))) {
      const at = line.indexOf(" = "); const key = line.slice(0, at);
      assert(!Object.hasOwn(fields, key), "Duplicate NSIS listing field"); fields[key] = line.slice(at + 3);
    }
    safeArchivePath(fields.Path); assert(!fields["Symbolic Link"] && !fields["Hard Link"], "Link inside NSIS archive");
    const directory = fields.Folder === "+" || Boolean(fields.Attributes?.startsWith("D"));
    // 7zip estimates solid item sizes from the next item offset. Preserve
    // that distinction even for positive estimates; the final can be blank.
    const sizeIsEstimate = solid && fields.Solid === "+" && !directory;
    const size = fields.Size === "" && sizeIsEstimate ? null : numeric(fields.Size, MAX_EXPANDED, "Size", fields.Path);
    // Packed Size is optional for shared solid blocks, never a logical size.
    if (fields["Packed Size"] !== undefined && fields["Packed Size"] !== "") numeric(fields["Packed Size"], MAX_FILE, "Packed Size", fields.Path);
    return { path: fields.Path, size, sizeIsEstimate, directory };
  });
}
export function validateExtractedSizes(entries, extractedSizes) {
  let total = 0;
  for (const entry of entries.filter((entry) => !entry.directory)) {
    assert(extractedSizes.has(entry.path), "Missing extracted NSIS entry");
    const size = extractedSizes.get(entry.path);
    assert(Number.isSafeInteger(size) && size >= 0 && size <= MAX_EXPANDED, `Unsafe/oversized extracted NSIS size: ${entry.path}`);
    total += size; assert(Number.isSafeInteger(total) && total <= MAX_EXPANDED, "Extracted NSIS size exceeded");
    // Extracted bytes are authoritative for solid-offset estimates. 7zip
    // also reconstructs uninstall.exe from the stub and its encoded patch.
    if (entry.size !== null && !entry.sizeIsEstimate && entry.path.replace(/^\$INSTDIR\//, "") !== "uninstall.exe") assert.equal(size, entry.size, `Extracted size mismatch: ${entry.path}`);
  }
}
export function validatePayloadImports(payload) {
  const bundledLibraries = new Map();
  for (const file of payload.filter((file) => file.path.toLowerCase().endsWith(".dll"))) {
    const name = basename(file.path).toLowerCase();
    assert(!bundledLibraries.has(name), "Ambiguous bundled DLL name");
    bundledLibraries.set(name, file.path);
  }
  const importedSystem = new Set(); const unresolved = []; let unresolvedCount = 0;
  const diagnosticLimit = 32;
  // Inspect the entire app/DLL closure before failing, but bound the error text.
  for (const file of payload) {
    for (const library of file.imports) {
      if (SYSTEM_LIBRARIES.has(library) || /^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(library)) importedSystem.add(library);
      else {
        const bundled = bundledLibraries.get(library);
        if (!bundled || bundled.includes("/")) {
          unresolvedCount++;
          if (unresolved.length < diagnosticLimit) unresolved.push(`${file.path} -> ${library}${bundled ? ` (bundled at ${bundled})` : ""}`);
        }
      }
    }
  }
  assert.equal(unresolvedCount, 0, `Missing/root-misplaced DLL dependencies (${unresolvedCount} unresolved imports):\n${unresolved.join("\n")}${unresolvedCount > diagnosticLimit ? `\nDiagnostic output capped at ${diagnosticLimit} of ${unresolvedCount}; all payload imports were inspected.` : ""}`);
  return importedSystem;
}
export function inspectWindowsPackage({ appId, target, sourceCommit, outputDirectory, runId, runAttempt, profile, repositoryRoot = process.cwd() }) {
  assert.match(sourceCommit ?? "", /^[0-9a-f]{40}$/); assert.match(runId ?? "", /^[1-9][0-9]{0,19}$/);
  assert.match(runAttempt ?? "", /^[1-9][0-9]{0,3}$/); assert(Number(runAttempt) <= 1000);
  assert(["public-staging", "unconfigured"].includes(profile), "Unknown build profile");
  const machine = new Map([["x86_64-pc-windows-msvc", 0x8664], ["aarch64-pc-windows-msvc", 0xaa64]]).get(target); assert(machine, "Unknown Windows target");
  const { spec, config, version } = appDetails(appId, repositoryRoot);
  const output = resolve(outputDirectory); assert.equal(realpathSync(output), output, "Output path resolves through links");
  const names = readdirSync(output); const installerName = spec.installer ?? names.find((name) => name.endsWith(".exe") && name !== spec.exported);
  assert(installerName && basename(installerName) === installerName, "Missing NSIS installer");
  const installerPath = join(output, installerName); const installerBytes = readRegular(installerPath); const stub = peInfo(installerBytes);
  const appBytes = readRegular(join(output, spec.exported)); const app = peInfo(appBytes);
  assert(!app.dll, "Application executable is a DLL");
  assert.equal(app.machine, machine); assert.equal(app.version, version); assert(app.products.length > 0 && app.products.every((name) => name === spec.product), "Wrong PE product");
  const entries = parseNsisListing(command(["l", "-slt", "--", installerPath]));
  assert(entries.length > 0 && entries.length <= 8192, "NSIS entry bound exceeded");
  const seen = new Set(); let total = 0;
  for (const entry of entries) { const name = entry.path.toLowerCase(); assert(!seen.has(name), "Duplicate/case-colliding NSIS entry"); seen.add(name); if (entry.size !== null) total += entry.size; assert(total <= MAX_EXPANDED, "Expanded NSIS size exceeded"); }
  const scratchRoot = resolve("/tmp/lapkb-windows-package");
  try { mkdirSync(scratchRoot, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const rootInfo = lstatSync(scratchRoot); assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && (rootInfo.mode & 0o777) === 0o700, "Unsafe inspection root");
  const scratch = mkdtempSync(join(scratchRoot, "nsis-")); chmodSync(scratch, 0o700); const scratchInfo = lstatSync(scratch);
  try {
    command(["x", "-y", `-o${scratch}`, "--", installerPath]);
    const inventory = []; const support = []; const extracted = new Map(); const pending = [scratch]; let extractedTotal = 0;
    while (pending.length) {
      const directory = pending.pop();
      for (const name of readdirSync(directory)) {
        const path = join(directory, name); const info = lstatSync(path); assert(!info.isSymbolicLink() && (info.isDirectory() || info.nlink === 1), "Extracted reparse/link object");
        if (info.isDirectory()) { pending.push(path); continue; }
        assert(info.isFile(), "Special extracted object");
        const relative = path.slice(scratch.length + 1).split(/[\\/]/).join("/"); safeArchivePath(relative);
        const listEntry = entries.find((entry) => entry.path === relative); assert(listEntry && !listEntry.directory, "Unexpected extracted entry");
        extractedTotal += info.size; assert(Number.isSafeInteger(extractedTotal) && extractedTotal <= MAX_EXPANDED, "Extracted NSIS size exceeded");
        const bytes = readRegular(path, MAX_EXPANDED);
        extracted.set(relative, bytes);
        const record = { path: relative, size: bytes.length, sha256: sha256(bytes) };
        // NSIS plugins/bootstrap files are installer support, not x64 payload.
        if (relative.startsWith("$PLUGINSDIR/") || relative === "[NSIS].nsi" || relative.replace(/^\$INSTDIR\//, "") === "uninstall.exe") support.push(record);
        else { record.path = relative.replace(/^\$INSTDIR\//, ""); safeArchivePath(record.path); inventory.push(record); }
      }
      assert(inventory.length + support.length <= 8192, "Extracted file count exceeded");
    }
    validateExtractedSizes(entries, new Map([...extracted].map(([path, bytes]) => [path, bytes.length])));
    inventory.sort((a, b) => byteOrder(a.path, b.path)); support.sort((a, b) => byteOrder(a.path, b.path));
    assert(inventory.length > 0 && inventory.length <= 4096 && new Set(inventory.map((file) => file.path.toLowerCase())).size === inventory.length, "Payload identity is ambiguous");
    const contained = inventory.find((file) => file.path === spec.executable); assert(contained, "Real installed executable is absent");
    const bytesFor = (file) => extracted.get(file.path) ?? extracted.get(`$INSTDIR/${file.path}`);
    const expectedAppBytes = nsisApplicationBytes(appBytes); const expectedHash = sha256(expectedAppBytes);
    const mismatch = contained.sha256 === expectedHash ? "" : `: ${applicationMismatch(expectedAppBytes, bytesFor(contained))}`;
    assert.equal(contained.sha256, expectedHash, `Exported PE differs from installer-contained application after the exact Tauri NSIS marker patch${mismatch}`);
    assert.equal(contained.size, expectedAppBytes.length);
    const payloadImports = [];
    for (const file of inventory.filter((file) => /\.(exe|dll)$/i.test(file.path))) {
      const pe = peInfo(bytesFor(file)); assert.equal(pe.machine, machine, `Wrong architecture inside payload: ${file.path}`);
      payloadImports.push({ path: file.path, imports: pe.imports });
    }
    const importedSystem = validatePayloadImports(payloadImports);
    const resources = config.bundle.resources ?? {};
    for (const destination of Array.isArray(resources) ? resources.map((path) => path.replace(/^\.\.\//, "")) : Object.values(resources)) {
      safeArchivePath(destination); assert(inventory.some((file) => file.path === destination || file.path.startsWith(`${destination}/`)), `Required resource is absent: ${destination}`);
    }
    assert.equal(sha256(readRegular(installerPath)), sha256(installerBytes), "Installer changed during inspection");
    const proof = {
      schema: "lapkb-windows-package-v1", app: appId, target: `windows-${machine === 0x8664 ? "x86_64" : "aarch64"}`,
      version, sourceCommit, build: { runId, runAttempt: Number(runAttempt), profile },
      compiledApplication: { filename: spec.exported, size: appBytes.length, sha256: sha256(appBytes) },
      installer: { filename: installerName, size: installerBytes.length, sha256: sha256(installerBytes), stubMachine: stub.machine, kind: "nsis" },
      windowsPayload: { schema: "lapkb-windows-payload-v1", productName: spec.product, executable: spec.executable,
        architecture: machine === 0x8664 ? "x86_64" : "aarch64", version, installMode: "currentUser", files: inventory },
      installerSupport: support, systemLibraries: [...importedSystem].sort(),
      webView2: config.bundle.windows?.webviewInstallMode?.type ?? "downloadBootstrapper",
      osSignature: "not Authenticode signed", updaterSignature: "not signed", nativeRuntime: "not executed",
    };
    writeFileSync(join(output, "windows-package.json"), `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return proof;
  } finally {
    const after = lstatSync(scratch); if (after.dev === scratchInfo.dev && after.ino === scratchInfo.ino && after.isDirectory() && !after.isSymbolicLink()) rmSync(scratch, { recursive: true });
  }
}
export function verifyPackageProof({ appId, target, sourceCommit, outputDirectory, version, installerName, appName, profile = "public-staging" }) {
  const spec = SPEC[appId]; assert(spec, "Unknown app");
  const proof = JSON.parse(readRegular(join(outputDirectory, "windows-package.json"), 2 * 1024 * 1024).toString("utf8"));
  const architecture = target.startsWith("aarch64") || target === "windows-aarch64" ? "aarch64" : "x86_64";
  assert(["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc", "windows-x86_64", "windows-aarch64"].includes(target), "Unknown Windows target");
  assert.match(sourceCommit ?? "", /^[0-9a-f]{40}$/);
  assert.equal(proof.schema, "lapkb-windows-package-v1"); assert.equal(proof.app, appId); assert.equal(proof.target, `windows-${architecture}`);
  assert.equal(proof.version, version); assert.equal(proof.sourceCommit, sourceCommit);
  assert.match(proof.build.runId ?? "", /^[1-9][0-9]{0,19}$/);
  assert(Number.isSafeInteger(proof.build.runAttempt) && proof.build.runAttempt >= 1 && proof.build.runAttempt <= 1000);
  assert.equal(proof.build.runId, process.env.GITHUB_RUN_ID); assert.equal(proof.build.runAttempt, Number(process.env.GITHUB_RUN_ATTEMPT));
  assert.equal(proof.build.profile, profile); assert.equal(proof.installer.kind, "nsis");
  assert.equal(proof.installer.filename, installerName);
  assert.equal(proof.windowsPayload.schema, "lapkb-windows-payload-v1");
  assert.equal(proof.windowsPayload.productName, spec.product); assert.equal(proof.windowsPayload.executable, spec.executable);
  assert.equal(proof.windowsPayload.architecture, architecture); assert.equal(proof.windowsPayload.version, version); assert.equal(proof.windowsPayload.installMode, "currentUser");
  const installer = readRegular(join(outputDirectory, installerName));
  assert.equal(installer.length, proof.installer.size);
  assert.equal(sha256(installer), proof.installer.sha256);
  assert.equal(peInfo(installer).machine, proof.installer.stubMachine);
  const files = proof.windowsPayload.files;
  assert(Array.isArray(files) && files.length > 0 && files.length <= 4096, "Missing/bounded payload inventory");
  const names = new Set(); let previous = ""; let size = 0;
  for (const file of files) {
    safeArchivePath(file.path); assert(!names.has(file.path.toLowerCase()) && byteOrder(previous, file.path) < 0, "Unsorted/duplicate payload identity");
    names.add(file.path.toLowerCase()); previous = file.path;
    assert(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_EXPANDED); assert.match(file.sha256 ?? "", /^[0-9a-f]{64}$/);
    size += file.size; assert(size <= MAX_EXPANDED, "Payload inventory size exceeds bound");
  }
  const app = readRegular(join(outputDirectory, appName)); const record = files.find((file) => file.path === spec.executable);
  const compiled = proof.compiledApplication;
  assert(compiled && compiled.filename === spec.exported && appName === spec.exported
    && compiled.size === app.length && compiled.sha256 === sha256(app), "Compiled application identity differs from exported PE");
  const expected = nsisApplicationBytes(app);
  assert(record && record.size === expected.length && record.sha256 === sha256(expected), "Contained payload digest differs from the exact Tauri NSIS marker patch");
  const info = peInfo(app); assert(!info.dll, "Application executable is a DLL");
  assert.equal(info.machine, architecture === "x86_64" ? 0x8664 : 0xaa64); assert.equal(info.version, version);
  assert(info.products.length && info.products.every((name) => name === spec.product));
  return proof;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [appId, target, outputDirectory, sourceCommit, runId, runAttempt, profile] = process.argv.slice(2);
    const proof = inspectWindowsPackage({ appId, target, outputDirectory, sourceCommit, runId, runAttempt, profile });
    console.log(`Inspected actual NSIS-contained ${proof.windowsPayload.executable} ${proof.version} ${proof.target}: ${proof.windowsPayload.files.length} payload files. No Windows execution or signatures claimed.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
