"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

const UPDATE_STATUS_FILE = path.join(os.tmpdir(), "pui-update-status.json");
const UPDATE_LOCK_FILE = path.join(os.tmpdir(), "pui-update.lock");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return Boolean(error && error.code === "EPERM"); }
}

function createDirectoryTransaction({ expectedFiles, defaultTarget, guardName }) {
  const names = [...expectedFiles].sort();
  const guardFile = path.join(os.tmpdir(), guardName);

  function stateCore(state) {
    return { owner: state.owner, schemaVersion: state.schemaVersion, target: state.target, existed: state.existed, files: state.files };
  }

  function snapshot(stateDir, target = defaultTarget()) {
    const stateFile = path.join(stateDir, "state.json");
    if (fs.existsSync(stateFile)) return { ok: false, reason: "snapshot-exists", stateDir };
    fs.mkdirSync(stateDir, { recursive: true });
    const existed = fs.existsSync(target);
    const files = {};
    if (existed) {
      if (!fs.statSync(target).isDirectory() || JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(names)) {
        return { ok: false, reason: "target-shape", stateDir };
      }
      const backup = path.join(stateDir, "extension");
      fs.cpSync(target, backup, { recursive: true, errorOnExist: true });
      for (const name of names) files[name] = sha256(fs.readFileSync(path.join(backup, name)));
    }
    const state = { owner: "PUI", schemaVersion: 1, target: path.resolve(target), existed, files };
    state.identityHash = sha256(JSON.stringify(stateCore(state)));
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return { ok: true, stateDir };
  }

  function readSnapshot(stateDir, target) {
    const state = readJson(path.join(stateDir, "state.json"));
    const keys = ["existed", "files", "identityHash", "owner", "schemaVersion", "target"];
    if (!state || state.owner !== "PUI" || state.schemaVersion !== 1 || state.target !== path.resolve(target) ||
        typeof state.existed !== "boolean" || JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(keys) ||
        state.identityHash !== sha256(JSON.stringify(stateCore(state)))) return { ok: false, reason: "snapshot-invalid" };
    const snapshotNames = state.existed ? names : [];
    if (!state.files || JSON.stringify(Object.keys(state.files).sort()) !== JSON.stringify(snapshotNames)) return { ok: false, reason: "snapshot-invalid" };
    const backup = path.join(stateDir, "extension");
    if (!state.existed) return fs.existsSync(backup) ? { ok: false, reason: "snapshot-invalid" } : { ok: true, state };
    if (!fs.existsSync(backup) || JSON.stringify(fs.readdirSync(backup).sort()) !== JSON.stringify(names)) return { ok: false, reason: "snapshot-drift" };
    for (const name of names) if (sha256(fs.readFileSync(path.join(backup, name))) !== state.files[name]) return { ok: false, reason: "snapshot-drift" };
    return { ok: true, state };
  }

  function targetIsIntactOwnedDirectory(target) {
    try {
      if (!fs.statSync(target).isDirectory() || JSON.stringify(fs.readdirSync(target).sort()) !== JSON.stringify(names)) return false;
      const manifest = readJson(path.join(target, "manifest.json"));
      if (!manifest || manifest.owner !== "PUI" || manifest.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object") return false;
      const ownedNames = names.filter((name) => name !== "manifest.json");
      if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(ownedNames)) return false;
      return ownedNames.every((name) => typeof manifest.files[name] === "string" && sha256(fs.readFileSync(path.join(target, name))) === manifest.files[name]);
    } catch {
      return false;
    }
  }

  function restoreSnapshot(stateDir, target = defaultTarget()) {
    const checked = readSnapshot(stateDir, target);
    if (!checked.ok) return checked;
    if (fs.existsSync(target) && !targetIsIntactOwnedDirectory(target)) return { ok: false, reason: "target-drift", stateDir };
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    if (checked.state.existed) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(stateDir, "extension"), target, { recursive: true, errorOnExist: true });
    }
    return { ok: true, stateDir };
  }

  function activeTransaction(scriptVersion, options = {}) {
    const lock = readJson(options.lockFile || UPDATE_LOCK_FILE);
    const status = readJson(options.statusFile || UPDATE_STATUS_FILE);
    if (!lock || !status || !Number.isInteger(lock.pid) || typeof lock.id !== "string" || lock.id !== status.id || !processIsRunning(lock.pid)) return null;
    if (status.result != null || typeof status.target !== "string") return null;
    const runsThisScript = typeof status.step === "string" ? status.step === scriptVersion : status.target === scriptVersion;
    return runsThisScript ? { id: status.id, target: status.target } : null;
  }

  function removeGuardOwner(ownerFile, transactionId, stateDir) {
    const owner = ownerFile && readJson(ownerFile);
    if (owner && owner.id === transactionId && owner.stateDir === path.resolve(stateDir)) fs.unlinkSync(ownerFile);
  }

  function resolveGuard(stateDir, target, restore, options) {
    if (restore) {
      const result = restoreSnapshot(stateDir, target);
      if (!result.ok) return { ok: false, reason: `guard-${result.reason}`, stateDir };
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    removeGuardOwner(options.ownerFile, options.transactionId, stateDir);
    return { ok: true, action: restore ? "restored" : "committed" };
  }

  function guardSnapshot(stateDir, targetVersion, options = {}) {
    const target = options.target || defaultTarget();
    const statusFile = options.statusFile || UPDATE_STATUS_FILE;
    const lockFile = options.lockFile || UPDATE_LOCK_FILE;
    const initial = readJson(statusFile);
    if (!initial || typeof initial.id !== "string" || initial.target !== targetVersion || (options.transactionId && initial.id !== options.transactionId)) {
      return { ok: false, reason: "guard-status-mismatch" };
    }
    fs.writeFileSync(path.join(stateDir, "guard-ready"), `${initial.id}\n`, "utf8");
    const deadline = Date.now() + (options.timeoutMs ?? Number.POSITIVE_INFINITY);
    const graceMs = options.graceMs ?? 3000;
    const intervalMs = options.intervalMs ?? 250;
    let anomalySince = null;
    while (true) {
      const status = readJson(statusFile);
      if (status && status.id === initial.id && status.result) return resolveGuard(stateDir, target, status.result !== "success", { ...options, transactionId: initial.id });
      const lock = readJson(lockFile);
      if (lock && lock.id === initial.id && Number.isInteger(lock.pid) && processIsRunning(lock.pid)) anomalySince = null;
      else if (anomalySince === null) anomalySince = Date.now();
      else if (Date.now() - anomalySince > graceMs || Date.now() > deadline) return resolveGuard(stateDir, target, true, { ...options, transactionId: initial.id });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    }
  }

  function spawnGuard(moduleFile, stateDir, scriptVersion, target = defaultTarget()) {
    const transaction = activeTransaction(scriptVersion);
    if (!transaction) return { ok: true, action: "not-needed" };
    const existing = readJson(guardFile);
    if (existing && existing.id === transaction.id && Number.isInteger(existing.pid) && processIsRunning(existing.pid)) {
      return { ok: true, action: "already-guarded", pid: existing.pid, target: transaction.target };
    }
    if (fs.existsSync(guardFile)) fs.unlinkSync(guardFile);
    const child = spawn(process.execPath, [moduleFile, "guard-snapshot", stateDir, transaction.target, target, guardFile, transaction.id], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
    if (!Number.isInteger(child.pid)) return { ok: false, reason: "guard-spawn-failed" };
    fs.writeFileSync(guardFile, `${JSON.stringify({ id: transaction.id, pid: child.pid, stateDir: path.resolve(stateDir) })}\n`, "utf8");
    return { ok: true, action: "guard-started", pid: child.pid, target: transaction.target };
  }

  return { activeTransaction, guardSnapshot, restoreSnapshot, snapshot, spawnGuard };
}

module.exports = { createDirectoryTransaction };
