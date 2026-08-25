#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DESCRIPTION = "PUI - opinionated Pi setup";

const BRAND_REPLACEMENTS = [
  ['description:"Pi Web interface for the pi coding agent"', `description:"${DESCRIPTION}"`],
  ['description:"Local web interface for the pi coding agent"', `description:"${DESCRIPTION}"`],
  ['applicationName:"Pi Web"', 'applicationName:"PUI"'],
  ['short_name:"Pi Web"', 'short_name:"PUI"'],
  ['title:"Pi Web"', 'title:"PUI"'],
  ['name:"Pi Web"', 'name:"PUI"'],
  ['"description":"Pi Web interface for the pi coding agent"', `"description":"${DESCRIPTION}"`],
  ['"description":"Local web interface for the pi coding agent"', `"description":"${DESCRIPTION}"`],
  ['"content":"Pi Web interface for the pi coding agent"', `"content":"${DESCRIPTION}"`],
  [
    '"name":"application-name","content":"Pi Web"',
    '"name":"application-name","content":"PUI"',
  ],
  [
    '"name":"apple-mobile-web-app-title","content":"Pi Web"',
    '"name":"apple-mobile-web-app-title","content":"PUI"',
  ],
  ['"short_name":"Pi Web"', '"short_name":"PUI"'],
  ['"name":"Pi Web"', '"name":"PUI"'],
  ['<title>Pi Web</title>', '<title>PUI</title>'],
  [
    'name="description" content="Pi Web interface for the pi coding agent"',
    `name="description" content="${DESCRIPTION}"`,
  ],
  ['name="application-name" content="Pi Web"', 'name="application-name" content="PUI"'],
  ['name="apple-mobile-web-app-title" content="Pi Web"', 'name="apple-mobile-web-app-title" content="PUI"'],
  ['children\\":\\"Pi Web\\"', 'children\\":\\"PUI\\"'],
  ['"children":"Pi Web"', '"children":"PUI"'],
  ['children:"Pi Web"', 'children:"PUI"'],
  [
    '\\"content\\":\\"Pi Web interface for the pi coding agent\\"',
    `\\"content\\":\\"${DESCRIPTION}\\"`,
  ],
  [
    '\\"name\\":\\"application-name\\",\\"content\\":\\"Pi Web\\"',
    '\\"name\\":\\"application-name\\",\\"content\\":\\"PUI\\"',
  ],
  [
    '\\"name\\":\\"apple-mobile-web-app-title\\",\\"content\\":\\"Pi Web\\"',
    '\\"name\\":\\"apple-mobile-web-app-title\\",\\"content\\":\\"PUI\\"',
  ],
  [' - Pi Web`:"Pi Web";', ' - PUI`:"PUI";'],
];

function replaceBranding(content) {
  let result = content;
  for (const [from, to] of BRAND_REPLACEMENTS) {
    result = result.replaceAll(from, to);
  }
  result = result.replace(
    /(\?"\d+\.\d+\.\d+p\d+\.\d+\.\d+":)"Pi Web"(?=[,);])/g,
    '$1"PUI"',
  );
  return result;
}

function patchFile(file, encoding = "utf8", transform = replaceBranding) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;

  const original = fs.readFileSync(file, encoding);
  const branded = transform(original);
  if (branded === original) return false;

  const backup = `${file}.pui-original`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, branded, encoding);
  return true;
}

function listFiles(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(directory, entry.name));
}

function listFilesRecursive(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(target, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(target);
  }
  return files;
}

function patchServiceWorker(file) {
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, "utf8");
  const pattern = /-static-\$\{CACHE_VERSION\}[^`]*`;/;
  if (!pattern.test(original)) {
    throw new Error(`Pi Web service worker cache declaration not found: ${file}`);
  }
  const branded = original.replace(
    pattern,
    `-static-\${CACHE_VERSION}-pui-${Date.now()}\`;`,
  );
  const backup = `${file}.pui-original`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, branded, "utf8");
  return true;
}

function applyBranding(piWebRoot) {
  const root = path.resolve(piWebRoot);
  const serverApp = path.join(root, ".next", "server", "app");
  const clientApp = path.join(root, ".next", "static", "chunks", "app");
  if (!fs.existsSync(serverApp)) {
    throw new Error(`Pi Web build output not found: ${serverApp}`);
  }

  const textFiles = [
    path.join(serverApp, "page.js"),
    path.join(serverApp, "_not-found", "page.js"),
    path.join(serverApp, "index.html"),
    path.join(serverApp, "_not-found.html"),
    path.join(serverApp, "pages", "404.html"),
    path.join(serverApp, "manifest.webmanifest", "route.js"),
    path.join(serverApp, "manifest.webmanifest.body"),
    ...listFiles(clientApp, (name) => /^page-.*\.js$/.test(name)),
  ];
  const rscFiles = listFilesRecursive(serverApp, (name) => name.endsWith(".rsc"));
  const serviceWorker = path.join(root, "public", "sw.js");

  let changed = 0;
  for (const file of new Set(textFiles)) changed += Number(patchFile(file));
  for (const file of rscFiles) changed += Number(patchFile(file, "latin1"));
  changed += Number(patchServiceWorker(serviceWorker));
  return changed;
}

function main(argv) {
  const [command, piWebRoot] = argv;
  if (command !== "apply" || !piWebRoot) {
    console.error("Usage: pui-branding.js apply <pi-web-package-root>");
    return 1;
  }

  try {
    const changed = applyBranding(piWebRoot);
    console.log(`  PUI text branding applied (${changed} file${changed === 1 ? "" : "s"} changed)`);
    return 0;
  } catch (error) {
    console.error(`  PUI text branding failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { applyBranding, replaceBranding };
