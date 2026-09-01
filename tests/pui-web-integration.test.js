const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const {
  applyIntegration,
  finalizeIntegration,
  removeIntegration,
  verifyIntegration,
  patchRoute,
} = require(path.join(repoRoot, "lib", "pui-web-integration.js"));

function piWebFixture(root) {
  fs.mkdirSync(path.join(root, ".next", "server", "app", "api", "app-update"), { recursive: true });
  fs.mkdirSync(path.join(root, ".next", "server", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.mkdirSync(path.join(root, ".next", "static", "chunks", "app"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.11" }));
  fs.writeFileSync(path.join(root, ".next", "server", "app", "api", "app-update", "route.js"), 'x={62445:(a,b,c)=>{"use strict";c.r(b),c.d(b,{GET:()=>l,dynamic:()=>g});let g="force-dynamic",h="0.8.11";let u="registry.npmjs.org/@agegr%2Fpi-web/latest"},63033:a=>{}}');
  fs.writeFileSync(path.join(root, ".next", "server", "app", "index.html"), '<html><body><script src="/_next/static/chunks/app/page-build.js?pui=a1b2c3d4e5f6"></script>PUI</body></html>');
  fs.writeFileSync(path.join(root, ".next", "static", "chunks", "app", "page-build.js"), "branding bytes");
}

test("apply restores every pre-operation byte when a later integration write fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  piWebFixture(root);
  const before = new Map();
  for (const file of [".next/server/app/api/app-update/route.js", ".next/server/app/index.html", ".next/server/app/api/app-update/route.js.pui-update-original", ".next/server/app/index.html.pui-update-original", "pui-update-bridge.cjs", "public/pui-update.js", ".pui-update-integration.json"]) {
    const target = path.join(root, file);
    before.set(file, fs.existsSync(target) ? fs.readFileSync(target) : null);
  }
  const previous = process.env.PUI_FAIL_INTEGRATION_AT;
  process.env.PUI_FAIL_INTEGRATION_AT = "client";
  try { assert.throws(() => applyIntegration({ repoRoot, piWebRoot: root }), /injected/i); }
  finally { if (previous === undefined) delete process.env.PUI_FAIL_INTEGRATION_AT; else process.env.PUI_FAIL_INTEGRATION_AT = previous; }
  for (const [file, bytes] of before) assert.equal(fs.existsSync(path.join(root, file)), bytes !== null, file);
  for (const [file, bytes] of before) if (bytes !== null) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
});

test("remove restores every pre-operation byte when a later removal fails", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-remove-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  piWebFixture(root);
  applyIntegration({ repoRoot, piWebRoot: root });
  const files = [".next/server/app/api/app-update/route.js", ".next/server/app/index.html", ".next/server/app/api/app-update/route.js.pui-update-original", ".next/server/app/index.html.pui-update-original", "pui-update-bridge.cjs", "public/pui-update.js", ".pui-update-integration.json"];
  const before = new Map(files.map((file) => { const target = path.join(root, file); return [file, fs.existsSync(target) ? fs.readFileSync(target) : null]; }));
  const previous = process.env.PUI_FAIL_INTEGRATION_AT;
  process.env.PUI_FAIL_INTEGRATION_AT = "remove-client";
  try { assert.throws(() => removeIntegration(root), /injected/i); }
  finally { if (previous === undefined) delete process.env.PUI_FAIL_INTEGRATION_AT; else process.env.PUI_FAIL_INTEGRATION_AT = previous; }
  for (const [file, bytes] of before) assert.equal(fs.existsSync(path.join(root, file)), bytes !== null, file);
  for (const [file, bytes] of before) if (bytes !== null) assert.deepEqual(fs.readFileSync(path.join(root, file)), bytes, file);
});

test("Pi Web integration fails closed on an unexpected package layout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.11" }));
  assert.throws(() => applyIntegration({ repoRoot, piWebRoot: root }), /expected.*app-update/i);
});

test("integration finalization versions its owned index from the final client bundle", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-finalize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  piWebFixture(root);
  const index = path.join(root, ".next", "server", "app", "index.html");
  const originalIndex = fs.readFileSync(index, "utf8");
  applyIntegration({ repoRoot, piWebRoot: root });
  const client = path.join(root, ".next", "static", "chunks", "app", "page-build.js");
  fs.writeFileSync(client, "final reasoning-patched bytes");
  const version = crypto.createHash("sha256").update(fs.readFileSync(client)).digest("hex").slice(0, 12);
  assert.equal(finalizeIntegration({ repoRoot, piWebRoot: root }).ok, true);
  assert.match(fs.readFileSync(index, "utf8"), new RegExp(`page-build\\.js\\?pui=${version}`));
  assert.equal(verifyIntegration({ repoRoot, piWebRoot: root }).ok, true);
  assert.equal(removeIntegration(root).action, "removed");
  assert.equal(fs.readFileSync(index, "utf8"), originalIndex);
});

test("client update card encodes install, exact skip, close, progress, rollback, and reload semantics", () => {
  const client = fs.readFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), "utf8");
  assert.match(client, /localStorage/);
  assert.match(client, /Skip version/);
  assert.match(client, /Install/);
  assert.match(client, /Reload PUI/);
  assert.match(client, /location\.reload/);
  assert.match(client, /bottom-right|position:\s*fixed/i);
  assert.match(client, /Restoring previous version/);
  assert.match(client, /aborted/);
  assert.match(client, /method:\s*"DELETE"/);
});

test("client update card follows Pi Web theme and aligns primary controls", () => {
  const client = fs.readFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), "utf8");
  for (const token of ["--bg-panel", "--bg", "--text", "--border", "--accent", "--bg-hover"]) {
    assert.match(client, new RegExp(`var\\(${token.replace("-", "\\-")}`), token);
  }
  assert.ok(client.indexOf('actions.append(button("Install"') < client.indexOf('actions.append(button("Skip version"'));
  assert.match(client, /\.pui-update-button\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*height:\s*40px/s);
  assert.match(client, /\.pui-update-close\s*\{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*padding:\s*0/s);
});

test("client update card keeps one footprint and distinguishes service restart from browser reload", () => {
  const client = fs.readFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), "utf8");
  assert.match(client, /\.pui-update-card\s*\{[^}]*min-height:\s*112px/s);
  assert.match(client, /restarting:\s*"Restarting Pi Web…"/);
  assert.doesNotMatch(client, /Restarting PUI/);
  assert.match(client, /\.pui-update-close::before[^}]*\.pui-update-close::after/s);
  assert.match(client, /transform:\s*translate\(-50%,\s*-50%\) rotate\(45deg\)/);
  assert.match(client, /transform:\s*translate\(-50%,\s*-50%\) rotate\(-45deg\)/);
});

test("restart control mirrors the sidebar refresh button footprint and theming", () => {
  const client = fs.readFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), "utf8");
  const block = client.match(/\.pui-restart-button\s*\{([^}]*)\}/s);
  assert.ok(block, "restart button style block exists");
  assert.match(block[1], /width:\s*28px/, "compact 28px width");
  assert.match(block[1], /height:\s*28px/, "compact 28px height");
  assert.match(block[1], /border-radius:\s*7px/);
  assert.match(block[1], /right:\s*4px/, "uses the requested right inset");
  assert.match(block[1], /bottom:\s*4px/, "uses the requested bottom inset");
  assert.match(block[1], /background:\s*transparent/, "glyph-only resting state");
  assert.match(block[1], /border:\s*(?:none|0)/, "no resting border");
  assert.doesNotMatch(block[1], /box-shadow/, "no shadow");
  assert.match(block[1], /color:\s*rgb\(128,\s*136,\s*150\)/, "resting glyph uses muted RGB color");
  assert.match(client, /M3 3v5h5/, "same rotate glyph as the sidebar refresh button");
  assert.doesNotMatch(block[1], /filter/, "glyph brightness uses color rather than a filter");
  assert.match(block[1], /color:\s*rgb\(128,\s*136,\s*150\)/, "resting glyph uses muted RGB color");
  assert.match(client, /\.pui-restart-button:hover[^{]*\{[^}]*color:\s*rgb\(96,\s*106,\s*122\)/s, "hover glyph uses a slightly darker muted RGB color");
  assert.match(client, /\.pui-restart-button:hover[^{]*\{[^}]*var\(--bg-hover/s, "light-grey hover background");
});

test("bridge integration verification checks the exact pinned Pi Web version", () => {
  const stack = require(path.join(repoRoot, "stack.json"));
  assert.equal(stack.upstream.gui.version, "0.8.11");
  assert.equal(typeof verifyIntegration, "function");
});

function bridgeStatusFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-update-stale-"));
  const extensionRoot = path.join(root, "pui-update");
  const statusFile = path.join(root, "status.json");
  const lockFile = path.join(root, "lock.json");
  fs.mkdirSync(extensionRoot);
  const core = { owner: "PUI", schemaVersion: 1, puiVersion: "1.0.4", managed: {}, files: {} };
  const manifest = {
    ...core,
    identityHash: crypto.createHash("sha256").update(JSON.stringify(core)).digest("hex"),
  };
  fs.writeFileSync(path.join(extensionRoot, "updater.js"), [
    `module.exports = { STATUS_FILE: ${JSON.stringify(statusFile)}, LOCK_FILE: ${JSON.stringify(lockFile)}, chooseStableUpdate: () => null, restartPiWeb: () => ({ accepted: true, pid: 123 }),`,
    `writeStatus: (status) => { require("node:fs").writeFileSync(${JSON.stringify(statusFile)}, JSON.stringify({ id: "fixture", ...status })); } };`,
  ].join("\n"));
  for (const name of ["index.ts", "pui-release.js", "pui-config.js"]) fs.writeFileSync(path.join(extensionRoot, name), `// ${name}`);
  manifest.files = Object.fromEntries(["index.ts", "updater.js", "pui-release.js", "pui-config.js"].map((name) => [
    name,
    crypto.createHash("sha256").update(fs.readFileSync(path.join(extensionRoot, name))).digest("hex"),
  ]));
  const updatedCore = { owner: manifest.owner, schemaVersion: manifest.schemaVersion, puiVersion: manifest.puiVersion, managed: manifest.managed, files: manifest.files };
  manifest.identityHash = crypto.createHash("sha256").update(JSON.stringify(updatedCore)).digest("hex");
  fs.writeFileSync(path.join(extensionRoot, "manifest.json"), JSON.stringify(manifest));

  const bridgePath = path.join(repoRoot, "lib", "pui-update-bridge.cjs");
  const previousExtensionRoot = process.env.PUI_UPDATE_EXTENSION_DIR;
  const previousFetch = global.fetch;
  process.env.PUI_UPDATE_EXTENSION_DIR = extensionRoot;
  global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: "v1.0.4" }) });
  delete require.cache[require.resolve(bridgePath)];
  t.after(() => {
    if (previousExtensionRoot === undefined) delete process.env.PUI_UPDATE_EXTENSION_DIR;
    else process.env.PUI_UPDATE_EXTENSION_DIR = previousExtensionRoot;
    global.fetch = previousFetch;
    delete require.cache[require.resolve(bridgePath)];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { bridgePath, extensionRoot, lockFile, statusFile };
}

test("bridge rejects a drifted installed updater before loading it", async (t) => {
  const { bridgePath, extensionRoot } = bridgeStatusFixture(t);
  fs.appendFileSync(path.join(extensionRoot, "updater.js"), "\n// drift");
  const result = await require(bridgePath).getUpdate();
  assert.match(result.error || "", /hash mismatch/i);
  assert.equal(result.updateAvailable, false);
});

test("bridge verifies installed updater bytes before acknowledge and restart", (t) => {
  const { bridgePath, extensionRoot } = bridgeStatusFixture(t);
  const bridge = require(bridgePath);
  fs.appendFileSync(path.join(extensionRoot, "updater.js"), "\n// drift");
  assert.throws(() => bridge.acknowledge(), /hash mismatch/i);
  assert.throws(() => bridge.restart(), /hash mismatch/i);
});

test("bridge discards stale terminal statuses for a different installed version", async (t) => {
  const { bridgePath, statusFile } = bridgeStatusFixture(t);
  for (const status of [
    { id: "old-success", target: "1.0.3", phase: "complete", result: "success" },
    { id: "old-rollback", target: "1.0.3", restored: "1.0.3", phase: "complete", result: "rolled-back" },
    { id: "old-abort", target: "1.0.3", phase: "failed", result: "aborted" },
  ]) {
    fs.writeFileSync(statusFile, JSON.stringify(status));
    const result = await require(bridgePath).getUpdate();
    assert.equal(result.currentVersion, "1.0.4");
    assert.equal(result.updateAvailable, false);
    assert.equal(result.result, undefined);
    assert.equal(fs.existsSync(statusFile), false);
  }
});

test("bridge discards orphaned progress but retains the active transaction", async (t) => {
  const { bridgePath, lockFile, statusFile } = bridgeStatusFixture(t);
  const progress = { id: "active", target: "1.0.5", phase: "installing", result: null };

  fs.writeFileSync(statusFile, JSON.stringify(progress));
  let result = await require(bridgePath).getUpdate();
  assert.equal(result.updateAvailable, false);
  assert.equal(result.phase, undefined);
  assert.equal(fs.existsSync(statusFile), false);

  fs.writeFileSync(statusFile, JSON.stringify(progress));
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: progress.id }));
  result = await require(bridgePath).getUpdate();
  assert.equal(result.currentVersion, "1.0.4");
  assert.equal(result.target, "1.0.5");
  assert.equal(result.phase, "installing");
  assert.equal(fs.existsSync(statusFile), true);
});

test("bridge retains terminal status that matches the installed identity", async (t) => {
  const { bridgePath, statusFile } = bridgeStatusFixture(t);
  fs.writeFileSync(statusFile, JSON.stringify({ id: "rollback", target: "1.0.5", restored: "1.0.4", phase: "complete", result: "rolled-back" }));

  const result = await require(bridgePath).getUpdate();
  assert.equal(result.currentVersion, "1.0.4");
  assert.equal(result.result, "rolled-back");
  assert.equal(result.restored, "1.0.4");
  assert.equal(fs.existsSync(statusFile), true);
});

test("bridge restart marks the restarting phase before spawning the restarter", async (t) => {
  const { bridgePath, statusFile } = bridgeStatusFixture(t);
  const result = await require(bridgePath).restart();
  assert.equal(result.accepted, true);
  const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(status.phase, "restarting");
  assert.equal(status.result, null);
  assert.ok(Number.isFinite(status.at), "restart status carries a freshness timestamp");
});

test("bridge restart refuses to overlap an in-flight restart or update", async (t) => {
  const { bridgePath, lockFile, statusFile } = bridgeStatusFixture(t);

  fs.writeFileSync(statusFile, JSON.stringify({ id: "fresh", phase: "restarting", result: null, at: Date.now() }));
  assert.throws(() => require(bridgePath).restart(), /already in progress/);

  fs.writeFileSync(statusFile, JSON.stringify({ id: "active", target: "1.0.5", phase: "installing", result: null }));
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, id: "active" }));
  assert.throws(() => require(bridgePath).restart(), /already in progress/);
});

test("bridge restart proceeds over a stale restart status", async (t) => {
  const { bridgePath, statusFile } = bridgeStatusFixture(t);
  fs.writeFileSync(statusFile, JSON.stringify({ id: "stale", phase: "restarting", result: null, at: Date.now() - 10 * 60 * 1000 }));
  const result = await require(bridgePath).restart();
  assert.equal(result.accepted, true);
});

test("bridge consumes a completed restart once while retaining active and failed restart statuses", async (t) => {
  const { bridgePath, statusFile } = bridgeStatusFixture(t);
  const bridge = require(bridgePath);
  for (const status of [
    { id: "r1", phase: "restarting", result: null, at: Date.now() },
    { id: "r3", phase: "failed", result: "failed", error: "boom" },
  ]) {
    fs.writeFileSync(statusFile, JSON.stringify(status));
    const result = await bridge.getUpdate();
    assert.equal(result.currentVersion, "1.0.4");
    assert.equal(result.phase, status.phase);
    assert.equal(fs.existsSync(statusFile), true, "actionable restart status must be retained");
  }

  fs.writeFileSync(statusFile, JSON.stringify({ id: "r2", phase: "complete", result: "restarted" }));
  const completed = await bridge.getUpdate();
  assert.equal(completed.result, "restarted");
  assert.equal(fs.existsSync(statusFile), false, "completed restart must not suppress future update discovery");
  const discovered = await bridge.getUpdate();
  assert.equal(discovered.result, undefined);
  assert.equal(discovered.currentVersion, "1.0.4");
});

test("uninstall preserves a Pi Web integration whose ownership manifest changed", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-owned-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  piWebFixture(root);
  applyIntegration({ repoRoot, piWebRoot: root });
  const manifestFile = path.join(root, ".pui-update-integration.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.piWebVersion = "9.9.9";
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  assert.deepEqual(removeIntegration(root), { action: "preserved", reason: "modified" });
});

function response(body, ok = true) {
  return { ok, json: async () => body };
}

function appHarness(fetchImpl) {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.style = {}; this.removed = false; this._text = ""; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); }
    append(...children) { for (const child of children) { if (child instanceof Element) child.parent = this; this.children.push(child); } }
    appendChild(child) { if (child instanceof Element) child.parent = this; this.children.push(child); return child; }
    replaceChildren(...children) { this._text = ""; this.children = []; this.append(...children); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    setAttribute() {}
    remove() { this.removed = true; }
    async click() { return this.listeners.click?.(); }
  }
  const body = new Element("body");
  let reloads = 0;
  const context = {
    document: { readyState: "complete", body, createElement: (tag) => new Element(tag) },
    fetch: fetchImpl,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { reload: () => { reloads += 1; } },
    confirm: () => true,
    setTimeout: (callback) => { setImmediate(callback); return 1; },
    console,
  };
  vm.runInNewContext(fs.readFileSync(path.join(repoRoot, "assets", "pui-update-client.js"), "utf8"), context);
  const findButton = (label) => {
    const visit = (node) => {
      if (node instanceof Element && node.tag === "button" && node.textContent === label) return node;
      if (node instanceof Element) for (const child of node.children) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(body);
  };
  const findClose = () => {
    const visit = (node) => {
      if (node instanceof Element && node.tag === "button" && /\bpui-update-close\b/.test(node.className || "")) return node;
      if (node instanceof Element) for (const child of node.children) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(body);
  };
  const findRestart = () => {
    const visit = (node) => {
      if (node instanceof Element && node.tag === "button" && /\bpui-restart-button\b/.test(node.className || "")) return node;
      if (node instanceof Element) for (const child of node.children) { const found = visit(child); if (found) return found; }
      return null;
    };
    return visit(body);
  };
  return { body, findButton, findClose, findRestart, reloads: () => reloads };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("startup consumes a completed service restart and immediately checks for PUI updates", async () => {
  const calls = [];
  let getCount = 0;
  const harness = appHarness(async (_url, options = {}) => {
    const method = options.method || "GET";
    calls.push(method);
    if (method === "DELETE") return response({ acknowledged: true });
    getCount += 1;
    if (getCount === 1) return response({ currentVersion: "1.0.0", phase: "complete", result: "restarted" });
    return response({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
  });
  await settle();
  assert.ok(calls.includes("DELETE"), "completed restart was acknowledged");
  assert.ok(harness.findButton("Install"), "update discovery ran after restart cleanup");
  assert.match(harness.body.textContent, /PUI v1\.1\.0 is available/);
});

test("app update flow survives backend restart and offers reload after success", async () => {
  const calls = [];
  let getCount = 0;
  const harness = appHarness(async (_url, options = {}) => {
    const method = options.method || "GET";
    calls.push(method);
    if (method === "POST") return response({ accepted: true });
    if (method === "DELETE") return response({ acknowledged: true });
    getCount += 1;
    if (getCount === 1) return response({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    if (getCount === 2) throw new Error("backend restarting");
    return response({ target: "1.1.0", result: "success", phase: "complete" });
  });
  await settle();
  await harness.findButton("Install").click();
  await settle();
  assert.match(harness.body.textContent, /PUI v1\.1\.0 installed/);
  const reload = harness.findButton("Reload PUI");
  assert.equal(reload.parent.className, "pui-update-actions");
  await reload.click();
  assert.equal(harness.reloads(), 1);
  assert.ok(calls.includes("DELETE"));
});

test("app update flow reports a validated rollback", async () => {
  let getCount = 0;
  const harness = appHarness(async (_url, options = {}) => {
    if (options.method === "POST") return response({ accepted: true });
    getCount += 1;
    if (getCount === 1) return response({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    return response({ target: "1.1.0", restored: "1.0.0", result: "rolled-back", phase: "complete" });
  });
  await settle();
  await harness.findButton("Install").click();
  await settle();
  assert.match(harness.body.textContent, /PUI v1\.0\.0 was restored/);
  assert.ok(harness.findButton("Reload PUI"));
});

test("a terminal update notification keeps a close button so a stuck card can be dismissed", async () => {
  const harness = appHarness(async (_url, options = {}) => {
    if (options.method === "DELETE") return response({ acknowledged: true });
    return response({ currentVersion: "1.0.5", result: "aborted", phase: "failed" });
  });
  await settle();
  assert.match(harness.body.textContent, /Update was not applied.*PUI v1\.0\.5 remains installed/);
  assert.ok(harness.findClose(), "aborted card has a close button");
});

test("a closed update card re-appears when the update reaches a terminal status", async () => {
  let getCount = 0;
  let releaseSuccess = false;
  const harness = appHarness(async (_url, options = {}) => {
    if (options.method === "POST") return response({ accepted: true });
    if (options.method === "DELETE") return response({ acknowledged: true });
    getCount += 1;
    if (getCount === 1) return response({ currentVersion: "1.0.0", latestVersion: "1.1.0", updateAvailable: true });
    if (releaseSuccess) return response({ target: "1.1.0", result: "success", phase: "complete" });
    return response({ target: "1.1.0", phase: "installing", result: null });
  });
  await settle();
  // Fire Install without awaiting: poll() loops on "installing" until we flip the status,
  // so awaiting click() (which awaits install() -> poll()) would deadlock.
  harness.findButton("Install").click();
  await settle();
  const close = harness.findClose();
  assert.ok(close, "progress card has a close button");
  await close.click();
  releaseSuccess = true;
  await settle();
  assert.match(harness.body.textContent, /PUI v1\.1\.0 installed/);
  assert.ok(harness.findButton("Reload PUI"), "reload action re-appeared after the status changed to terminal");
});

test("bridge restart delegates to the updater and returns acceptance", async (t) => {
  const { bridgePath } = bridgeStatusFixture(t);
  const result = await require(bridgePath).restart();
  assert.equal(result.accepted, true);
});

test("patched app-update route exposes a PUT restart action", () => {
  const original = 'x={62445:(a,b,c)=>{"use strict";c.r(b),c.d(b,{GET:()=>l,dynamic:()=>g});let g="force-dynamic",h="0.8.11";let u="registry.npmjs.org/@agegr%2Fpi-web/latest"},63033:a=>{}}';
  const patched = patchRoute(original, "0.8.11");
  assert.match(patched, /PUT:\(\)=>k/);
  assert.match(patched, /f\.restart\(\)/);
});

test("the restart button reuses PUI styling, sits below the update card, and reloads after Pi Web comes back", async () => {
  const calls = [];
  let stage = "up-old";
  const harness = appHarness(async (_url, options = {}) => {
    const method = options.method || "GET";
    calls.push(method);
    if (method === "PUT") { stage = "up-old-brief"; return response({ accepted: true }); }
    if (stage === "up-old-brief") { stage = "down"; return response({ currentVersion: "1.1.0", updateAvailable: false }); }
    if (stage === "down") { stage = "up-new"; throw new Error("connection refused"); }
    return response({ currentVersion: "1.1.0", updateAvailable: false });
  });
  await settle();
  const restart = harness.findRestart();
  assert.ok(restart, "restart button is always present");
  assert.match(restart.className, /pui-restart-button/);
  await restart.click();
  await settle();
  assert.ok(calls.includes("PUT"), "PUT restart request sent");
  assert.equal(harness.reloads(), 1, "page reloaded after Pi Web came back");
});

test("restart flow shows progress on the card and reloads on completion", async () => {
  let clicked = false;
  let restartingReads = 0;
  const harness = appHarness(async (_url, options = {}) => {
    const method = options.method || "GET";
    if (method === "PUT") { clicked = true; return response({ accepted: true }); }
    if (!clicked) return response({ currentVersion: "1.1.0", updateAvailable: false });
    if (restartingReads < 2) { restartingReads += 1; return response({ phase: "restarting", result: null }); }
    return response({ phase: "complete", result: "restarted" });
  });
  await settle();
  const restart = harness.findRestart();
  await restart.click();
  await settle();
  assert.match(harness.body.textContent, /Restarting Pi Web…/, "progress is visible while the restart runs");
  assert.equal(harness.reloads(), 1, "reload after success restores a fresh, active button");
});

test("restart flow reports failure and reactivates the button", async () => {
  let clicked = false;
  let phase = "restarting";
  const harness = appHarness(async (_url, options = {}) => {
    const method = options.method || "GET";
    if (method === "PUT") { clicked = true; return response({ accepted: true }); }
    if (!clicked) return response({ currentVersion: "1.1.0", updateAvailable: false });
    let status;
    if (phase === "restarting") { phase = "failed"; status = { phase: "restarting", result: null }; }
    else status = { phase: "failed", result: "failed", error: "Pi Web did not become healthy after restart" };
    return response(status);
  });
  await settle();
  const restart = harness.findRestart();
  await restart.click();
  await settle();
  assert.match(harness.body.textContent, /restart did not complete.*did not become healthy/i);
  assert.equal(restart.disabled, false, "button reactivated after a failed restart");
  assert.ok(harness.findClose(), "restart failure card can be dismissed");
});

test("a rejected restart request keeps the button usable and explains the conflict", async () => {
  const harness = appHarness(async (_url, options = {}) => {
    if ((options.method || "GET") === "PUT") return response({ error: "An update or restart is already in progress" }, false);
    return response({ currentVersion: "1.1.0", updateAvailable: false });
  });
  await settle();
  const restart = harness.findRestart();
  await restart.click();
  await settle();
  assert.match(harness.body.textContent, /already in progress/);
  assert.equal(restart.disabled, false, "button reactivated after a rejected restart");
  assert.equal(harness.reloads(), 0);
});
