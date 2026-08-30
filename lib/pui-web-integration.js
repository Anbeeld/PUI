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
const ROUTE_MARKER = "PUI_UPDATE_BRIDGE_V1";

function hashFile(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function integrationIdentityHash(manifest) {
  const core = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, piWebVersion: manifest.piWebVersion, files: manifest.files };
  return crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex");
}
function validManifest(manifest) {
  const keys = ["files", "identityHash", "owner", "piWebVersion", "schemaVersion"];
  const files = manifest && manifest.files;
  const expectedFiles = [ROUTE_REL, INDEX_REL, BRIDGE_REL, CLIENT_REL].sort();
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
  const files = [ROUTE_REL, INDEX_REL, BRIDGE_REL, CLIENT_REL, MANIFEST, `${ROUTE_REL}.pui-update-original`, `${INDEX_REL}.pui-update-original`];
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
  if (!fs.existsSync(backupName(route))) fs.copyFileSync(route, backupName(route));
  if (!fs.existsSync(backupName(index))) fs.copyFileSync(index, backupName(index));
  injectedFailure("backup");
  fs.writeFileSync(route, patchRoute(fs.readFileSync(route, "utf8"), release.stack.upstream.gui.version));
  injectedFailure("route");
  fs.writeFileSync(index, patchIndex(fs.readFileSync(index, "utf8"), release.version));
  injectedFailure("index");
  fs.copyFileSync(path.join(repoRoot, "lib", "pui-update-bridge.cjs"), path.join(piWebRoot, BRIDGE_REL));
  fs.copyFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), path.join(piWebRoot, CLIENT_REL));
  injectedFailure("client");
  const files = [ROUTE_REL, INDEX_REL, BRIDGE_REL, CLIENT_REL];
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
    const expected = loadRelease(repoRoot).stack.upstream.gui.version;
    const manifest = JSON.parse(fs.readFileSync(path.join(piWebRoot, MANIFEST), "utf8"));
    if (!validManifest(manifest)) return { ok: false, reason: "modified" };
    if (manifest.piWebVersion !== expected) return { ok: false, reason: "version-mismatch" };
    for (const [name, hash] of Object.entries(manifest.files || {})) if (hashFile(path.join(piWebRoot, name)) !== hash) return { ok: false, reason: "modified", file: name };
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
  for (const name of [ROUTE_REL, INDEX_REL]) {
    if (!fs.existsSync(backupName(path.join(piWebRoot, name)))) return { action: "preserved", reason: "modified", file: name };
  }
  for (const name of [ROUTE_REL, INDEX_REL]) {
    fs.copyFileSync(backupName(path.join(piWebRoot, name)), path.join(piWebRoot, name));
    fs.unlinkSync(backupName(path.join(piWebRoot, name)));
  }
  injectedFailure("remove-route");
  for (const name of [BRIDGE_REL, CLIENT_REL]) fs.unlinkSync(path.join(piWebRoot, name));
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
