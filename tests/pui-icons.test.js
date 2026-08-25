const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const iconScript = path.join(repoRoot, "lib", "pui-icons.js");
const browserSizes = [16, 24, 32, 48, 64];
const pwaSizes = [72, 96, 128, 192, 256, 384, 512];
const maskableSizes = [128, 192, 256, 384, 512];
const appleIcons = [
  ["icon-120.png", 120],
  ["icon-152.png", 152],
  ["icon-167.png", 167],
  ["apple-touch-icon.png", 180],
];
const allIconNames = [
  ...new Set([
    ...browserSizes.map((size) => `icon-${size}.png`),
    ...pwaSizes.map((size) => `icon-${size}.png`),
    ...maskableSizes.map((size) => `maskable-${size}.png`),
    ...appleIcons.map(([name]) => name),
  ]),
];

function readPngHeader(file) {
  const png = fs.readFileSync(file);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${path.basename(file)} is not a PNG`,
  );
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png[25],
    hasTransparencyChunk: png.includes(Buffer.from("tRNS", "ascii")),
  };
}

test("Apple icons are opaque full-canvas squares at their declared sizes", () => {
  for (const [name, size] of appleIcons) {
    const header = readPngHeader(path.join(repoRoot, "assets", "icons", name));
    assert.deepEqual([header.width, header.height], [size, size], name);
    assert.equal(header.colorType, 2, `${name} must be opaque RGB, not pre-masked RGBA`);
    assert.equal(header.hasTransparencyChunk, false, `${name} must not contain transparency`);
  }
});

test("maskable icons are opaque full-canvas squares at their declared sizes", () => {
  for (const size of maskableSizes) {
    const name = `maskable-${size}.png`;
    const header = readPngHeader(path.join(repoRoot, "assets", "icons", name));
    assert.deepEqual([header.width, header.height], [size, size], name);
    assert.equal(header.colorType, 2, `${name} must be opaque RGB`);
    assert.equal(header.hasTransparencyChunk, false, `${name} must not contain transparency`);
  }
});

function write(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("apply installs every icon in its browser, PWA, or Apple context", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-icons-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const assets = path.join(temp, "assets");
  const piWeb = path.join(temp, "pi-web");

  for (const name of allIconNames) write(assets, name, `pui-${name}`);
  const original192 = write(piWeb, "public/icons/icon-192.png", "upstream-192");
  const faviconBody = write(piWeb, ".next/server/app/favicon.ico.body", "upstream-favicon");
  const faviconMeta = write(
    piWeb,
    ".next/server/app/favicon.ico.meta",
    JSON.stringify({ status: 200, headers: { "content-type": "image/x-icon" } }),
  );
  const page = write(
    piWeb,
    ".next/server/app/page.js",
    'const metadata={icons:{icon:[{url:"/icons/icon-192.png",sizes:"192x192",type:"image/png"}],apple:[{url:"/icons/apple-touch-icon.png",sizes:"180x180",type:"image/png"}]}};',
  );
  const html = write(
    piWeb,
    ".next/server/app/index.html",
    '<link rel="icon" href="/favicon.ico?hash" type="image/x-icon" sizes="512x512"/><link rel="icon" href="/icons/icon-192.png" sizes="192x192" type="image/png"/><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" sizes="180x180" type="image/png"/>\n[[\\"$\\",\\"link\\",\\"8\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/favicon.ico?hash\\",\\"type\\":\\"image/x-icon\\",\\"sizes\\":\\"512x512\\"}],[\\"$\\",\\"link\\",\\"9\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/icons/icon-192.png\\",\\"sizes\\":\\"192x192\\",\\"type\\":\\"image/png\\"}],[\\"$\\",\\"link\\",\\"10\\",{\\"rel\\":\\"apple-touch-icon\\",\\"href\\":\\"/icons/apple-touch-icon.png\\",\\"sizes\\":\\"180x180\\",\\"type\\":\\"image/png\\"}]]',
  );
  const rsc = write(
    piWeb,
    ".next/server/app/index.rsc",
    '[["$","link","8",{"rel":"icon","href":"/favicon.ico?hash","type":"image/x-icon","sizes":"512x512"}],["$","link","9",{"rel":"icon","href":"/icons/icon-192.png","sizes":"192x192","type":"image/png"}],["$","link","10",{"rel":"apple-touch-icon","href":"/icons/apple-touch-icon.png","sizes":"180x180","type":"image/png"}]]',
  );
  const serviceWorker = write(
    piWeb,
    "public/sw.js",
    'const PRECACHE_URLS=["/offline.html","/manifest.webmanifest","/icons/icon-192.png","/icons/icon-512.png","/icons/apple-touch-icon.png"];',
  );
  const manifestBody = write(
    piWeb,
    ".next/server/app/manifest.webmanifest.body",
    JSON.stringify({ name: "PUI", icons: [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" }] }),
  );
  const manifestRoute = write(
    piWeb,
    ".next/server/app/manifest.webmanifest/route.js",
    'const manifest={name:"PUI",icons:[{src:"/icons/icon-192.png",sizes:"192x192",type:"image/png",purpose:"any"},{src:"/icons/icon-512.png",sizes:"512x512",type:"image/png",purpose:"any"}]};',
  );

  const result = spawnSync(process.execPath, [iconScript, "apply", assets, piWeb], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const name of allIconNames) {
    assert.equal(
      fs.readFileSync(path.join(piWeb, "public", "icons", name), "utf8"),
      `pui-${name}`,
    );
  }
  assert.equal(fs.readFileSync(`${original192}.pui-original`, "utf8"), "upstream-192");
  assert.equal(fs.existsSync(path.join(piWeb, "public", "icons", "icon-16.png.pui-created")), true);
  assert.equal(fs.readFileSync(faviconBody, "utf8"), "pui-icon-32.png");
  assert.equal(fs.readFileSync(`${faviconBody}.pui-original`, "utf8"), "upstream-favicon");
  assert.equal(JSON.parse(fs.readFileSync(faviconMeta, "utf8")).headers["content-type"], "image/png");

  const manifest = JSON.parse(fs.readFileSync(manifestBody, "utf8"));
  assert.deepEqual(
    manifest.icons.map(({ src, sizes, type, purpose }) => ({ src, sizes, type, purpose })),
    [
      ...pwaSizes.map((size) => ({
        src: `/icons/icon-${size}.png?v=2`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "any",
      })),
      ...maskableSizes.map((size) => ({
        src: `/icons/maskable-${size}.png?v=2`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose: "maskable",
      })),
    ],
  );

  const pageText = fs.readFileSync(page, "utf8");
  for (const size of browserSizes) assert.match(pageText, new RegExp(`icon-${size}\\.png`));
  for (const [name] of appleIcons) assert.match(pageText, new RegExp(name.replace(".", "\\.")));
  assert.doesNotMatch(pageText, /icon-72\.png/);
  for (const size of browserSizes) assert.match(pageText, new RegExp(`icon-${size}\\.png\\?v=2`));
  for (const [name] of appleIcons) assert.match(pageText, new RegExp(`${name.replace(".", "\\.")}\\?v=2`));

  for (const output of [html, rsc]) {
    const content = fs.readFileSync(output, output.endsWith(".rsc") ? "latin1" : "utf8");
    for (const size of browserSizes) assert.match(content, new RegExp(`icon-${size}\\.png`));
    for (const [name] of appleIcons) assert.match(content, new RegExp(name.replace(".", "\\.")));
    assert.match(content, /favicon\.ico\?hash/);
    assert.doesNotMatch(content, /image\/x-icon|512x512[^\n]*favicon/);
    for (const size of browserSizes) assert.match(content, new RegExp(`icon-${size}\\.png\\?v=2`));
    for (const [name] of appleIcons) assert.match(content, new RegExp(`${name.replace(".", "\\.")}\\?v=2`));
    assert.match(content, /favicon\.ico\?hash&v=2/);
  }
  for (const size of pwaSizes) assert.match(fs.readFileSync(manifestRoute, "utf8"), new RegExp(`icon-${size}\\.png`));
  for (const size of pwaSizes) assert.match(fs.readFileSync(manifestRoute, "utf8"), new RegExp(`icon-${size}\\.png\\?v=2`));
  for (const size of maskableSizes) {
    assert.match(fs.readFileSync(manifestRoute, "utf8"), new RegExp(`maskable-${size}\\.png`));
    assert.match(fs.readFileSync(manifestRoute, "utf8"), new RegExp(`maskable-${size}\\.png\\?v=2`));
  }
  assert.match(fs.readFileSync(serviceWorker, "utf8"), /icon-192\.png\?v=2/);
  assert.match(fs.readFileSync(serviceWorker, "utf8"), /icon-512\.png\?v=2/);
  assert.match(fs.readFileSync(serviceWorker, "utf8"), /apple-touch-icon\.png\?v=2/);
});

test("every install and update entry point uses the shared icon helper", () => {
  for (const script of ["install.ps1", "update.ps1", "install.sh", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /lib[\\/]pui-icons\.js/);
    assert.doesNotMatch(content, /for f in icon-512\.png|foreach \(\$f in @\("icon-512\.png"/);
  }
});

test("uninstall entry points remove assets that PUI created", () => {
  for (const script of ["uninstall.ps1", "uninstall.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /pui-created/);
  }
});

test("apply rejects an incomplete Pi Web metadata build before copying icons", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pui-icons-incomplete-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const assets = path.join(temp, "assets");
  const piWeb = path.join(temp, "pi-web");
  for (const name of allIconNames) write(assets, name, `pui-${name}`);
  fs.mkdirSync(path.join(piWeb, ".next", "server", "app"), { recursive: true });

  const result = spawnSync(process.execPath, [iconScript, "apply", assets, piWeb], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required Pi Web metadata file/i);
  assert.equal(fs.existsSync(path.join(piWeb, "public", "icons", "icon-16.png")), false);
});
