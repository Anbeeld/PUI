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
  removeIntegration,
  verifyIntegration,
} = require(path.join(repoRoot, "lib", "pui-web-integration.js"));

function piWebFixture(root) {
  fs.mkdirSync(path.join(root, ".next", "server", "app", "api", "app-update"), { recursive: true });
  fs.mkdirSync(path.join(root, ".next", "server", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "public"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.10" }));
  fs.writeFileSync(path.join(root, ".next", "server", "app", "api", "app-update", "route.js"), 'x={62445:(a,b,c)=>{"use strict";c.r(b),c.d(b,{GET:()=>l,dynamic:()=>g});let g="force-dynamic",h="0.8.10";let u="registry.npmjs.org/@agegr%2Fpi-web/latest"},63033:a=>{}}');
  fs.writeFileSync(path.join(root, ".next", "server", "app", "index.html"), "<html><body>PUI</body></html>");
}

test("Pi Web integration fails closed on an unexpected package layout", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-web-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@agegr/pi-web", version: "0.8.10" }));
  assert.throws(() => applyIntegration({ repoRoot, piWebRoot: root }), /expected.*app-update/i);
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

test("bridge integration verification checks the exact pinned Pi Web version", () => {
  const stack = require(path.join(repoRoot, "stack.json"));
  assert.equal(stack.upstream.gui.version, "0.8.10");
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
  fs.writeFileSync(path.join(extensionRoot, "manifest.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(extensionRoot, "updater.js"), `module.exports = { STATUS_FILE: ${JSON.stringify(statusFile)}, LOCK_FILE: ${JSON.stringify(lockFile)}, chooseStableUpdate: () => null };\n`);

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
  return { bridgePath, lockFile, statusFile };
}

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
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
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
  return { body, findButton, reloads: () => reloads };
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

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
