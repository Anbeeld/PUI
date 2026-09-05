#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
  return path.join(os.homedir(), ".pi", "agent", "extensions", "pui-reasoning-summary");
}

function configuredTarget(repoRoot) {
  const stack = JSON.parse(fs.readFileSync(path.join(repoRoot, "stack.json"), "utf8"));
  const configured = stack.reasoningSummaryExtension?.target;
  if (typeof configured !== "string") throw new Error("stack.json reasoningSummaryExtension.target is missing");
  return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
}

function sourceFiles(repoRoot) {
  return Object.fromEntries(OWNED_FILES.map((name) => [name, path.join(repoRoot, "extensions", "pui-reasoning-summary", name)]));
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

function buildStagedExtension(repoRoot, directory) {
  fs.mkdirSync(directory, { recursive: true });
  const files = {};
  for (const [name, source] of Object.entries(sourceFiles(repoRoot))) {
    const content = fs.readFileSync(source);
    fs.writeFileSync(path.join(directory, name), content);
    files[name] = sha256(content);
  }
  const puiVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const manifest = { owner: "PUI", schemaVersion: 1, puiVersion, files };
  manifest.identityHash = identityHash(manifest);
  fs.writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function installExtension({ repoRoot, target = defaultTarget() }) {
  if (path.basename(path.resolve(target)).toLowerCase() !== "pui-reasoning-summary") throw new Error(`Refusing unexpected extension target: ${target}`);
  if (fs.existsSync(target)) {
    const owned = verifyOwnedShape(target);
    if (!owned.ok) throw new Error(`Refusing to replace target that is not PUI-owned: ${target}`);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staged = fs.mkdtempSync(path.join(parent, ".pui-reasoning-summary-stage-"));
  const backup = `${target}.replace-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    const manifest = buildStagedExtension(repoRoot, staged);
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      movedExisting = true;
    }
    fs.renameSync(staged, target);
    if (movedExisting) fs.rmSync(backup, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
    if (movedExisting && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target);
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
  const [command, repoRoot = process.cwd(), targetArgument] = argv;
  try {
    const target = targetArgument || configuredTarget(repoRoot);
    if (command === "install") console.log(JSON.stringify(installExtension({ repoRoot, target })));
    else if (command === "verify") {
      const result = verifyExtension({ repoRoot, target });
      console.log(JSON.stringify(result));
      if (!result.ok) return 1;
    } else if (command === "remove") {
      const result = removeExtension(target);
      console.log(JSON.stringify(result));
      if (result.action === "preserved") return 2;
    } else {
      console.error("Usage: pui-reasoning-summary-extension.js <install|verify|remove> [repo-root] [target]");
      return 64;
    }
    return 0;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 1;
  }
}

module.exports = { configuredTarget, defaultTarget, installExtension, readManifest, removeExtension, verifyExtension, verifyOwnedShape };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
