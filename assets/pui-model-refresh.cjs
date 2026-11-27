"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

function piEntry(packageRoot) {
  const name = "@earendil-works/pi-coding-agent";
  const resolveFrom = createRequire(path.join(packageRoot, "package.json"));
  for (const directory of resolveFrom.resolve.paths(name) || []) {
    const root = path.join(directory, name);
    const manifestFile = path.join(root, "package.json");
    if (!fs.existsSync(manifestFile)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const bin = manifest.bin?.pi;
    if (manifest.name !== name || typeof bin !== "string" || path.isAbsolute(bin)) throw new Error("invalid-runtime");
    const entry = path.resolve(root, bin);
    if (!entry.startsWith(`${root}${path.sep}`) || !fs.statSync(entry).isFile()) throw new Error("invalid-runtime");
    return entry;
  }
  throw new Error("missing-runtime");
}

// Called once by each Pi Web launcher, before Next creates any model registries.
function refreshModels({ packageRoot = __dirname, timeoutMs = 30000, env = process.env, warn = console.warn } = {}) {
  if (["1", "true", "yes"].includes(String(env.PI_OFFLINE || "").toLowerCase())) return { ok: true, skipped: true };
  try {
    const entry = piEntry(packageRoot);
    const configuredDir = env.PI_CODING_AGENT_DIR;
    const agentDir = configuredDir
      ? path.resolve(configuredDir.startsWith("~/") || configuredDir.startsWith("~\\") ? path.join(os.homedir(), configuredDir.slice(2)) : configuredDir)
      : path.join(os.homedir(), ".pi", "agent");
    const catalog = path.join(agentDir, "models-store.json");
    if (fs.existsSync(catalog)) {
      const backup = `${catalog}.pui-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
      fs.copyFileSync(catalog, backup, fs.constants.COPYFILE_EXCL);
      JSON.parse(fs.readFileSync(catalog, "utf8").replace(/^\uFEFF/, ""));
    }
    const result = spawnSync(process.execPath, [entry, "update", "--models", "--no-approve"], {
      cwd: packageRoot, env, timeout: timeoutMs, killSignal: "SIGKILL", stdio: "ignore", windowsHide: true,
    });
    if (!result.error && result.status === 0) return { ok: true };
    const reason = result.error?.code === "ETIMEDOUT" ? "timeout" : "refresh-failed";
    // Do not forward provider/CLI output: it may contain credentials or private configuration.
    warn(`PUI model catalog refresh failed (${reason}); starting with cached models.`);
    return { ok: false, reason };
  } catch {
    warn("PUI model catalog refresh unavailable; starting with cached models.");
    return { ok: false, reason: "refresh-unavailable" };
  }
}

module.exports = { refreshModels };
