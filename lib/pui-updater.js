#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { resolveConfigPath } = require("./pui-config.js");
const { compareVersions, loadRelease, resolveUpgradeRoute, validateRelease } = require("./pui-release.js");

const STATUS_FILE = path.join(os.tmpdir(), "pui-update-status.json");
const LOCK_FILE = path.join(os.tmpdir(), "pui-update.lock");
const TRANSACTION_ID = process.env.PUI_UPDATE_ID || `${Date.now()}-${process.pid}`;
const CERTIFIED_FILES = ["index.ts", "updater.js", "pui-release.js", "pui-config.js"];

function chooseStableUpdate(current, release, skipped) {
  if (!release || release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name || "")) return null;
  const version = release.tag_name.slice(1);
  if (version === skipped || compareVersions(version, current) <= 0) return null;
  return version;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function readCertifiedManifest(file) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const expectedKeys = ["files", "identityHash", "managed", "owner", "puiVersion", "schemaVersion"];
  const files = manifest && manifest.files;
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, puiVersion: manifest.puiVersion, managed: manifest.managed, files };
  const expected = crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
  if (manifest.owner !== "PUI" || manifest.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(manifest.puiVersion || "")
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)
    || !files || Array.isArray(files) || JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...CERTIFIED_FILES].sort())
    || manifest.identityHash !== expected) throw new Error("Installed PUI identity is invalid or modified");
  const root = path.dirname(file);
  if (JSON.stringify(fs.readdirSync(root).sort()) !== JSON.stringify([...CERTIFIED_FILES, "manifest.json"].sort())) throw new Error("Installed PUI identity file shape is invalid");
  for (const [relative, expectedHash] of Object.entries(files)) {
    if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").includes("..") || path.posix.normalize(relative) !== relative || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error("Installed PUI identity contains an invalid file entry");
    }
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`Installed PUI identity file is missing: ${relative}`);
    const actualHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Installed PUI identity file hash mismatch: ${relative}`);
  }
  return manifest;
}

function expandHome(file) {
  return file.replace(/^~(?=$|[\\/])/, os.homedir());
}

function backupConfigFiles(stack, backupRoot) {
  return backupConfigFilesForStacks([stack], backupRoot);
}

function backupConfigFilesForStacks(stacks, backupRoot) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const keys = ["piSettings", "piWebAccess", "mcpShared", "piFffFeatures", "piGoal", "askUserQuestion", "puiSubagents"];
  const seen = new Set();
  const backups = [];
  for (const stack of stacks) {
    for (const key of keys) {
      if (typeof stack.configPaths?.[key] !== "string") continue;
      const file = key === "askUserQuestion" && typeof stack.askUserQuestion?.configRelativePath === "string"
        ? resolveConfigPath(stack.configPaths[key], stack.askUserQuestion.configRelativePath)
        : path.resolve(expandHome(stack.configPaths[key]));
      const identity = process.platform === "win32" ? file.toLowerCase() : file;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const backup = path.join(backupRoot, `${backups.length}-${key}.json`);
      const existed = fs.existsSync(file);
      if (existed) fs.copyFileSync(file, backup);
      backups.push({ file, backup, existed });
    }
  }
  return backups;
}

function backupBackgroundTaskFilesForStacks(stacks, backupRoot, agentNpmRoot = path.join(os.homedir(), ".pi", "agent", "npm")) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const seen = new Set();
  const backups = [];
  for (const stack of stacks) {
    const config = stack.backgroundTasksPromptPatch;
    if (!config || typeof config.packagePath !== "string" || typeof config.bundle !== "string") continue;
    const packageDir = path.resolve(agentNpmRoot, config.packagePath);
    const bundle = path.join(packageDir, config.bundle);
    const files = [bundle];
    if (typeof config.backupSuffix === "string") files.push(`${bundle}${config.backupSuffix}`);
    if (typeof config.manifestSuffix === "string") files.push(`${bundle}${config.manifestSuffix}`);
    for (const file of files) {
      const identity = process.platform === "win32" ? file.toLowerCase() : file;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const backup = path.join(backupRoot, `${backups.length}-background-task-${path.basename(file)}`);
      const existed = fs.existsSync(file);
      if (existed) fs.copyFileSync(file, backup);
      backups.push({ file, backup, existed });
    }
  }
  return backups;
}

function backupSubagentFilesForStacks(stacks, backupRoot, agentNpmRoot = path.join(os.homedir(), ".pi", "agent", "npm")) {
  fs.mkdirSync(backupRoot, { recursive: true });
  const seen = new Set();
  const backups = [];
  for (const stack of stacks) {
    const config = stack.subagentsPromptPatch;
    if (!config || typeof config.packagePath !== "string" || !Array.isArray(config.files) || typeof config.backupSuffix !== "string" || typeof config.manifest !== "string") continue;
    const packageDir = path.resolve(agentNpmRoot, config.packagePath);
    const files = [
      ...config.files.map((relative) => path.join(packageDir, ...relative.split("/"))),
      ...config.files.map((relative) => path.join(packageDir, ...relative.split("/")) + config.backupSuffix),
      path.join(packageDir, config.manifest),
    ];
    for (const file of files) {
      const identity = process.platform === "win32" ? file.toLowerCase() : file;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const backup = path.join(backupRoot, `${backups.length}-subagents-${path.basename(file)}`);
      const existed = fs.existsSync(file);
      if (existed) fs.copyFileSync(file, backup);
      backups.push({ file, backup, existed });
    }
  }
  return backups;
}

function restoreConfigFiles(backups) {
  for (const entry of backups) {
    if (entry.existed) {
      fs.mkdirSync(path.dirname(entry.file), { recursive: true });
      fs.copyFileSync(entry.backup, entry.file);
    } else if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file);
  }
}

async function runTransaction(options) {
  const writeStatus = options.writeStatus || (async () => {});
  let mutated = false;
  try {
    await writeStatus({ target: options.target, phase: "preparing", result: null });
    if (options.prepare) await options.prepare();
    await writeStatus({ target: options.target, phase: "waiting", result: null });
    while (true) {
      await options.waitForIdle();
      if (!(await options.standaloneBusy())) break;
      await delay(options.busyDelayMs ?? 2000);
    }
    await writeStatus({ target: options.target, phase: "installing", result: null });
    mutated = true;
    await options.apply(options.target);
    await writeStatus({ target: options.target, phase: "verifying", result: null });
    await options.validate(options.target);
    const result = { target: options.target, phase: "complete", result: "success" };
    await writeStatus(result);
    return result;
  } catch (error) {
    if (!mutated) {
      await writeStatus({ target: options.target, phase: "failed", result: "aborted", error: error.message });
      throw error;
    }
    try {
      await writeStatus({ target: options.target, phase: "restoring", result: null });
      await options.rollback(options.current);
      await options.validate(options.current);
      const result = { target: options.target, phase: "complete", result: "rolled-back", restored: options.current, error: error.message };
      await writeStatus(result);
      return result;
    } catch (rollbackError) {
      const result = { target: options.target, phase: "recovery-required", result: "recovery-required", error: rollbackError.message, updateError: error.message };
      await writeStatus(result);
      return result;
    }
  }
}

function writeStatus(status) {
  const next = { id: TRANSACTION_ID, ...status };
  fs.writeFileSync(STATUS_FILE, `${JSON.stringify(next, null, 2)}\n`);
}

function acquireLock() {
  let handle;
  try {
    handle = fs.openSync(LOCK_FILE, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const text = fs.readFileSync(LOCK_FILE, "utf8");
    let lock;
    try { lock = JSON.parse(text); } catch { lock = Number.parseInt(text, 10); }
    const pid = typeof lock === "object" && lock !== null ? lock.pid : lock;
    let active = Number.isInteger(pid) && pid > 0;
    if (active) { try { process.kill(pid, 0); } catch { active = false; } }
    if (active) throw new Error(`PUI update already in progress (PID ${pid})`);
    fs.unlinkSync(LOCK_FILE);
    handle = fs.openSync(LOCK_FILE, "wx");
  }
  fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, id: TRANSACTION_ID })}\n`);
  return () => { try { fs.closeSync(handle); } catch {} try { fs.unlinkSync(LOCK_FILE); } catch {} };
}

async function piWebHealthy() {
  try {
    const response = await fetch("http://127.0.0.1:30141/", { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch { return false; }
}

// The relaunch must reuse the same launcher as autostart: the Windows Startup-folder
// VBS (hidden console, PI_WEB_SKIP_VERSION_CHECK=1), launchd/systemd when managed.
// Supervisor-based specs stop the existing instance themselves (stopsExisting).
function piWebLaunchSpec(overrides = {}) {
  const platform = overrides.platform || process.platform;
  const exists = overrides.existsSync || ((p) => fs.existsSync(p));
  const home = overrides.home || os.homedir();
  if (platform === "win32") {
    const appData = overrides.appData || process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const vbs = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "pui-piweb.vbs");
    if (exists(vbs)) return { file: "wscript.exe", args: [vbs], stopsExisting: false };
    const parentEnv = overrides.env || process.env;
    return { file: parentEnv.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "pi-web --no-open"], env: { ...parentEnv, PI_WEB_SKIP_VERSION_CHECK: "1" }, stopsExisting: false };
  }
  if (platform === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", "com.pui.piweb.plist");
    if (exists(plist)) return { file: "launchctl", args: ["kickstart", "-k", `gui/${overrides.uid ?? os.userInfo().uid}/com.pui.piweb`], stopsExisting: true };
  }
  if (platform === "linux") {
    const unit = path.join(home, ".config", "systemd", "user", "pui-piweb.service");
    if (exists(unit)) return { file: "systemctl", args: ["--user", "restart", "pui-piweb"], stopsExisting: true };
  }
  return { file: "pi-web", args: ["--no-open"], stopsExisting: false };
}

function relaunchPiWeb() {
  const spec = piWebLaunchSpec();
  const child = spawn(spec.file, spec.args, { detached: true, stdio: "ignore", windowsHide: true, env: spec.env });
  child.on("error", () => {});
  child.unref();
}

async function ensurePiWebRunning() {
  if (await piWebHealthy()) return;
  relaunchPiWeb();
}

function scriptEnvironment(clearFailureInjection = false) {
  const env = { ...process.env, PUI_APPLY_STAGED: "1", PUI_NONINTERACTIVE: "1" };
  if (clearFailureInjection) delete env.PUI_FAIL_AT;
  return env;
}

function runScript(repoRoot, args = [], options = {}) {
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "bash";
  const script = path.join(repoRoot, windows ? "update.ps1" : "update.sh");
  const scriptArgs = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-ApplyStaged"] : [script, "--apply-staged"];
  const result = spawnSync(command, [...scriptArgs, ...args], { stdio: "inherit", windowsHide: true, env: scriptEnvironment(options.clearFailureInjection) });
  if (result.status !== 0) throw new Error(`PUI apply failed with exit ${result.status}`);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "PUI updater" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { "User-Agent": "PUI updater" }, signal: AbortSignal.timeout(30000), redirect: "follow" });
  if (!response.ok) throw new Error(`Download returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function validateNpmAvailability(managed) {
  await Promise.all(Object.values(managed).map(async (spec) => {
    const separator = spec.lastIndexOf("@");
    const name = spec.slice(0, separator);
    const version = spec.slice(separator + 1);
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { method: "HEAD", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`npm does not provide ${name}@${version}`);
  }));
}

async function stageRelease(version, transactionRoot) {
  const release = await fetchJson(`https://api.github.com/repos/Anbeeld/PUI/releases/tags/v${version}`);
  if (release.draft || release.prerelease || release.tag_name !== `v${version}`) throw new Error(`v${version} is not a stable matching PUI release`);
  const archive = path.join(transactionRoot, `pui-v${version}.tar.gz`);
  fs.writeFileSync(archive, await fetchBuffer(`https://github.com/Anbeeld/PUI/archive/refs/tags/v${version}.tar.gz`));
  const destination = path.join(transactionRoot, `v${version}`);
  fs.mkdirSync(destination);
  const extracted = spawnSync("tar", ["-xzf", archive, "-C", destination], { encoding: "utf8", windowsHide: true });
  if (extracted.status !== 0) throw new Error(`Could not extract PUI v${version}: ${extracted.stderr}`);
  const entries = fs.readdirSync(destination, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new Error(`Unexpected PUI v${version} archive layout`);
  const repoRoot = path.join(destination, entries[0].name);
  const manifest = loadRelease(repoRoot);
  const errors = validateRelease(manifest);
  if (manifest.version !== version) errors.push(`tag v${version} does not match package.json ${manifest.version}`);
  for (const required of ["update.ps1", "update.sh", "doctor.ps1", "doctor.sh", "lib/pui-updater.js"]) {
    if (!fs.existsSync(path.join(repoRoot, required))) errors.push(`missing required release file ${required}`);
  }
  if (errors.length) throw new Error(errors.join("; "));
  await validateNpmAvailability(manifest.managed);
  return { repoRoot, manifest };
}

async function piWebIdle() {
  try {
    const response = await fetch("http://127.0.0.1:30141/api/agent/running", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = await response.json();
    if (!Array.isArray(state.runningSessionIds)) throw new Error("invalid activity response");
    if (state.runningSessionIds.length > 0) throw Object.assign(new Error("Pi Web is busy"), { busy: true });
  } catch (error) {
    if (error.busy) { await delay(2000); return piWebIdle(); }
    throw new Error(`Could not verify Pi Web idle state: ${error.message}`);
  }
}

function isStandalonePiCommand(line) {
  if (/@agegr[\\/]pi-web|pui-updater/i.test(line)) return false;
  return /[\\/]node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]/i.test(line)
    || /(?:^|[\\/\s])pi(?:\.cmd|\.exe)?(?:\s|$)/i.test(line);
}

async function standalonePiBusy() {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine"], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-eo", "args="], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Could not inspect standalone Pi processes");
  return result.stdout.split(/\r?\n/).some(isStandalonePiCommand);
}

function isPiWebProcess(line) {
  return /[\\/]node_modules[\\/]@agegr[\\/]pi-web[\\/]/i.test(line);
}

function listPiWebProcesses() {
  const result = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Could not inspect running processes");
  const entries = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let pidText;
    let cmdLine;
    if (process.platform === "win32") {
      const sep = raw.indexOf("|");
      if (sep < 0) continue;
      pidText = raw.slice(0, sep);
      cmdLine = raw.slice(sep + 1);
    } else {
      const match = raw.match(/^\s*(\d+)\s+([\s\S]*)$/);
      if (!match) continue;
      pidText = match[1];
      cmdLine = match[2];
    }
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0 && isPiWebProcess(cmdLine)) entries.push({ pid, line: cmdLine });
  }
  return entries;
}

function killPiWebProcesses() {
  for (const { pid } of listPiWebProcesses()) {
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
}

function restartPiWeb() {
  const child = spawn(process.execPath, [__filename, "restart"], detachedSpawnOptions());
  child.on("error", () => {});
  child.unref();
  return { accepted: true, pid: child.pid };
}

// Stop Pi Web, relaunch it via the autostart launcher, and only report success
// after the server answers HTTP again; failures are written to the status file
// so the UI shows them instead of silently leaving Pi Web down.
async function restartPiWebCommand() {
  // Let the HTTP response flush before killing Pi Web.
  sleepMs(1500);
  writeStatus({ phase: "restarting", result: null, at: Date.now() });
  try {
    const spec = piWebLaunchSpec();
    if (!spec.stopsExisting) {
      try { killPiWebProcesses(); } catch {}
      for (let attempt = 0; attempt < 30 && listPiWebProcesses().length > 0; attempt += 1) sleepMs(500);
      const remaining = listPiWebProcesses();
      if (remaining.length > 0) throw new Error(`Could not stop Pi Web (PIDs ${remaining.map((p) => p.pid).join(", ")})`);
    }
    relaunchPiWeb();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await piWebHealthy()) { writeStatus({ phase: "complete", result: "restarted" }); return; }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Pi Web did not become healthy after restart");
  } catch (error) {
    writeStatus({ phase: "failed", result: "failed", error: error.message });
    process.exitCode = 1;
  }
}

async function validateInstalled(version) {
  const extension = path.join(os.homedir(), ".pi", "agent", "extensions", "pui-update", "manifest.json");
  const manifest = readCertifiedManifest(extension);
  if (manifest.puiVersion !== version) throw new Error(`Installed PUI identity is ${manifest.puiVersion}, expected ${version}`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const [root, bridge] = await Promise.all([
        fetch("http://127.0.0.1:30141/", { signal: AbortSignal.timeout(3000) }),
        fetch("http://127.0.0.1:30141/api/app-update", { signal: AbortSignal.timeout(3000) }),
      ]);
      if (root.ok && bridge.ok) return;
    } catch {}
    await delay(2000);
  }
  throw new Error("Pi Web or the PUI update bridge did not become healthy");
}

async function applyTarget(target) {
  const releaseLock = acquireLock();
  const transactionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-"));
  let retainEvidence = false;
  try {
    const manifestFile = path.join(os.homedir(), ".pi", "agent", "extensions", "pui-update", "manifest.json");
    const currentManifest = readCertifiedManifest(manifestFile);
    const staged = new Map();
    const stage = async (version) => {
      if (!staged.has(version)) staged.set(version, await stageRelease(version, transactionRoot));
      return staged.get(version);
    };
    const targetRelease = await stage(target);
    const currentRelease = await stage(currentManifest.puiVersion);
    if (JSON.stringify(currentRelease.manifest.managed) !== JSON.stringify(currentManifest.managed)) {
      throw new Error("Installed identity does not match the previous certified release composition");
    }
    const route = await resolveUpgradeRoute(currentManifest.puiVersion, target, async (version) => (await stage(version)).manifest);
    const routeReleases = [];
    for (const version of route) routeReleases.push(await stage(version));
    const transactionStacks = [currentRelease.manifest.stack, ...routeReleases.map((release) => release.manifest.stack)];
    const configBackups = backupConfigFilesForStacks(transactionStacks, path.join(transactionRoot, "config-backups"));
    const backgroundTaskBackups = backupBackgroundTaskFilesForStacks(transactionStacks, path.join(transactionRoot, "background-task-backups"));
    const subagentBackups = backupSubagentFilesForStacks(transactionStacks, path.join(transactionRoot, "subagent-backups"));
    const result = await runTransaction({
      current: currentManifest.puiVersion,
      target,
      prepare: async () => {},
      waitForIdle: piWebIdle,
      standaloneBusy: standalonePiBusy,
      apply: async () => {
        for (const [index, version] of route.entries()) {
          writeStatus({ target, phase: "restarting", result: null, step: version });
          runScript(routeReleases[index].repoRoot);
          await ensurePiWebRunning();
        }
      },
      validate: validateInstalled,
      rollback: async () => { restoreConfigFiles(configBackups); restoreConfigFiles(backgroundTaskBackups); restoreConfigFiles(subagentBackups); runScript(currentRelease.repoRoot, [], { clearFailureInjection: true }); await ensurePiWebRunning(); },
      writeStatus: async (status) => writeStatus(status),
    });
    retainEvidence = result.result === "recovery-required";
    if (retainEvidence) writeStatus({ ...result, evidence: transactionRoot });
    return result;
  } catch (error) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); } catch {}
    if (!existing || existing.id !== TRANSACTION_ID || !existing.result) {
      writeStatus({ target, phase: "failed", result: "aborted", error: error.message });
    }
    throw error;
  } finally {
    releaseLock();
    if (!retainEvidence) { try { fs.rmSync(transactionRoot, { recursive: true, force: true }); } catch {} }
  }
}

async function reapplyLocal(repoRoot, currentManifest) {
  const releaseLock = acquireLock();
  const transactionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-"));
  let retainEvidence = false;
  try {
    const previous = await stageRelease(currentManifest.puiVersion, transactionRoot);
    if (JSON.stringify(previous.manifest.managed) !== JSON.stringify(currentManifest.managed)) throw new Error("Installed identity does not match the previous certified release composition");
    const localRelease = loadRelease(repoRoot);
    const transactionStacks = [previous.manifest.stack, localRelease.stack];
    const configBackups = backupConfigFilesForStacks(transactionStacks, path.join(transactionRoot, "config-backups"));
    const backgroundTaskBackups = backupBackgroundTaskFilesForStacks(transactionStacks, path.join(transactionRoot, "background-task-backups"));
    const subagentBackups = backupSubagentFilesForStacks(transactionStacks, path.join(transactionRoot, "subagent-backups"));
    const result = await runTransaction({
      current: currentManifest.puiVersion,
      target: currentManifest.puiVersion,
      prepare: async () => {},
      waitForIdle: piWebIdle,
      standaloneBusy: standalonePiBusy,
      apply: async () => { writeStatus({ target: currentManifest.puiVersion, phase: "restarting", result: null }); runScript(repoRoot); await ensurePiWebRunning(); },
      validate: validateInstalled,
      rollback: async () => { restoreConfigFiles(configBackups); restoreConfigFiles(backgroundTaskBackups); restoreConfigFiles(subagentBackups); runScript(previous.repoRoot, [], { clearFailureInjection: true }); await ensurePiWebRunning(); },
      writeStatus: async (status) => writeStatus(status),
    });
    retainEvidence = result.result === "recovery-required";
    if (retainEvidence) writeStatus({ ...result, evidence: transactionRoot });
    return result;
  } finally {
    releaseLock();
    if (!retainEvidence) { try { fs.rmSync(transactionRoot, { recursive: true, force: true }); } catch {} }
  }
}

function manualUpdateGuidance(localVersion, installedVersion) {
  return `v${localVersion} is not a published GitHub release (installed identity is v${installedVersion}). The default update fetches a certified release from GitHub. To apply the local working copy at v${localVersion}, run with the staged-apply flag: ./update.ps1 -ApplyStaged (Windows) or ./update.sh --apply-staged (macOS/Linux).`;
}

async function manualUpdate(repoRoot) {
  const targetRelease = loadRelease(repoRoot);
  const errors = validateRelease(targetRelease);
  if (errors.length) throw new Error(errors.join("; "));
  const installedManifest = path.join(os.homedir(), ".pi", "agent", "extensions", "pui-update", "manifest.json");
  if (!fs.existsSync(installedManifest)) {
    runScript(repoRoot);
    return { result: "bootstrap", target: targetRelease.version };
  }
  const currentManifest = readCertifiedManifest(installedManifest);
  const current = currentManifest.puiVersion;
  if (current === targetRelease.version) {
    return reapplyLocal(repoRoot, currentManifest);
  }
  try {
    return await applyTarget(targetRelease.version);
  } catch (error) {
    if (/HTTP 404/.test(error.message)) throw new Error(manualUpdateGuidance(targetRelease.version, current));
    throw error;
  }
}

async function latestStable(current) {
  const release = await fetchJson("https://api.github.com/repos/Anbeeld/PUI/releases/latest");
  return chooseStableUpdate(current, release, null);
}

function detachedSpawnOptions() {
  return {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: os.tmpdir(),
    env: { ...process.env, PUI_REQUIRE_INSTALLED_IDENTITY: "1" },
  };
}

function sleepMs(ms) {
  spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`], { stdio: "ignore", windowsHide: true });
}

function spawnDetached(target) {
  const child = spawn(process.execPath, [__filename, "apply", target], detachedSpawnOptions());
  child.unref();
  return child.pid;
}

function main(argv) {
  const [command, value] = argv;
  if (command === "status") {
    process.stdout.write(fs.existsSync(STATUS_FILE) ? fs.readFileSync(STATUS_FILE) : "{}\n");
    return 0;
  }
  if (command === "latest") {
    return latestStable(value).then((version) => console.log(version || "")).then(() => 0);
  }
  if (command === "start" && /^\d+\.\d+\.\d+$/.test(value || "")) {
    console.log(JSON.stringify({ pid: spawnDetached(value) }));
    return 0;
  }
  if (command === "standalone-busy") return standalonePiBusy().then((busy) => busy ? 75 : 0);
  if (command === "apply" && /^\d+\.\d+\.\d+$/.test(value || "")) return applyTarget(value).then(() => 0);
  if (command === "manual" && value) return manualUpdate(path.resolve(value)).then(() => 0);
  if (command === "restart") return restartPiWebCommand().then(() => 0);
  console.error("Usage: pui-updater.js <status|latest CURRENT|start TARGET|apply TARGET|manual REPO_ROOT|restart|standalone-busy>");
  return 64;
}

module.exports = { LOCK_FILE, STATUS_FILE, acquireLock, applyTarget, backupBackgroundTaskFilesForStacks, backupSubagentFilesForStacks, backupConfigFiles, backupConfigFilesForStacks, chooseStableUpdate, detachedSpawnOptions, ensurePiWebRunning, isPiWebProcess, isStandalonePiCommand, loadRelease, manualUpdate, manualUpdateGuidance, piWebIdle, piWebLaunchSpec, readCertifiedManifest, restartPiWeb, restoreConfigFiles, runScript, runTransaction, scriptEnvironment, sleepMs, spawnDetached, stageRelease, validateNpmAvailability, validateRelease, writeStatus };
if (require.main === module) {
  try {
    const manifestFile = path.join(__dirname, "manifest.json");
    if (process.env.PUI_REQUIRE_INSTALLED_IDENTITY === "1" || fs.existsSync(manifestFile)) readCertifiedManifest(manifestFile);
    Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
