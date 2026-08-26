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
  return manifest.owner === "PUI" && manifest.schemaVersion === 1 && JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(keys) && manifest.identityHash === integrationIdentityHash(manifest);
}
function backupName(file) { return `${file}.pui-update-original`; }

function routeReplacement() {
  return `62445:(a,b,c)=>{"use strict";/*${ROUTE_MARKER}*/c.r(b),c.d(b,{DELETE:()=>i,GET:()=>g,POST:()=>h,dynamic:()=>d});var e=c(23211);let d="force-dynamic",f=require("../../../../../${BRIDGE_REL}");async function g(){return e.NextResponse.json(await f.getUpdate())}async function h(a){try{let b=await a.json();return e.NextResponse.json(await f.startUpdate(b.target),{status:202})}catch(a){return e.NextResponse.json({error:a instanceof Error?a.message:String(a)},{status:409})}}async function i(){return e.NextResponse.json(f.acknowledge())}}`;
}

function patchRoute(content) {
  const pattern = /62445:\(a,b,c\)=>\{[\s\S]*?\},63033:/;
  if (!pattern.test(content) || !content.includes('h="0.8.10"') || !content.includes("registry.npmjs.org/@agegr%2Fpi-web/latest")) {
    throw new Error("Expected Pi Web app-update route for 0.8.10 was not found");
  }
  return content.replace(pattern, `${routeReplacement()},63033:`);
}

function patchIndex(content, puiVersion) {
  if (!content.includes("</body>")) throw new Error("Expected Pi Web app index body was not found");
  return content.replace("</body>", `<script src="/pui-update.js?pui=${puiVersion}" defer></script></body>`);
}

function applyIntegration({ repoRoot, piWebRoot }) {
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
  if (!fs.existsSync(backupName(route))) fs.copyFileSync(route, backupName(route));
  if (!fs.existsSync(backupName(index))) fs.copyFileSync(index, backupName(index));
  fs.writeFileSync(route, patchRoute(fs.readFileSync(route, "utf8")));
  fs.writeFileSync(index, patchIndex(fs.readFileSync(index, "utf8"), release.version));
  fs.copyFileSync(path.join(repoRoot, "lib", "pui-update-bridge.cjs"), path.join(piWebRoot, BRIDGE_REL));
  fs.copyFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), path.join(piWebRoot, CLIENT_REL));
  const files = [ROUTE_REL, INDEX_REL, BRIDGE_REL, CLIENT_REL];
  const manifest = { owner: "PUI", schemaVersion: 1, piWebVersion: installed.version, files: Object.fromEntries(files.map((name) => [name, hashFile(path.join(piWebRoot, name))])) };
  manifest.identityHash = integrationIdentityHash(manifest);
  fs.writeFileSync(path.join(piWebRoot, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
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
  for (const name of [BRIDGE_REL, CLIENT_REL]) fs.unlinkSync(path.join(piWebRoot, name));
  fs.unlinkSync(manifestFile);
  return { action: "removed" };
}

function main(argv) {
  const [command, repoRoot, piWebRoot] = argv;
  try {
    const result = command === "apply" ? applyIntegration({ repoRoot, piWebRoot }) : command === "verify" ? verifyIntegration({ repoRoot, piWebRoot }) : command === "remove" ? removeIntegration(piWebRoot) : null;
    if (!result) { console.error("Usage: pui-web-integration.js <apply|verify|remove> <repo-root> <pi-web-root>"); return 64; }
    console.log(JSON.stringify(result));
    return result.ok === false || result.action === "preserved" ? 1 : 0;
  } catch (error) { console.error(`ERROR: ${error.message}`); return 1; }
}

module.exports = { applyIntegration, patchIndex, patchRoute, removeIntegration, verifyIntegration };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
