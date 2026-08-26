#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadRelease, validateRelease } = require("./pui-release.js");

const OWNED_FILES = ["index.ts", "updater.js", "pui-release.js"];

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function identityHash(manifest) {
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, puiVersion: manifest.puiVersion, managed: manifest.managed, files: manifest.files };
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

function defaultTarget() {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "pui-update");
}

function sourceFiles(repoRoot) {
  return {
    "index.ts": path.join(repoRoot, "extensions", "pui-update", "index.ts"),
    "updater.js": path.join(repoRoot, "lib", "pui-updater.js"),
    "pui-release.js": path.join(repoRoot, "lib", "pui-release.js"),
  };
}

function installExtension({ repoRoot, target = defaultTarget() }) {
  const release = loadRelease(repoRoot);
  const errors = validateRelease(release);
  if (errors.length) throw new Error(errors.join("; "));
  if (path.basename(path.resolve(target)).toLowerCase() !== "pui-update") throw new Error(`Refusing unexpected extension target: ${target}`);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  const hashes = {};
  for (const [name, source] of Object.entries(sourceFiles(repoRoot))) {
    const destination = path.join(target, name);
    fs.copyFileSync(source, destination);
    hashes[name] = sha256(destination);
  }
  const manifest = {
    owner: "PUI",
    schemaVersion: 1,
    puiVersion: release.version,
    managed: release.managed,
    files: hashes,
  };
  manifest.identityHash = identityHash(manifest);
  fs.writeFileSync(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function readManifest(target) {
  return JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"));
}

function verifyOwnedShape(target) {
  if (!fs.existsSync(target)) return { ok: false, reason: "missing" };
  let manifest;
  try { manifest = readManifest(target); } catch { return { ok: false, reason: "invalid-manifest" }; }
  if (manifest.owner !== "PUI" || manifest.schemaVersion !== 1 || !manifest.files) return { ok: false, reason: "not-owned" };
  const expectedKeys = ["files", "identityHash", "managed", "owner", "puiVersion", "schemaVersion"];
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys) || manifest.identityHash !== identityHash(manifest)) return { ok: false, reason: "modified" };
  const actualFiles = fs.readdirSync(target).sort();
  const expectedFiles = [...OWNED_FILES, "manifest.json"].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) return { ok: false, reason: "modified" };
  for (const name of OWNED_FILES) {
    const file = path.join(target, name);
    if (!fs.existsSync(file) || sha256(file) !== manifest.files[name]) return { ok: false, reason: "modified" };
  }
  return { ok: true, manifest };
}

function verifyExtension({ repoRoot, target = defaultTarget() }) {
  const owned = verifyOwnedShape(target);
  if (!owned.ok) return owned;
  const release = loadRelease(repoRoot);
  if (owned.manifest.puiVersion !== release.version || JSON.stringify(owned.manifest.managed) !== JSON.stringify(release.managed)) {
    return { ok: false, reason: "composition-mismatch", manifest: owned.manifest };
  }
  return { ok: true, manifest: owned.manifest };
}

function removeExtension(target = defaultTarget()) {
  const owned = verifyOwnedShape(target);
  if (!owned.ok) return { action: owned.reason === "missing" ? "absent" : "preserved", reason: owned.reason };
  fs.rmSync(target, { recursive: true });
  return { action: "removed" };
}

function main(argv) {
  const [command, repoRoot = process.cwd(), target = defaultTarget()] = argv;
  try {
    if (command === "install") console.log(JSON.stringify(installExtension({ repoRoot, target })));
    else if (command === "verify") {
      const result = verifyExtension({ repoRoot, target });
      console.log(JSON.stringify(result));
      if (!result.ok) return 1;
    } else if (command === "remove") {
      const result = removeExtension(target);
      console.log(JSON.stringify(result));
      if (result.action === "preserved") return 2;
    }
    else { console.error("Usage: pui-update-extension.js <install|verify|remove> [repo-root] [target]"); return 64; }
    return 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 1; }
}

module.exports = { defaultTarget, installExtension, readManifest, removeExtension, verifyExtension, verifyOwnedShape };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
