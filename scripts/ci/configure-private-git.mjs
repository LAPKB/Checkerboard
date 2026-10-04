#!/usr/bin/env node
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [sdkPublic, protocolPublic, agentIdentities, sshConfig, gitConfig, knownHosts, agentSocket] = process.argv.slice(2);

function fail(message) {
  throw new Error(message);
}

function safeAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && /^[A-Za-z0-9_./:-]+$/.test(value);
}

function readPublicKey(path) {
  if (!safeAbsolutePath(path)) fail("identity paths must be absolute and shell-safe");
  const stat = lstatSync(path);
  if (!stat.isFile()) fail("identity file is not a regular file");
  const text = readFileSync(path, "utf8");
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== 1) fail("identity file must contain one public key");
  const [type, blob] = lines[0].trim().split(/\s+/, 3);
  if (!type || !blob || !/^(ssh-|ecdsa-|sk-)/.test(type)) fail("invalid public key");
  const decoded = Buffer.from(blob, "base64");
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== blob.replace(/=+$/, "")) {
    fail("invalid public key encoding");
  }
  const checked = spawnSync("ssh-keygen", ["-l", "-f", path], { stdio: "ignore" });
  if (checked.status !== 0) fail("public key failed validation");
  return `${type} ${blob}`;
}

function readAgentKeys(path) {
  if (!safeAbsolutePath(path)) fail("agent identity listing path is invalid");
  const stat = lstatSync(path);
  if (!stat.isFile()) fail("agent identity listing is not a regular file");
  return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [type, blob] = line.trim().split(/\s+/, 3);
    if (!type || !blob) fail("invalid agent identity listing");
    return `${type} ${blob}`;
  });
}

try {
  const paths = [sdkPublic, protocolPublic, agentIdentities, sshConfig, gitConfig, knownHosts, agentSocket];
  if (paths.some((path) => !safeAbsolutePath(path))) fail("all private Git paths must be absolute and shell-safe");

  const sdkKey = readPublicKey(sdkPublic);
  const protocolKey = readPublicKey(protocolPublic);
  if (sdkKey === protocolKey) fail("repository identities must be distinct");

  const expected = new Set([sdkKey, protocolKey]);
  const actual = readAgentKeys(agentIdentities);
  if (actual.length !== expected.size) fail(`SSH agent must contain exactly two identities (found ${actual.length})`);
  if (new Set(actual).size !== actual.length) fail("SSH agent contains duplicate identities");
  if (actual.some((key) => !expected.has(key))) fail("SSH agent contains an identity not associated with either repository");

  const config = (alias, identity) => `Host ${alias}\n` +
    `  HostName github.com\n` +
    `  HostKeyAlias github.com\n` +
    `  User git\n` +
    `  IdentityFile ${identity}\n` +
    `  IdentityAgent ${agentSocket}\n` +
    `  IdentitiesOnly yes\n` +
    `  StrictHostKeyChecking yes\n` +
    `  UserKnownHostsFile ${knownHosts}\n` +
    `  BatchMode yes\n` +
    `  HostKeyAlgorithms ssh-ed25519\n` +
    `  PreferredAuthentications publickey\n` +
    `  PasswordAuthentication no\n` +
    `  KbdInteractiveAuthentication no\n\n`;
  const sshText = config("checkmate-sdk", sdkPublic) +
    config("checkmate-protocol", protocolPublic) +
    `Host *\n` +
    `  IdentityAgent none\n` +
    `  IdentityFile /dev/null\n` +
    `  IdentitiesOnly yes\n` +
    `  StrictHostKeyChecking yes\n` +
    `  UserKnownHostsFile ${knownHosts}\n` +
    `  BatchMode yes\n` +
    `  HostKeyAlgorithms ssh-ed25519\n` +
    `  PasswordAuthentication no\n` +
    `  KbdInteractiveAuthentication no\n`;
  const gitText = [
    '[url "ssh://git@checkmate-sdk/LAPKB/Launcher.git"]',
    '\tinsteadOf = ssh://git@github.com/LAPKB/Launcher.git',
    '[url "ssh://git@checkmate-protocol/LAPKB/desktop-authorization.git"]',
    '\tinsteadOf = ssh://git@github.com/LAPKB/desktop-authorization.git',
    "",
  ].join("\n");
  const hostKey = "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";

  for (const [path, contents] of [[sshConfig, sshText], [gitConfig, gitText], [knownHosts, hostKey]]) {
    writeFileSync(path, contents, { flag: "wx", mode: 0o600 });
  }
} catch (error) {
  console.error(`Private Git setup refused: ${error instanceof Error ? error.message : "invalid configuration"}`);
  process.exitCode = 1;
}
