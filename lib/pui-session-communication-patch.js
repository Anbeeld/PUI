#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stack = require("../stack.json");

const PACKAGE_NAME = "@agegr/pi-web";
const EXPECTED_VERSION = stack.upstream.gui.version;
const SENTINEL = "/* pui-session-communication:broker-v1 */";
const CHUNK = ".next/server/chunks/6429.js";
const SIDECAR = ".next/server/pui-session-broker.cjs";
const MANIFEST = ".next/server/.pui-session-communication.json";
const BACKUP_SUFFIX = ".pui-session-original";
const UPDATE_STATUS_FILE = path.join(os.tmpdir(), "pui-update-status.json");
const UPDATE_LOCK_FILE = path.join(os.tmpdir(), "pui-update.lock");
const UPDATE_GUARD_FILE = path.join(os.tmpdir(), "pui-session-communication-guard.json");
const ARTIFACT_TRANSACTION_DIR = ".next/server/.pui-session-communication-transaction";

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function defaultPackageRoot() { return path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@agegr", "pi-web"); }
function files(root) {
  const chunk = path.join(root, ...CHUNK.split("/"));
  return { chunk, backup: `${chunk}${BACKUP_SUFFIX}`, sidecar: path.join(root, ...SIDECAR.split("/")), manifest: path.join(root, ...MANIFEST.split("/")) };
}
function readPackage(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    if (value.name !== PACKAGE_NAME) return { ok: false, reason: "package-name-mismatch" };
    if (value.version !== EXPECTED_VERSION) return { ok: false, reason: "version-mismatch", expected: EXPECTED_VERSION, actual: value.version };
    return { ok: true };
  } catch (error) { return { ok: false, reason: "package-missing", error: error.message }; }
}

function patchText(text) {
  if (text.includes(SENTINEL)) return { ok: true, changed: false, text };
  for (const anchor of ["function B(){", "function I(a){", "function K(){", "async function P(a,b,c,d={}){"]) {
    if (text.split(anchor).length !== 2) return { ok: false, reason: "anchor-missing", anchor };
  }
  const start = text.indexOf("async function P(a,b,c,d={}){");
  const endToken = "d()}catch(a){d(a)}})},71069:";
  const end = text.indexOf(endToken, start);
  if (end < 0) return { ok: false, reason: "anchor-missing", anchor: "module-end" };
  const injection = `${SENTINEL}require("../pui-session-broker.cjs").install({SessionManager:e.SessionManager,getSession:I,startSession:P,listActive:K,pathExists:h.existsSync,realpath:G,randomUUID:g.randomUUID,invalidate:n.mD});`;
  return { ok: true, changed: true, text: text.slice(0, end) + injection + text.slice(end) };
}

function manifestCore(value) {
  return { owner: value.owner, schemaVersion: value.schemaVersion, packageName: value.packageName, packageVersion: value.packageVersion, chunk: value.chunk, sidecar: value.sidecar, originalHash: value.originalHash, patchedHash: value.patchedHash, sidecarHash: value.sidecarHash };
}
function createManifest(original, patched, sidecar) {
  const value = { owner: "PUI", schemaVersion: 1, packageName: PACKAGE_NAME, packageVersion: EXPECTED_VERSION, chunk: CHUNK, sidecar: SIDECAR, originalHash: sha256(original), patchedHash: sha256(patched), sidecarHash: sha256(sidecar) };
  value.identityHash = sha256(JSON.stringify(manifestCore(value)));
  return value;
}
function readManifest(root) {
  const file = files(root).manifest;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const expectedKeys = [...Object.keys(manifestCore(value)), "identityHash"].sort();
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys) || value.owner !== "PUI" || value.schemaVersion !== 1 || value.packageName !== PACKAGE_NAME || value.packageVersion !== EXPECTED_VERSION || value.chunk !== CHUNK || value.sidecar !== SIDECAR || value.identityHash !== sha256(JSON.stringify(manifestCore(value)))) return { ok: false, reason: "invalid-manifest" };
    return { ok: true, value };
  } catch (error) { return { ok: false, reason: "manifest-missing", error: error.message }; }
}
function desiredSidecar(repoRoot) { return fs.readFileSync(path.join(repoRoot, "assets", "pui-session-broker.cjs"), "utf8"); }

function atomicWriteFile(file, content) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.pui-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function artifactTransactionDir(root) { return path.join(root, ...ARTIFACT_TRANSACTION_DIR.split("/")); }
function transactionCore(state) { return { owner: state.owner, schemaVersion: state.schemaVersion, root: state.root, pid: state.pid, artifacts: state.artifacts }; }

function beginArtifactTransaction(root) {
  const directory = artifactTransactionDir(root);
  if (fs.existsSync(directory)) return { ok: false, reason: "transaction-exists" };
  fs.mkdirSync(directory, { recursive: false });
  try {
    const artifacts = artifactFiles(root).map((file, index) => {
      const existed = fs.existsSync(file);
      const copy = `${index}.artifact`;
      const content = existed ? fs.readFileSync(file) : null;
      if (content !== null) atomicWriteFile(path.join(directory, copy), content);
      return { file: path.resolve(file), copy, existed, hash: content === null ? null : sha256(content) };
    });
    const state = { owner: "PUI", schemaVersion: 1, root: path.resolve(root), pid: process.pid, artifacts };
    state.identityHash = sha256(JSON.stringify(transactionCore(state)));
    atomicWriteFile(path.join(directory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, directory };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    return { ok: false, reason: "transaction-snapshot-failed", error: error.message };
  }
}

function recoverArtifactTransaction(root, force = false) {
  const directory = artifactTransactionDir(root);
  if (!fs.existsSync(directory)) return { ok: true, action: "none" };
  const stateFile = path.join(directory, "state.json");
  if (!fs.existsSync(stateFile)) {
    fs.rmSync(directory, { recursive: true, force: true });
    return { ok: true, action: "discarded-incomplete-snapshot" };
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); }
  catch (error) { return { ok: false, reason: "transaction-invalid", error: error.message }; }
  if (!force && state.pid !== process.pid && Number.isInteger(state.pid) && processIsRunning(state.pid)) return { ok: false, reason: "transaction-active", pid: state.pid };
  const expected = artifactFiles(root).map((file) => path.resolve(file));
  if (state.owner !== "PUI" || state.schemaVersion !== 1 || state.root !== path.resolve(root) ||
      !Array.isArray(state.artifacts) || state.artifacts.length !== expected.length ||
      state.identityHash !== sha256(JSON.stringify(transactionCore(state))) ||
      state.artifacts.some((artifact, index) => artifact.file !== expected[index] || artifact.copy !== `${index}.artifact` || typeof artifact.existed !== "boolean")) {
    return { ok: false, reason: "transaction-invalid" };
  }
  try {
    for (const artifact of state.artifacts) {
      const copy = path.join(directory, artifact.copy);
      if (artifact.existed && (!fs.existsSync(copy) || sha256(fs.readFileSync(copy)) !== artifact.hash)) return { ok: false, reason: "transaction-drift", file: artifact.file };
      if (!artifact.existed && (artifact.hash !== null || fs.existsSync(copy))) return { ok: false, reason: "transaction-invalid", file: artifact.file };
      if (artifact.existed) atomicWriteFile(artifact.file, fs.readFileSync(copy));
      else if (fs.existsSync(artifact.file)) fs.unlinkSync(artifact.file);
    }
    fs.rmSync(directory, { recursive: true, force: true });
    return { ok: true, action: "restored" };
  } catch (error) {
    return { ok: false, reason: "transaction-restore-failed", error: error.message, transactionDir: directory };
  }
}

function mutateArtifacts(root, mutation) {
  const started = beginArtifactTransaction(root);
  if (!started.ok) return started;
  try {
    mutation();
    fs.rmSync(started.directory, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    const restored = recoverArtifactTransaction(root, true);
    return restored.ok
      ? { ok: false, reason: "write-failed", error: error.message }
      : { ok: false, reason: "write-failed-rollback-failed", error: error.message, rollbackError: restored.error || restored.reason, transactionDir: restored.transactionDir };
  }
}

function apply(repoRoot = process.cwd(), root = defaultPackageRoot()) {
  const recovered = recoverArtifactTransaction(root); if (!recovered.ok) return recovered;
  const pkg = readPackage(root); if (!pkg.ok) return pkg;
  const target = files(root);
  if (!fs.existsSync(target.chunk)) return { ok: false, reason: "chunk-missing", file: target.chunk };
  const current = fs.readFileSync(target.chunk, "utf8");
  const sidecar = desiredSidecar(repoRoot);
  if (fs.existsSync(target.manifest) || fs.existsSync(target.backup) || fs.existsSync(target.sidecar)) {
    const verified = verify(repoRoot, root);
    return verified.ok ? { ok: true, action: "already-patched", file: target.chunk } : verified;
  }
  const transformed = patchText(current);
  if (!transformed.ok || !transformed.changed) return { ok: false, reason: transformed.reason || "ownership-missing" };
  const manifest = createManifest(current, transformed.text, sidecar);
  const mutated = mutateArtifacts(root, () => {
    atomicWriteFile(target.backup, current);
    atomicWriteFile(target.sidecar, sidecar);
    atomicWriteFile(target.chunk, transformed.text);
    atomicWriteFile(target.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  });
  return mutated.ok ? { ok: true, action: "patched", file: target.chunk } : mutated;
}

function verify(repoRoot = process.cwd(), root = defaultPackageRoot()) {
  if (fs.existsSync(path.join(root, ...ARTIFACT_TRANSACTION_DIR.split("/")))) return { ok: false, reason: "transaction-pending" };
  const pkg = readPackage(root); if (!pkg.ok) return pkg;
  const target = files(root);
  const owned = readManifest(root); if (!owned.ok) return owned;
  if (![target.chunk, target.backup, target.sidecar].every(fs.existsSync)) return { ok: false, reason: "incomplete-owned-shape" };
  const original = fs.readFileSync(target.backup, "utf8");
  const current = fs.readFileSync(target.chunk, "utf8");
  const sidecar = fs.readFileSync(target.sidecar, "utf8");
  const desired = patchText(original);
  if (!desired.ok || !desired.changed || sha256(original) !== owned.value.originalHash || sha256(current) !== owned.value.patchedHash || current !== desired.text || sha256(sidecar) !== owned.value.sidecarHash || sidecar !== desiredSidecar(repoRoot)) return { ok: false, reason: "installed-drift" };
  return { ok: true, file: target.chunk };
}

function artifactFiles(root) {
  const target = files(root);
  return [target.chunk, target.backup, target.sidecar, target.manifest];
}

function snapshot(stateDir, root = defaultPackageRoot()) {
  const stateFile = path.join(stateDir, "state.json");
  if (fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-exists" };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const artifacts = artifactFiles(root).map((file, index) => {
      const existed = fs.existsSync(file);
      const copy = `${index}.artifact`;
      if (existed) fs.copyFileSync(file, path.join(stateDir, copy));
      return { file: path.resolve(file), copy, existed, hash: existed ? sha256(fs.readFileSync(file)) : null };
    });
    const core = { owner: "PUI", schemaVersion: 1, root: path.resolve(root), artifacts };
    const state = { ...core, identityHash: sha256(JSON.stringify(core)) };
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, stateDir };
  } catch (error) {
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch {}
    return { ok: false, reason: "snapshot-failed", error: error.message };
  }
}

function ownedArtifactState(root) {
  const target = files(root);
  try {
    const manifest = readManifest(root);
    if (!manifest.ok || !fs.existsSync(target.chunk) || !fs.existsSync(target.backup) || !fs.existsSync(target.sidecar)) return null;
    return {
      [target.chunk]: sha256(fs.readFileSync(target.chunk)) === manifest.value.patchedHash,
      [target.backup]: sha256(fs.readFileSync(target.backup)) === manifest.value.originalHash,
      [target.sidecar]: sha256(fs.readFileSync(target.sidecar)) === manifest.value.sidecarHash,
      [target.manifest]: true,
    };
  } catch { return null; }
}

function isKnownUnpatchedTransition(stateDir, state, root) {
  const target = files(root);
  const manifestArtifact = state.artifacts.find((item) => item.file === path.resolve(target.manifest));
  if (!manifestArtifact?.existed) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, manifestArtifact.copy), "utf8"));
    return fs.existsSync(target.chunk) && sha256(fs.readFileSync(target.chunk)) === manifest.originalHash &&
      !fs.existsSync(target.backup) && !fs.existsSync(target.sidecar) && !fs.existsSync(target.manifest);
  } catch { return false; }
}

function restoreSnapshot(stateDir, root = defaultPackageRoot()) {
  let state;
  try { state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")); }
  catch (error) { return { ok: false, reason: "snapshot-missing", error: error.message }; }
  const core = { owner: state.owner, schemaVersion: state.schemaVersion, root: state.root, artifacts: state.artifacts };
  const expected = artifactFiles(root).map((file) => path.resolve(file));
  if (state.owner !== "PUI" || state.schemaVersion !== 1 || state.root !== path.resolve(root) || sha256(JSON.stringify(core)) !== state.identityHash || !Array.isArray(state.artifacts) || JSON.stringify(state.artifacts.map((item) => item.file)) !== JSON.stringify(expected)) return { ok: false, reason: "snapshot-invalid" };
  for (const item of state.artifacts) {
    const copy = path.join(stateDir, item.copy);
    if (item.existed && (!fs.existsSync(copy) || sha256(fs.readFileSync(copy)) !== item.hash)) return { ok: false, reason: "snapshot-drift" };
  }
  const owned = ownedArtifactState(root);
  const knownUnpatched = isKnownUnpatchedTransition(stateDir, state, root);
  const snapshotHashes = new Set(state.artifacts.filter((item) => item.existed).map((item) => item.hash));
  for (const item of state.artifacts) {
    const live = fs.existsSync(item.file);
    if (item.existed) {
      // Restore only unchanged snapshot bytes or a complete PUI-owned transition.
      // A missing or otherwise changed individual artifact is user drift.
      if ((live && snapshotHashes.has(sha256(fs.readFileSync(item.file)))) || (owned && owned[item.file]) || knownUnpatched) {
        fs.mkdirSync(path.dirname(item.file), { recursive: true });
        fs.copyFileSync(path.join(stateDir, item.copy), item.file);
      }
    } else if (live && owned && owned[item.file]) {
      fs.unlinkSync(item.file);
    }
  }
  return { ok: true, stateDir };
}

function remove(root = defaultPackageRoot()) {
  const recovered = recoverArtifactTransaction(root); if (!recovered.ok) return { ...recovered, action: "preserved" };
  const target = files(root);
  if (![target.chunk, target.backup, target.sidecar, target.manifest].some(fs.existsSync)) return { ok: true, action: "absent" };
  const owned = readManifest(root);
  if (!owned.ok || ![target.chunk, target.backup, target.sidecar].every(fs.existsSync)) return { ok: false, action: "preserved", reason: owned.reason || "incomplete-owned-shape" };
  const current = fs.readFileSync(target.chunk, "utf8");
  const original = fs.readFileSync(target.backup, "utf8");
  const sidecar = fs.readFileSync(target.sidecar, "utf8");
  if (sha256(current) !== owned.value.patchedHash || sha256(original) !== owned.value.originalHash || sha256(sidecar) !== owned.value.sidecarHash) return { ok: false, action: "preserved", reason: "modified" };
  const mutated = mutateArtifacts(root, () => {
    atomicWriteFile(target.chunk, original);
    for (const file of [target.backup, target.sidecar, target.manifest]) fs.unlinkSync(file);
  });
  return mutated.ok ? { ok: true, action: "restored", file: target.chunk } : { ...mutated, action: "preserved" };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function processIsRunning(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === "EPERM"; } }
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function spawnGuard(stateDir, scriptVersion, root = defaultPackageRoot()) {
  const lock = readJson(UPDATE_LOCK_FILE), status = readJson(UPDATE_STATUS_FILE);
  if (!lock || !status || lock.id !== status.id || !processIsRunning(lock.pid) || (status.step !== scriptVersion && status.target !== scriptVersion)) return { ok: true, action: "not-needed" };
  const existing = readJson(UPDATE_GUARD_FILE);
  if (existing && existing.id === status.id && processIsRunning(existing.pid)) return { ok: true, action: "already-guarded" };
  const child = require("node:child_process").spawn(process.execPath, [__filename, "guard-snapshot", stateDir, root, status.id], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  if (!Number.isInteger(child.pid)) return { ok: false, reason: "guard-spawn-failed" };
  fs.writeFileSync(UPDATE_GUARD_FILE, JSON.stringify({ id: status.id, pid: child.pid }));
  return { ok: true, action: "guard-started", pid: child.pid };
}
function guardSnapshot(stateDir, root, transactionId) {
  fs.writeFileSync(path.join(stateDir, "guard-ready"), `${transactionId}\n`);
  while (true) {
    const status = readJson(UPDATE_STATUS_FILE), lock = readJson(UPDATE_LOCK_FILE);
    if (status && status.id === transactionId && status.result) {
      if (status.result !== "success") restoreSnapshot(stateDir, root);
      fs.rmSync(stateDir, { recursive: true, force: true });
      return { ok: true, action: status.result === "success" ? "committed" : "restored" };
    }
    if (!lock || lock.id !== transactionId || !processIsRunning(lock.pid)) {
      restoreSnapshot(stateDir, root); fs.rmSync(stateDir, { recursive: true, force: true }); return { ok: true, action: "restored" };
    }
    sleepMs(250);
  }
}

function main(argv) {
  const [command = "apply", repoRoot = process.cwd(), root = defaultPackageRoot()] = argv;
  const result = command === "apply" ? apply(repoRoot, root)
    : command === "verify" ? verify(repoRoot, root)
    : command === "remove" ? remove(repoRoot)
    : command === "snapshot" ? snapshot(repoRoot, root)
    : command === "restore-snapshot" ? restoreSnapshot(repoRoot, root)
    : command === "spawn-guard" ? spawnGuard(repoRoot, root, argv[3] || defaultPackageRoot())
    : command === "guard-snapshot" ? guardSnapshot(repoRoot, root, argv[3])
    : { ok: false, reason: "usage" };
  (result.ok ? console.log : console.error)(JSON.stringify(result));
  if (command === "spawn-guard" && result.action === "not-needed") return 75;
  if (command === "spawn-guard" && result.action === "already-guarded") return 76;
  return result.ok ? 0 : command === "remove" && result.action === "preserved" ? 2 : 1;
}

module.exports = { BACKUP_SUFFIX, CHUNK, EXPECTED_VERSION, MANIFEST, SENTINEL, SIDECAR, apply, beginArtifactTransaction, createManifest, defaultPackageRoot, guardSnapshot, patchText, recoverArtifactTransaction, remove, restoreSnapshot, snapshot, spawnGuard, verify };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
