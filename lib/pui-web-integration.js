#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { loadRelease } = require("./pui-release.js");

const MANIFEST = ".pui-update-integration.json";
const ROUTE_REL = ".next/server/app/api/app-update/route.js";
const INDEX_REL = ".next/server/app/index.html";
const BRIDGE_REL = "pui-update-bridge.cjs";
const CLIENT_REL = "public/pui-update.js";
const LAUNCHER_REL = "bin/pi-web.js";
const REFRESH_REL = "pui-model-refresh.cjs";
const LEGACY_FILES = [ROUTE_REL, INDEX_REL, BRIDGE_REL, CLIENT_REL];
const CURRENT_FILES = [...LEGACY_FILES, LAUNCHER_REL, REFRESH_REL];
const ROUTE_MARKER = "PUI_UPDATE_BRIDGE_V1";

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function integrationIdentityHash(manifest) {
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, piWebVersion: manifest.piWebVersion, files: manifest.files };
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}
function validManifest(manifest) {
  const keys = ["files", "identityHash", "owner", "piWebVersion", "schemaVersion"];
  const files = manifest && manifest.files;
  const expectedFiles = (files && Object.hasOwn(files, LAUNCHER_REL) ? CURRENT_FILES : LEGACY_FILES).slice().sort();
  return manifest && manifest.owner === "PUI" && manifest.schemaVersion === 1
    && JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(keys)
    && files && !Array.isArray(files) && JSON.stringify(Object.keys(files).sort()) === JSON.stringify(expectedFiles)
    && Object.entries(files).every(([name, hash]) => safeRelativePath(name) && /^[a-f0-9]{64}$/.test(hash))
    && manifest.identityHash === integrationIdentityHash(manifest);
}
function safeRelativePath(name) {
  return typeof name === "string" && name.length > 0 && !path.isAbsolute(name) && !name.includes("\\") && !name.split("/").includes("..") && path.posix.normalize(name) === name;
}
function backupName(file) { return `${file}.pui-update-original`; }
function injectedFailure(stage) { if (process.env.PUI_FAIL_INTEGRATION_AT === stage) throw new Error(`Injected integration failure at ${stage}`); }
function integrationSnapshot(piWebRoot) {
  const files = [...CURRENT_FILES, MANIFEST, ...[ROUTE_REL, INDEX_REL, LAUNCHER_REL].map((file) => `${file}.pui-update-original`)];
  return files.map((relative) => {
    const file = path.join(piWebRoot, relative);
    return { file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
  });
}
function restoreIntegrationSnapshot(snapshot) {
  for (const { file, bytes } of snapshot) {
    if (bytes === null) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }
  }
}

function routeReplacement() {
  return `62445:(a,b,c)=>{"use strict";/*${ROUTE_MARKER}*/c.r(b),c.d(b,{DELETE:()=>i,GET:()=>g,POST:()=>h,PUT:()=>k,dynamic:()=>d});var e=c(23211);let d="force-dynamic",f=require("../../../../../${BRIDGE_REL}");async function g(){return e.NextResponse.json(await f.getUpdate())}async function h(a){try{let b=await a.json();return e.NextResponse.json(await f.startUpdate(b.target),{status:202})}catch(a){return e.NextResponse.json({error:a instanceof Error?a.message:String(a)},{status:409})}}async function i(){return e.NextResponse.json(f.acknowledge())}async function k(){try{return e.NextResponse.json(await f.restart(),{status:202})}catch(a){return e.NextResponse.json({error:a instanceof Error?a.message:String(a)},{status:409})}}}`;
}

function patchRoute(content, version) {
  const pattern = /62445:\(a,b,c\)=>\{[\s\S]*?\},63033:/;
  if (!pattern.test(content) || !content.includes(`h="${version}"`) || !content.includes("registry.npmjs.org/@agegr%2Fpi-web/latest")) {
    throw new Error(`Expected Pi Web app-update route for ${version} was not found`);
  }
  return content.replace(pattern, `${routeReplacement()},63033:`);
}

function patchIndex(content, puiVersion) {
  if (!content.includes("</body>")) throw new Error("Expected Pi Web app index body was not found");
  return content.replace("</body>", `<script src="/pui-update.js?pui=${puiVersion}" defer></script></body>`);
}

function patchLauncher(content, timeoutMs) {
  const anchor = 'const nextArgs = ["start", "-p", port];';
  if (content.split(anchor).length !== 2 || content.includes("PUI_MODEL_REFRESH_V1")) throw new Error("Expected pristine Pi Web launcher was not found");
  return content.replace(anchor, `/* PUI_MODEL_REFRESH_V1 */\nrequire("../${REFRESH_REL}").refreshModels({ timeoutMs: ${timeoutMs} });\n\n${anchor}`);
}

function launcherBackupMatches(piWebRoot) {
  try {
    const launcher = fs.readFileSync(path.join(piWebRoot, LAUNCHER_REL), "utf8");
    const original = fs.readFileSync(backupName(path.join(piWebRoot, LAUNCHER_REL)), "utf8");
    const timeout = launcher.match(/refreshModels\(\{ timeoutMs: (\d+) \}\)/)?.[1];
    return !!timeout && patchLauncher(original, Number(timeout)) === launcher;
  } catch { return false; }
}

function finalClientBundle(piWebRoot) {
  const directory = path.join(piWebRoot, ".next", "static", "chunks", "app");
  const files = fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((name) => /^page-[^/]+\.js$/.test(name))
    : [];
  if (files.length !== 1) throw new Error(`Expected exactly one Pi Web page client bundle in ${directory}`);
  return path.join(directory, files[0]);
}

function versionClientReference(content, clientBundle, version) {
  const name = path.basename(clientBundle);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escaped}(?:\\?pui=[a-f0-9]{12})?`, "g");
  const matches = content.match(pattern);
  if (!matches?.length) throw new Error("Expected Pi Web page client reference was not found in the integrated index");
  return content.replace(pattern, `${name}?pui=${version}`);
}

function applyIntegration({ repoRoot, piWebRoot }) {
  const snapshot = integrationSnapshot(piWebRoot);
  try {
  const release = loadRelease(repoRoot);
  const packageFile = path.join(piWebRoot, "package.json");
  if (!fs.existsSync(packageFile)) throw new Error("Expected Pi Web package.json was not found");
  const installed = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  if (installed.name !== "@agegr/pi-web" || installed.version !== release.stack.upstream.gui.version) {
    throw new Error(`Expected @agegr/pi-web ${release.stack.upstream.gui.version}`);
  }
  const route = path.join(piWebRoot, ROUTE_REL);
  const index = path.join(piWebRoot, INDEX_REL);
  if (!fs.existsSync(route)) throw new Error("Expected Pi Web app-update route was not found");
  if (!fs.existsSync(index)) throw new Error("Expected Pi Web app index was not found");
  const current = verifyIntegration({ repoRoot, piWebRoot });
  if (current.ok) return JSON.parse(fs.readFileSync(path.join(piWebRoot, MANIFEST), "utf8"));
  const manifestFile = path.join(piWebRoot, MANIFEST);
  if (fs.existsSync(manifestFile)) {
    const previous = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (!validManifest(previous)) throw new Error("Modified Pi Web integration manifest was preserved");
    for (const [name, expectedHash] of Object.entries(previous.files)) {
      if (!fs.existsSync(path.join(piWebRoot, name)) || hashFile(path.join(piWebRoot, name)) !== expectedHash) throw new Error(`Modified Pi Web integration file was preserved: ${name}`);
    }
    if (!Object.hasOwn(previous.files, LAUNCHER_REL)) {
      const removed = removeIntegration(piWebRoot);
      if (removed.action !== "removed") throw new Error("Modified legacy Pi Web integration was preserved");
    } else {
      if (!launcherBackupMatches(piWebRoot)) throw new Error("Modified Pi Web launcher backup was preserved");
    }
  }
  const launcher = path.join(piWebRoot, LAUNCHER_REL);
  const refresh = path.join(piWebRoot, REFRESH_REL);
  if (!fs.existsSync(launcher)) throw new Error("Expected Pi Web launcher was not found");
  if (!fs.existsSync(manifestFile) && (fs.existsSync(backupName(launcher)) || fs.existsSync(refresh))) throw new Error("Unowned Pi Web startup artifacts were preserved");
  if (!fs.existsSync(backupName(launcher))) fs.copyFileSync(launcher, backupName(launcher));
  if (!fs.existsSync(backupName(route))) fs.copyFileSync(route, backupName(route));
  if (!fs.existsSync(backupName(index))) fs.copyFileSync(index, backupName(index));
  injectedFailure("backup");
  const rebuildingOwned = fs.existsSync(manifestFile);
  fs.writeFileSync(route, patchRoute(fs.readFileSync(rebuildingOwned ? backupName(route) : route, "utf8"), release.stack.upstream.gui.version));
  injectedFailure("route");
  fs.writeFileSync(index, patchIndex(fs.readFileSync(rebuildingOwned ? backupName(index) : index, "utf8"), release.version));
  injectedFailure("index");
  fs.copyFileSync(path.join(repoRoot, "lib", "pui-update-bridge.cjs"), path.join(piWebRoot, BRIDGE_REL));
  fs.copyFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), path.join(piWebRoot, CLIENT_REL));
  injectedFailure("client");
  fs.writeFileSync(launcher, patchLauncher(fs.readFileSync(backupName(launcher), "utf8"), release.stack.piWeb.modelRefresh.timeoutMs));
  fs.copyFileSync(path.join(repoRoot, "assets", "pui-model-refresh.cjs"), refresh);
  injectedFailure("startup");
  const files = CURRENT_FILES;
  const manifest = { owner: "PUI", schemaVersion: 1, piWebVersion: installed.version, files: Object.fromEntries(files.map((name) => [name, hashFile(path.join(piWebRoot, name))])) };
  manifest.identityHash = integrationIdentityHash(manifest);
  injectedFailure("manifest");
  fs.writeFileSync(path.join(piWebRoot, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
  } catch (error) {
    try { restoreIntegrationSnapshot(snapshot); } catch (rollbackError) { throw new Error(`Pi Web integration failed: ${error.message}; rollback failed: ${rollbackError.message}`); }
    throw error;
  }
}

function finalizeIntegration({ repoRoot, piWebRoot }) {
  const verification = verifyIntegration({ repoRoot, piWebRoot });
  if (!verification.ok) throw new Error(`Cannot finalize modified Pi Web integration: ${verification.reason}`);
  const manifestFile = path.join(piWebRoot, MANIFEST);
  const index = path.join(piWebRoot, INDEX_REL);
  const clientBundle = finalClientBundle(piWebRoot);
  const version = hashFile(clientBundle).slice(0, 12);
  const previousIndex = fs.readFileSync(index, "utf8");
  const previousManifest = fs.readFileSync(manifestFile, "utf8");
  const nextIndex = versionClientReference(previousIndex, clientBundle, version);
  if (nextIndex === previousIndex) return { ok: true, action: "already-finalized", version };
  const manifest = JSON.parse(previousManifest);
  manifest.files[INDEX_REL] = crypto.createHash("sha256").update(nextIndex).digest("hex");
  manifest.identityHash = integrationIdentityHash(manifest);
  try {
    fs.writeFileSync(index, nextIndex, "utf8");
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const finalized = verifyIntegration({ repoRoot, piWebRoot });
    if (!finalized.ok) throw new Error(`Finalized Pi Web integration failed verification: ${finalized.reason}`);
    return { ok: true, action: "finalized", version };
  } catch (error) {
    try {
      fs.writeFileSync(index, previousIndex, "utf8");
      fs.writeFileSync(manifestFile, previousManifest, "utf8");
    } catch (rollbackError) {
      throw new Error(`Integration finalization failed: ${error.message}; rollback failed: ${rollbackError.message}`);
    }
    throw error;
  }
}

function verifyIntegration({ repoRoot, piWebRoot }) {
  try {
    const release = loadRelease(repoRoot);
    const expected = release.stack.upstream.gui.version;
    const manifest = JSON.parse(fs.readFileSync(path.join(piWebRoot, MANIFEST), "utf8"));
    if (!validManifest(manifest)) return { ok: false, reason: "modified" };
    if (manifest.piWebVersion !== expected) return { ok: false, reason: "version-mismatch" };
    for (const [name, hash] of Object.entries(manifest.files || {})) if (hashFile(path.join(piWebRoot, name)) !== hash) return { ok: false, reason: "modified", file: name };
    if (!Object.hasOwn(manifest.files, LAUNCHER_REL)) return { ok: false, reason: "startup-refresh-missing" };
    const launcherBackup = path.join(piWebRoot, `${LAUNCHER_REL}.pui-update-original`);
    const desiredLauncher = patchLauncher(fs.readFileSync(launcherBackup, "utf8"), release.stack.piWeb.modelRefresh.timeoutMs);
    if (fs.readFileSync(path.join(piWebRoot, LAUNCHER_REL), "utf8") !== desiredLauncher || hashFile(path.join(piWebRoot, REFRESH_REL)) !== hashFile(path.join(repoRoot, "assets", "pui-model-refresh.cjs"))) return { ok: false, reason: "startup-refresh-outdated" };
    return { ok: true };
  } catch (error) { return { ok: false, reason: error.message }; }
}

function removeIntegration(piWebRoot) {
  const snapshot = integrationSnapshot(piWebRoot);
  try {
  const manifestFile = path.join(piWebRoot, MANIFEST);
  if (!fs.existsSync(manifestFile)) return { action: "absent" };
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch { return { action: "preserved", reason: "modified" }; }
  if (!validManifest(manifest)) return { action: "preserved", reason: "modified" };
  for (const [name, hash] of Object.entries(manifest.files || {})) if (!fs.existsSync(path.join(piWebRoot, name)) || hashFile(path.join(piWebRoot, name)) !== hash) return { action: "preserved", reason: "modified", file: name };
  const restored = Object.hasOwn(manifest.files, LAUNCHER_REL) ? [ROUTE_REL, INDEX_REL, LAUNCHER_REL] : [ROUTE_REL, INDEX_REL];
  for (const name of restored) {
    const backup = backupName(path.join(piWebRoot, name));
    if (!fs.existsSync(backup)) return { action: "preserved", reason: "modified", file: name };
    if (name === LAUNCHER_REL && !launcherBackupMatches(piWebRoot)) return { action: "preserved", reason: "modified", file: name };
  }
  for (const name of restored) {
    fs.copyFileSync(backupName(path.join(piWebRoot, name)), path.join(piWebRoot, name));
    fs.unlinkSync(backupName(path.join(piWebRoot, name)));
  }
  injectedFailure("remove-route");
  for (const name of Object.hasOwn(manifest.files, LAUNCHER_REL) ? [BRIDGE_REL, CLIENT_REL, REFRESH_REL] : [BRIDGE_REL, CLIENT_REL]) fs.unlinkSync(path.join(piWebRoot, name));
  injectedFailure("remove-client");
  fs.unlinkSync(manifestFile);
  return { action: "removed" };
  } catch (error) {
    try { restoreIntegrationSnapshot(snapshot); } catch (rollbackError) { throw new Error(`Pi Web integration removal failed: ${error.message}; rollback failed: ${rollbackError.message}`); }
    throw error;
  }
}

function main(argv) {
  const [command, repoRoot, piWebRoot] = argv;
  try {
    const result = command === "apply" ? applyIntegration({ repoRoot, piWebRoot }) : command === "finalize" ? finalizeIntegration({ repoRoot, piWebRoot }) : command === "verify" ? verifyIntegration({ repoRoot, piWebRoot }) : command === "remove" ? removeIntegration(piWebRoot) : null;
    if (!result) { console.error("Usage: pui-web-integration.js <apply|finalize|verify|remove> <repo-root> <pi-web-root>"); return 64; }
    console.log(JSON.stringify(result));
    return result.ok === false || result.action === "preserved" ? 1 : 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 1; }
}

module.exports = { applyIntegration, finalizeIntegration, patchIndex, patchRoute, removeIntegration, verifyIntegration, versionClientReference };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
