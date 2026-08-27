"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

const extensionRoot = process.env.PUI_UPDATE_EXTENSION_DIR || path.join(os.homedir(), ".pi", "agent", "extensions", "pui-update");
const manifestFile = path.join(extensionRoot, "manifest.json");

function installed() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.owner !== "PUI" || !/^\d+\.\d+\.\d+$/.test(manifest.puiVersion || "")) throw new Error("Installed PUI identity is invalid");
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, puiVersion: manifest.puiVersion, managed: manifest.managed, files: manifest.files };
  const expected = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
  if (manifest.identityHash !== expected) throw new Error("Installed PUI identity was modified");
  return manifest;
}

function updater() {
  return require(path.join(extensionRoot, "updater.js"));
}

function newerThan(candidate, current) {
  if (!/^\d+\.\d+\.\d+$/.test(candidate || "")) return false;
  const left = candidate.split(".").map(Number);
  const right = current.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function activeTransaction(lockFile, status) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (!Number.isInteger(lock.pid) || lock.pid <= 0 || lock.id !== status.id) return false;
    process.kill(lock.pid, 0);
    return true;
  } catch { return false; }
}

function statusMatchesInstalled(status, installedVersion, lockFile) {
  if (status.result === "success") return status.target === installedVersion;
  if (status.result === "rolled-back") return status.restored === installedVersion;
  if (status.result === "aborted") return newerThan(status.target, installedVersion);
  if (status.result === "recovery-required") return true;
  if (status.result) return false;
  return activeTransaction(lockFile, status);
}

async function getUpdate() {
  try {
    const manifest = installed();
    const { LOCK_FILE, STATUS_FILE, chooseStableUpdate } = updater();
    if (fs.existsSync(STATUS_FILE)) {
      const statusText = fs.readFileSync(STATUS_FILE, "utf8");
      const status = JSON.parse(statusText);
      // Restart statuses have no target; pass them through so the restart poller can show progress and outcomes.
      if (!status.target && (status.phase === "restarting" || status.result === "restarted" || (status.phase === "failed" && status.result === "failed"))) {
        return { ...status, currentVersion: manifest.puiVersion };
      }
      if (status.target && statusMatchesInstalled(status, manifest.puiVersion, LOCK_FILE)) return { ...status, currentVersion: manifest.puiVersion };
      if (fs.readFileSync(STATUS_FILE, "utf8") === statusText) fs.unlinkSync(STATUS_FILE);
    }
    const response = await fetch("https://api.github.com/repos/Anbeeld/PUI/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "PUI update bridge" },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    const release = await response.json();
    const latestVersion = chooseStableUpdate(manifest.puiVersion, release, null);
    return {
      currentVersion: manifest.puiVersion,
      latestVersion: latestVersion || manifest.puiVersion,
      updateAvailable: Boolean(latestVersion),
      releaseUrl: latestVersion ? `https://github.com/Anbeeld/PUI/releases/tag/v${latestVersion}` : "",
    };
  } catch (error) {
    return { updateAvailable: false, error: error.message };
  }
}

async function startUpdate(target) {
  const manifest = installed();
  const response = await fetch("https://api.github.com/repos/Anbeeld/PUI/releases/latest", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "PUI update bridge" },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const release = await response.json();
  const { chooseStableUpdate, spawnDetached } = updater();
  const advertised = chooseStableUpdate(manifest.puiVersion, release, null);
  if (!advertised || advertised !== target) throw new Error("Advertised update changed; check again before installing");
  return { accepted: true, target, pid: spawnDetached(target) };
}

function acknowledge() {
  const { STATUS_FILE } = updater();
  if (!fs.existsSync(STATUS_FILE)) return { acknowledged: true };
  const status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  if (["success", "rolled-back", "aborted"].includes(status.result)) fs.unlinkSync(STATUS_FILE);
  return { acknowledged: true };
}

const RESTART_BUSY_MS = 5 * 60 * 1000;

// A status without a result means work is in flight: an apply only when its
// transaction process is alive, a restart only while its timestamp is fresh.
function busyStatus(updaterModule) {
  const { STATUS_FILE, LOCK_FILE } = updaterModule;
  if (!fs.existsSync(STATUS_FILE)) return null;
  let status;
  try { status = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch { return null; }
  if (status.result !== null && status.result !== undefined) return null;
  if (status.target) return activeTransaction(LOCK_FILE, status) ? status : null;
  return Number.isFinite(status.at) && Date.now() - status.at < RESTART_BUSY_MS ? status : null;
}

function restart() {
  const updaterModule = updater();
  if (busyStatus(updaterModule)) throw new Error("An update or restart is already in progress");
  // Mark the restart before spawning so the very first client poll sees it.
  updaterModule.writeStatus({ phase: "restarting", result: null, at: Date.now() });
  return updaterModule.restartPiWeb();
}

module.exports = { acknowledge, getUpdate, installed, restart, startUpdate };
