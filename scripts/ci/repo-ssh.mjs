#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function refuse() {
  console.error("Refusing SSH access for an unapproved private Git repository");
  process.exit(1);
}

const routes = new Map([
  ["git@checkmate-sdk", "git-upload-pack '/LAPKB/Launcher.git'"],
  ["git@checkmate-protocol", "git-upload-pack '/LAPKB/desktop-authorization.git'"],
]);
const args = process.argv.slice(2);
const options = [];
while (args[0] === "-o" && args[1] === "SendEnv=GIT_PROTOCOL") {
  options.push(args.shift(), args.shift());
}
if (args.length !== 2) refuse();
const [host, command] = args;
if (!routes.has(host) || routes.get(host) !== command) refuse();

const config = process.env.LAPKB_PRIVATE_SSH_CONFIG;
const ssh = process.env.LAPKB_SSH_BINARY;
if (!config?.startsWith("/") || !ssh?.startsWith("/")) refuse();
const result = spawnSync(ssh, ["-F", config, ...options, host, command], { stdio: "inherit" });
if (result.error) {
  console.error("Could not start the private-source SSH client");
  process.exit(1);
}
if (result.signal) process.exit(1);
process.exit(result.status ?? 1);
