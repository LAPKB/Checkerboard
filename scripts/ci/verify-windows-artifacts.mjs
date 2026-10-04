import assert from "node:assert/strict";
import { readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { verifyPackageProof } from "./windows-package.mjs";

const [target, outputDirectory] = process.argv.slice(2);
assert(["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"].includes(target), "Unsupported Windows target");
assert(outputDirectory, "Missing output directory");
const sourceCommit = process.env.LAPKB_PACKAGE_SOURCE_SHA;
assert.match(sourceCommit ?? "", /^[0-9a-f]{40}$/);
const version = JSON.parse(readFileSync("desktop/package.json", "utf8")).version;
assert.deepEqual(readdirSync(outputDirectory).sort(), ["checkmate.exe", "checkmate-nsis-installer.exe", "windows-package.json"].sort(), "Unrecorded/missing Windows candidate output");
const proof = verifyPackageProof({ appId: "checkerboard", target, sourceCommit, version, outputDirectory,
  installerName: "checkmate-nsis-installer.exe", appName: "checkmate.exe" });
const lines = [
  `Checkmate Windows package candidate: ${proof.target} ${version}, source ${sourceCommit}.`,
  `Actual installer-contained ${proof.windowsPayload.executable}, version/product/PE architecture, exported hash equality, resource and DLL closure inspected in the existing packaging container.`,
  `NSIS installer: ${proof.installer.size} bytes; SHA-256 ${proof.installer.sha256}.`,
  "The build embeds the configured public staging verifier. OS Authenticode and release Minisign signatures are not asserted; native installation/unlock/runtime acceptance has not been executed.",
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${lines[0]}\n\n${lines.slice(1).map((line) => `- ${line}`).join("\n")}\n\n`);
