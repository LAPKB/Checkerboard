import assert from "node:assert/strict";
import { createReadStream, openSync, readSync, closeSync, statSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const [target, outputDirectory] = process.argv.slice(2);
const expectedMachines = new Map([
  ["x86_64-pc-windows-msvc", 0x8664],
  ["aarch64-pc-windows-msvc", 0xaa64],
]);
const expectedMachine = expectedMachines.get(target);
assert(expectedMachine, `Unsupported Windows target: ${target ?? "<missing>"}`);
assert(outputDirectory, "Usage: verify-windows-artifacts.mjs <target> <output-directory>");

const appPath = join(outputDirectory, "checkmate.exe");
const installerPath = join(outputDirectory, "checkmate-nsis-installer.exe");

function readAppMachine(path) {
  const descriptor = openSync(path, "r");
  try {
    const dos = Buffer.alloc(64);
    assert.equal(readSync(descriptor, dos, 0, dos.length, 0), dos.length, "Truncated DOS header");
    assert.equal(dos.readUInt16LE(0), 0x5a4d, "Checkmate app is not a PE executable");
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    assert.equal(readSync(descriptor, pe, 0, pe.length, peOffset), pe.length, "Truncated PE header");
    assert.equal(pe.readUInt32LE(0), 0x00004550, "Invalid PE signature");
    return pe.readUInt16LE(4);
  } finally {
    closeSync(descriptor);
  }
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function describe(label, path) {
  const stat = statSync(path);
  assert(stat.isFile() && stat.size > 0, `${label} is missing or empty: ${path}`);
  return { label, size: stat.size, hash: await sha256(path) };
}

const machine = readAppMachine(appPath);
assert.equal(
  machine,
  expectedMachine,
  `Checkmate PE machine is 0x${machine.toString(16)}, expected 0x${expectedMachine.toString(16)} for ${target}`,
);

const records = [
  await describe("Checkmate app", appPath),
  await describe("NSIS installer", installerPath),
];
const lines = [
  `Unsigned Windows build candidate (no trusted verifier configuration; not usable as licensed pilots): ${target}; app PE machine 0x${machine.toString(16)}`,
  ...records.map(({ label, size, hash }) => `${label}: ${size} bytes; SHA-256 ${hash}`),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Unsigned Windows build candidate: ${target}\n\n- **No trusted verifier configuration; not usable as licensed pilots.**\n- Not native Windows execution, installation, or release acceptance.\n- App PE machine: 0x${machine.toString(16)}\n${lines.slice(1).map((line) => `- ${line}`).join("\n")}\n\n`,
  );
}
