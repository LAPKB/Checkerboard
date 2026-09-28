import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  lstatSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Cannot read candidate JSON: ${path}`, { cause });
  }
}

const version = readJson(
  new URL("../../desktop/package.json", import.meta.url),
).version;
assert.equal(
  readJson(new URL("../../desktop/src-tauri/tauri.conf.json", import.meta.url))
    .productName,
  "Checkmate",
);
// Tauri 2.11.4 derives deb/RPM names with heck::AsKebabCase(productName).
const packageName = "checkmate";
const targets = {
  "x86_64-unknown-linux-gnu": { machine: 62, deb: "amd64", rpm: "x86_64" },
  "aarch64-unknown-linux-gnu": { machine: 183, deb: "arm64", rpm: "aarch64" },
};
const files = [
  "checkmate",
  "checkmate.AppImage",
  "checkmate.deb",
  "checkmate.rpm",
];
const receiptName = "candidate.json";

export function assertElf(bytes, machine) {
  assert(bytes.length >= 64, "Truncated ELF header");
  assert(
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])),
    "Not an ELF executable",
  );
  assert.equal(bytes[4], 2, "Expected a 64-bit ELF executable");
  assert.equal(bytes[5], 1, "Expected little-endian ELF");
  assert(
    [2, 3].includes(bytes.readUInt16LE(16)),
    "Expected executable or PIE ELF",
  );
  assert.equal(bytes.readUInt16LE(18), machine, "Wrong ELF architecture");
}

function header(path, size = 64) {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(size);
    assert.equal(readSync(fd, bytes, 0, size, 0), size, "Truncated artifact");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

async function describe(directory, name) {
  const path = join(directory, name);
  const info = lstatSync(path);
  assert(
    info.isFile() && !info.isSymbolicLink() && info.nlink === 1,
    "Artifact must be a regular, unlinked file",
  );
  assert(
    info.size > 0 && info.size <= 1024 * 1024 * 1024,
    "Artifact size is invalid",
  );
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return { name, bytes: info.size, sha256: hash.digest("hex") };
}

function verifyPackages(target, directory, appHash, run) {
  const expected = targets[target];
  const options = { maxBuffer: 512 * 1024 * 1024, timeout: 120000 };
  const deb = join(directory, "checkmate.deb");
  for (const [field, value] of [
    ["Package", packageName],
    ["Version", version],
    ["Architecture", expected.deb],
  ]) {
    assert.equal(
      run("dpkg-deb", ["--field", deb, field], options).toString().trim(),
      value,
      `Wrong deb ${field}`,
    );
  }
  const tar = run("dpkg-deb", ["--fsys-tarfile", deb], options);
  const debApp = run("bsdtar", ["-xOf", "-", "./usr/bin/checkmate-desktop"], {
    ...options,
    input: tar,
  });
  const rpm = join(directory, "checkmate.rpm");
  const rpmFields = run(
    "rpm",
    ["-qp", "--queryformat", "%{NAME}\n%{VERSION}\n%{ARCH}\n", rpm],
    options,
  )
    .toString()
    .trim()
    .split("\n");
  assert.deepEqual(
    rpmFields,
    [packageName, version, expected.rpm],
    "Wrong RPM identity, version or architecture",
  );
  const rpmApp = run("bsdtar", ["-xOf", rpm, "./usr/bin/checkmate-desktop"], options);
  for (const bytes of [debApp, rpmApp]) {
    assertElf(bytes, expected.machine);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      appHash,
      "Packaged app differs from the verified executable",
    );
  }
}

export async function verifyLinuxArtifacts(
  target,
  directory,
  { receiptOnly = false, run = execFileSync } = {},
) {
  const expected = targets[target];
  assert(expected, "Unsupported native Linux target");
  assert.deepEqual(
    readdirSync(directory).sort(),
    [...files, ...(receiptOnly ? [receiptName] : [])].sort(),
    "Unexpected candidate output files",
  );
  const records = [];
  for (const name of files) records.push(await describe(directory, name));
  assertElf(header(join(directory, "checkmate")), expected.machine);
  const appImage = header(join(directory, "checkmate.AppImage"));
  assertElf(appImage, expected.machine);
  assert(
    appImage.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])),
    "Not a type-2 AppImage",
  );
  assert(
    header(join(directory, "checkmate.deb"), 8).equals(
      Buffer.from("!<arch>\n"),
    ),
    "Not a Debian archive",
  );
  assert(
    header(join(directory, "checkmate.rpm"), 4).equals(
      Buffer.from([0xed, 0xab, 0xee, 0xdb]),
    ),
    "Not an RPM archive",
  );
  const receipt = {
    appId: "checkerboard",
    version,
    target,
    files: records,
    debAndRpmPayloadVerified: true,
    appImageRuntimeArchitectureVerified: true,
    appImagePayloadVerified: false,
    licenceTrustConfigured: false,
    nativeRuntimeVerified: false,
  };
  const path = join(directory, receiptName);
  if (receiptOnly) {
    const info = lstatSync(path);
    assert(
      info.isFile() && !info.isSymbolicLink() && info.size < 65536,
      "Invalid candidate receipt",
    );
    assert.deepEqual(
      readJson(path),
      receipt,
      "Exported artifacts do not match their container verification receipt",
    );
  } else {
    verifyPackages(target, directory, records[0].sha256, run);
    writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [target, directory, mode] = process.argv.slice(2);
  assert(
    target && directory && (mode === undefined || mode === "--receipt"),
    "Usage: verify-linux-artifacts.mjs <target> <output-directory> [--receipt]",
  );
  await verifyLinuxArtifacts(target, directory, {
    receiptOnly: mode === "--receipt",
  });
  console.log(
    `Verified ${target} build candidate: AppImage, deb and rpm; no configured licence trust, package installation or native runtime acceptance.`,
  );
}
