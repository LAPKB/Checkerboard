import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const note = process.argv.slice(2).join(" ").trim();
if (!note) {
  console.error('Usage: npm run version:change -- "Describe the completed app change"');
  process.exit(1);
}
const paths = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src/version-history.json"];
const contents = await Promise.all(paths.map((path) => readFile(new URL(path, root), "utf8")));
const [pkg, lock, tauri] = contents.slice(0, 3).map(JSON.parse);
const history = JSON.parse(contents[5]);
const current = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(current)) throw new Error(`Expected a stable major.minor.patch version; found ${current}`);
const parts = current.split(".").map(Number);
parts[2] += 1;
const next = parts.join(".");
if (lock.version !== current || lock.packages[""].version !== current || tauri.version !== current || history[0]?.version !== current) {
  throw new Error("Version fields or the latest history entry are out of sync. Align them before bumping.");
}
const replaceVersion = (text, pattern) => {
  const match = text.match(pattern);
  if (!match || match[1] !== current) throw new Error("Rust package version is out of sync.");
  return text.replace(pattern, (whole) => whole.replace(`"${current}"`, `"${next}"`));
};
const cargo = replaceVersion(contents[3], /^version = "([^"]+)"$/m);
const cargoLock = replaceVersion(contents[4], /name = "checkmate-desktop"\r?\nversion = "([^"]+)"/);
pkg.version = lock.version = lock.packages[""].version = tauri.version = next;
history.unshift({ version: next, changes: [note] });
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const outputs = [json(pkg), json(lock), json(tauri), cargo, cargoLock, json(history)];
for (let i = 0; i < paths.length; i++) await writeFile(new URL(paths[i], root), outputs[i]);
console.log(`Updated Checkmate ${current} → ${next} and added its version-history entry.`);
