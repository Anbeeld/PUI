#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDirectoryTransaction } = require("../extensions/pui-skill-loader/pui-extension-transaction.cjs");

const OWNED_FILES = ["core.ts", "index.ts", "package.json"];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function identityHash(manifest) {
  return sha256(JSON.stringify({
    owner: manifest.owner,
    schemaVersion: manifest.schemaVersion,
    puiVersion: manifest.puiVersion,
    files: manifest.files,
  }));
}

function defaultTarget() {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "pui-session-title");
}

const directoryTransaction = createDirectoryTransaction({
  expectedFiles: [...OWNED_FILES, "manifest.json"],
  defaultTarget,
  guardName: "pui-session-title-guard.json",
});

function configuredTarget(repoRoot) {
  const stack = JSON.parse(fs.readFileSync(path.join(repoRoot, "stack.json"), "utf8"));
  const configured = stack.sessionTitleExtension?.target;
  if (typeof configured !== "string") throw new Error("stack.json sessionTitleExtension.target is missing");
  return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function sourceFiles(repoRoot) {
  return Object.fromEntries(OWNED_FILES.map((name) => [name, path.join(repoRoot, "extensions", "pui-session-title", name)]));
}

function readManifest(target) {
  return JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
}

function verifyOwnedShape(target) {
  if (!fs.existsSync(target)) return { ok: false, reason: "missing" };
  let manifest;
  try { manifest = readManifest(target); } catch { return { ok: false, reason: "invalid-manifest" }; }
  const expectedKeys = ["files", "identityHash", "owner", "puiVersion", "schemaVersion"];
  if (manifest.owner !== "PUI" || manifest.schemaVersion !== 1 ||
      JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys) ||
      JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify([...OWNED_FILES].sort()) ||
      manifest.identityHash !== identityHash(manifest)) return { ok: false, reason: "modified" };
  const actualFiles = fs.readdirSync(target).sort();
  const expectedFiles = [...OWNED_FILES, "manifest.json"].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) return { ok: false, reason: "modified" };
  for (const name of OWNED_FILES) {
    const file = path.join(target, name);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== manifest.files[name]) return { ok: false, reason: "modified" };
  }
  return { ok: true, manifest };
}

function buildStagedExtension(repoRoot, directory, filesystem = fs) {
  filesystem.mkdirSync(directory, { recursive: true });
  const files = {};
  for (const [name, source] of Object.entries(sourceFiles(repoRoot))) {
    const content = filesystem.readFileSync(source);
    filesystem.writeFileSync(path.join(directory, name), content);
    files[name] = sha256(content);
  }
  const puiVersion = JSON.parse(filesystem.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const manifest = { owner: "PUI", schemaVersion: 1, puiVersion, files };
  manifest.identityHash = identityHash(manifest);
  filesystem.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function installExtension({ repoRoot, target = defaultTarget(), fs: filesystem = fs }) {
  if (path.basename(path.resolve(target)).toLowerCase() !== "pui-session-title") throw new Error(`Refusing unexpected extension target: ${target}`);
  if (filesystem.existsSync(target)) {
    const owned = verifyOwnedShape(target);
    if (!owned.ok) throw new Error(`Refusing to replace target that is not PUI-owned: ${target}`);
  }
  const parent = path.dirname(target);
  filesystem.mkdirSync(parent, { recursive: true });
  const staged = filesystem.mkdtempSync(path.join(parent, ".pui-session-title-stage-"));
  const backup = `${target}.replace-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    const manifest = buildStagedExtension(repoRoot, staged, filesystem);
    if (filesystem.existsSync(target)) {
      filesystem.renameSync(target, backup);
      movedExisting = true;
    }
    filesystem.renameSync(staged, target);
    if (movedExisting) filesystem.rmSync(backup, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    let cleanupError = null;
    try {
      if (filesystem.existsSync(staged)) filesystem.rmSync(staged, { recursive: true, force: true });
    } catch (cleanupFailure) { cleanupError = cleanupFailure; }
    if (movedExisting && filesystem.existsSync(backup)) {
      try {
        if (filesystem.existsSync(target)) filesystem.rmSync(target, { recursive: true, force: true });
        filesystem.renameSync(backup, target);
      } catch (restoreFailure) {
        throw new Error(`${error.message}; rollback failed: ${restoreFailure.message}`);
      }
    }
    if (cleanupError) throw cleanupError;
    throw error;
  }
}

function verifyExtension({ repoRoot, target = defaultTarget() }) {
  const owned = verifyOwnedShape(target);
  if (!owned.ok) return owned;
  const puiVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  if (owned.manifest.puiVersion !== puiVersion) return { ok: false, reason: "version-mismatch", manifest: owned.manifest };
  return { ok: true, manifest: owned.manifest };
}

function removeExtension(target = defaultTarget()) {
  const owned = verifyOwnedShape(target);
  if (!owned.ok) return { action: owned.reason === "missing" ? "absent" : "preserved", reason: owned.reason };
  fs.rmSync(target, { recursive: true });
  return { action: "removed" };
}

function main(argv) {
  const [command, argument = process.cwd(), targetArgument] = argv;
  try {
    let result;
    if (["install", "verify", "remove"].includes(command)) {
      const target = targetArgument || configuredTarget(argument);
      if (command === "install") result = installExtension({ repoRoot: argument, target });
      else if (command === "verify") result = verifyExtension({ repoRoot: argument, target });
      else result = removeExtension(target);
    } else if (command === "snapshot" || command === "restore-snapshot") {
      const repoRoot = targetArgument || process.cwd();
      const target = configuredTarget(repoRoot);
      result = command === "snapshot"
        ? directoryTransaction.snapshot(argument, target)
        : directoryTransaction.restoreSnapshot(argument, target);
    } else if (command === "spawn-guard") {
      const repoRoot = argv[3] || process.cwd();
      result = directoryTransaction.spawnGuard(__filename, argument, targetArgument, configuredTarget(repoRoot));
    } else if (command === "guard-snapshot") {
      result = directoryTransaction.guardSnapshot(argument, targetArgument, { target: argv[3], ownerFile: argv[4], transactionId: argv[5] });
    } else {
      console.error("Usage: pui-session-title-extension.js <install|verify|remove> [repo-root] [target] | <snapshot|restore-snapshot> <state-dir> [repo-root] | <spawn-guard> <state-dir> <target-version> [repo-root]");
      return 64;
    }
    const ok = result.ok !== false && result.action !== "preserved";
    (ok ? console.log : console.error)(JSON.stringify(result));
    if (command === "spawn-guard" && result.action === "not-needed") return 75;
    if (command === "spawn-guard" && result.action === "already-guarded") return 76;
    return ok ? 0 : result.action === "preserved" ? 2 : 1;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

module.exports = {
  activeTransaction: directoryTransaction.activeTransaction,
  configuredTarget,
  defaultTarget,
  guardSnapshot: directoryTransaction.guardSnapshot,
  installExtension,
  readManifest,
  removeExtension,
  restoreSnapshot: directoryTransaction.restoreSnapshot,
  snapshot: directoryTransaction.snapshot,
  spawnGuard: directoryTransaction.spawnGuard,
  verifyExtension,
  verifyOwnedShape,
};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
