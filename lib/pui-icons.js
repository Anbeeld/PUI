#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BROWSER_SIZES = [16, 24, 32, 48, 64];
const PWA_SIZES = [72, 96, 128, 192, 256, 384, 512];
const MASKABLE_SIZES = [128, 192, 256, 384, 512];
const APPLE_ICONS = [
  ["icon-120.png", 120],
  ["icon-152.png", 152],
  ["icon-167.png", 167],
  ["apple-touch-icon.png", 180],
];
const ICON_NAMES = [
  ...new Set([
    ...BROWSER_SIZES.map((size) => `icon-${size}.png`),
    ...PWA_SIZES.map((size) => `icon-${size}.png`),
    ...MASKABLE_SIZES.map((size) => `maskable-${size}.png`),
    ...APPLE_ICONS.map(([name]) => name),
  ]),
];

function backupExisting(file) {
  const backup = `${file}.pui-original`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
}

function installAsset(source, destination) {
  const sourceBytes = fs.readFileSync(source);
  if (fs.existsSync(destination)) {
    const currentBytes = fs.readFileSync(destination);
    if (currentBytes.equals(sourceBytes)) return false;
    backupExisting(destination);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const marker = `${destination}.pui-created`;
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, "");
  }
  fs.copyFileSync(source, destination);
  return true;
}

function patchTextFile(file, transform, encoding = "utf8") {
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, encoding);
  const patched = transform(original);
  if (patched === original) return false;
  backupExisting(file);
  fs.writeFileSync(file, patched, encoding);
  return true;
}

function iconDescriptor(name, size) {
  return `{url:"/icons/${name}",sizes:"${size}x${size}",type:"image/png"}`;
}

function patchMetadata(content) {
  const browser = BROWSER_SIZES.map((size) => iconDescriptor(`icon-${size}.png`, size)).join(",");
  const apple = APPLE_ICONS.map(([name, size]) => iconDescriptor(name, size)).join(",");
  return content.replace(
    /icons:\{icon:\[(?:\{[^{}]*\},?)*\],apple:\[(?:\{[^{}]*\},?)*\]\}/g,
    `icons:{icon:[${browser}],apple:[${apple}]}`,
  );
}

function htmlLinks(rel, icons) {
  return icons
    .map(
      ([name, size]) =>
        `<link rel="${rel}" href="/icons/${name}" sizes="${size}x${size}" type="image/png"/>`,
    )
    .join("");
}

function rscLinks(rel, icons, escaped) {
  const encode = (value) => (escaped ? value.replaceAll('"', '\\"') : value);
  return icons
    .map(([name, size]) =>
      encode(
        `["$","link","pui-${rel}-${size}",{"rel":"${rel}","href":"/icons/${name}","sizes":"${size}x${size}","type":"image/png"}]`,
      ),
    )
    .join(",");
}

function patchRscLinks(content) {
  const q = String.raw`\\?"`;
  const rscItem = (rel, href) =>
    String.raw`\[${q}\$${q},${q}link${q},${q}[^"\\]+${q},\{${q}rel${q}:${q}${rel}${q},${q}href${q}:${q}${href}${q},${q}sizes${q}:${q}\d+x\d+${q},${q}type${q}:${q}image\/png${q}\}\]`;
  const replaceGroup = (input, rel, href, icons) => {
    const item = rscItem(rel, href);
    const pattern = new RegExp(`${item}(?:,${item})*`, "g");
    return input.replace(pattern, (match) => rscLinks(rel, icons, match.includes('\\"')));
  };

  let result = content.replace(
    new RegExp(
      String.raw`\[${q}\$${q},${q}link${q},${q}([^"\\]+)${q},\{${q}rel${q}:${q}icon${q},${q}href${q}:${q}(\/favicon\.ico\?[^"\\]+)${q},${q}type${q}:${q}image\/x-icon${q},${q}sizes${q}:${q}\d+x\d+${q}\}\]`,
      "g",
    ),
    (match, key, href) => {
      const escaped = match.includes('\\"');
      const encoded = `["$","link","${key}",{"rel":"icon","href":"${href}","type":"image/png","sizes":"32x32"}]`;
      return escaped ? encoded.replaceAll('"', '\\"') : encoded;
    },
  );
  result = replaceGroup(
    result,
    "icon",
    String.raw`\/icons\/icon-\d+\.png`,
    BROWSER_SIZES.map((size) => [`icon-${size}.png`, size]),
  );
  result = replaceGroup(
    result,
    "apple-touch-icon",
    String.raw`\/icons\/(?:icon-\d+|apple-touch-icon)\.png`,
    APPLE_ICONS,
  );
  return result;
}

function patchHtml(content) {
  let result = content.replace(
    /<link rel="icon" href="(\/favicon\.ico\?[^"\\]+)" type="image\/x-icon" sizes="\d+x\d+"\/>/g,
    '<link rel="icon" href="$1" type="image/png" sizes="32x32"/>',
  );
  result = result.replace(
    /(?:<link rel="icon" href="\/icons\/icon-\d+\.png" sizes="\d+x\d+" type="image\/png"\/>)+/g,
    htmlLinks(
      "icon",
      BROWSER_SIZES.map((size) => [`icon-${size}.png`, size]),
    ),
  );
  result = result.replace(
    /(?:<link rel="apple-touch-icon" href="\/icons\/(?:icon-\d+|apple-touch-icon)\.png" sizes="\d+x\d+" type="image\/png"\/>)+/g,
    htmlLinks("apple-touch-icon", APPLE_ICONS),
  );
  return patchRscLinks(result);
}

function manifestIcons() {
  return [
    ...PWA_SIZES.map((size) => ({
      src: `/icons/icon-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
    ...MASKABLE_SIZES.map((size) => ({
      src: `/icons/maskable-${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "maskable",
    })),
  ];
}

function patchManifestBody(file) {
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file, "utf8");
  const manifest = JSON.parse(original);
  manifest.icons = manifestIcons();
  const patched = JSON.stringify(manifest);
  if (patched === original) return false;
  backupExisting(file);
  fs.writeFileSync(file, patched);
  return true;
}

function patchManifestRoute(content) {
  const icons = manifestIcons()
    .map(
      ({ src, sizes, type, purpose }) =>
        `{src:"${src}",sizes:"${sizes}",type:"${type}",purpose:"${purpose}"}`,
    )
    .join(",");
  return content.replace(/icons:\[(?:\{[^{}]*\},?)*\]/g, `icons:[${icons}]`);
}

function listRecursive(directory, extension) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listRecursive(target, extension));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(target);
  }
  return files;
}

function applyIcons(assetDirectory, piWebRoot) {
  const assets = path.resolve(assetDirectory);
  const root = path.resolve(piWebRoot);
  const serverApp = path.join(root, ".next", "server", "app");
  const publicIcons = path.join(root, "public", "icons");
  for (const name of ICON_NAMES) {
    if (!fs.existsSync(path.join(assets, name))) throw new Error(`Missing PUI icon: ${name}`);
  }
  if (!fs.existsSync(serverApp)) throw new Error(`Pi Web build output not found: ${serverApp}`);
  const requiredMetadata = [
    "favicon.ico.body",
    "favicon.ico.meta",
    "page.js",
    "index.html",
    "index.rsc",
    "manifest.webmanifest.body",
    path.join("manifest.webmanifest", "route.js"),
  ];
  for (const relative of requiredMetadata) {
    const file = path.join(serverApp, relative);
    if (!fs.existsSync(file)) throw new Error(`Required Pi Web metadata file not found: ${file}`);
  }

  let changed = 0;
  for (const name of ICON_NAMES) {
    changed += Number(installAsset(path.join(assets, name), path.join(publicIcons, name)));
  }
  changed += Number(
    installAsset(path.join(assets, "icon-32.png"), path.join(serverApp, "favicon.ico.body")),
  );

  const faviconMeta = path.join(serverApp, "favicon.ico.meta");
  changed += Number(
    patchTextFile(faviconMeta, (content) => {
      const meta = JSON.parse(content);
      meta.headers["content-type"] = "image/png";
      return JSON.stringify(meta);
    }),
  );
  for (const page of [path.join(serverApp, "page.js"), path.join(serverApp, "_not-found", "page.js")]) {
    changed += Number(patchTextFile(page, patchMetadata));
  }
  for (const html of listRecursive(serverApp, ".html")) {
    changed += Number(patchTextFile(html, patchHtml));
  }
  for (const rsc of listRecursive(serverApp, ".rsc")) {
    changed += Number(patchTextFile(rsc, patchRscLinks, "latin1"));
  }
  changed += Number(patchManifestBody(path.join(serverApp, "manifest.webmanifest.body")));
  changed += Number(
    patchTextFile(path.join(serverApp, "manifest.webmanifest", "route.js"), patchManifestRoute),
  );
  return changed;
}

function main(argv) {
  const [command, assetDirectory, piWebRoot] = argv;
  if (command !== "apply" || !assetDirectory || !piWebRoot) {
    console.error("Usage: pui-icons.js apply <asset-directory> <pi-web-package-root>");
    return 1;
  }
  try {
    const changed = applyIcons(assetDirectory, piWebRoot);
    console.log(`  PUI icons applied (${changed} file${changed === 1 ? "" : "s"} changed)`);
    return 0;
  } catch (error) {
    console.error(`  PUI icon override failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { applyIcons, patchHtml, patchManifestRoute, patchMetadata, patchRscLinks };
