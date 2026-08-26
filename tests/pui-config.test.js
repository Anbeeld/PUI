const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");

const LIB = path.join(__dirname, "..", "lib", "pui-config.js");
const {
  deepMerge,
  mergeArrayUnique,
  packageToken,
  setMcpServer,
  readJsonSafe,
  backupFile,
} = require(LIB);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pui-test-"));
}
function w(d, f, c) { fs.writeFileSync(path.join(d, f), c); }
function rj(d, f) { return JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); }

// ---------- deepMerge ----------
test("deepMerge preserves unrelated existing object keys", () => {
  const base = { a: 1, unrelated: { x: 2 } };
  const pui = { a: 1, b: 2 };
  const out = deepMerge(base, pui, new Set(["a", "b"]));
  assert.deepEqual(out, { a: 1, b: 2, unrelated: { x: 2 } });
});

test("deepMerge deep-merges nested objects", () => {
  const base = { searchRouting: { providers: ["openai"], extra: true } };
  const pui = { searchRouting: { providers: ["exa", "duckduckgo"], useCurrentModel: false } };
  const out = deepMerge(base, pui, new Set(["searchRouting"]));
  // providers arrays merge (not owned at leaf) -> preserves openai + adds
  assert.deepEqual(out.searchRouting.providers, ["openai", "exa", "duckduckgo"]);
  assert.equal(out.searchRouting.useCurrentModel, false);
  assert.equal(out.searchRouting.extra, true);
});

test("deepMerge owned scalar replaces; arrays always dedup", () => {
  const base = { fetchRouting: { providers: ["http", "jina"], allow: true } };
  const pui = { fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false } };
  const out = deepMerge(base, pui, new Set(["fetchRouting"]));
  // arrays dedup (preserve jina + ensure http present)
  assert.deepEqual(out.fetchRouting.providers, ["http", "jina"]);
  // scalar replaced when owned
  assert.equal(out.fetchRouting.allowRemoteHostedProviders, false);
});

test("deepMerge replaces conflicting scalars inside a PUI-owned object", () => {
  const base = {
    searchRouting: { useCurrentModel: true, custom: "keep" },
    fetchRouting: { allowRemoteHostedProviders: true },
  };
  const pui = {
    searchRouting: { useCurrentModel: false },
    fetchRouting: { allowRemoteHostedProviders: false },
  };
  const out = deepMerge(base, pui, new Set(["searchRouting", "fetchRouting"]));
  assert.equal(out.searchRouting.useCurrentModel, false);
  assert.equal(out.fetchRouting.allowRemoteHostedProviders, false);
  assert.equal(out.searchRouting.custom, "keep");
});

test("deepMerge defaultTools dedups and preserves", () => {
  const base = { defaultTools: ["read", "bash", "powershell"] };
  const pui = { defaultTools: ["read", "bash", "edit", "write", "grep", "find", "ls"] };
  const out = deepMerge(base, pui, new Set(["defaultTools"]));
  assert.deepEqual(out.defaultTools, ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
});

// ---------- mergeArrayUnique ----------
test("mergeArrayUnique no duplicates idempotent", () => {
  const req = ["read", "bash", "edit"];
  const a = mergeArrayUnique(["read", "powershell"], req);
  const b = mergeArrayUnique(a, req);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["read", "powershell", "bash", "edit"]);
});

// ---------- setMcpServer ----------
test("setMcpServer adds when absent", () => {
  const cfg = {};
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"], lifecycle: "lazy" };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "added");
  assert.deepEqual(cfg.mcpServers.playwright, def);
});

test("setMcpServer updates when same shape, preserves extra fields", () => {
  const cfg = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"], env: { FOO: "bar" } } } };
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"], lifecycle: "lazy" };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "updated");
  assert.deepEqual(cfg.mcpServers.playwright.env, { FOO: "bar" });
  assert.deepEqual(cfg.mcpServers.playwright.args, def.args);
  assert.equal(cfg.mcpServers.playwright.lifecycle, "lazy");
});

test("setMcpServer reports conflict when materially different", () => {
  const cfg = { mcpServers: { playwright: { command: "python", args: ["-m", "myserver"] } } };
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest"] };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "conflict");
  assert.deepEqual(cfg.mcpServers.playwright, { command: "python", args: ["-m", "myserver"] });
});

// ---------- readJsonSafe ----------
test("readJsonSafe returns {} for missing file", () => {
  const r = readJsonSafe(path.join(tmpdir(), "nope.json"));
  assert.equal(r.ok, true);
  assert.equal(r.existed, false);
  assert.deepEqual(r.value, {});
});

test("readJsonSafe rejects invalid JSON without throwing", () => {
  const d = tmpdir(); w(d, "bad.json", "{not valid");
  const r = readJsonSafe(path.join(d, "bad.json"));
  assert.equal(r.ok, false);
  assert.equal(r.existed, true);
  assert.ok(r.error);
});

test("readJsonSafe rejects non-object top level", () => {
  const d = tmpdir(); w(d, "arr.json", "[1,2,3]");
  const r = readJsonSafe(path.join(d, "arr.json"));
  assert.equal(r.ok, false);
});

// ---------- backupFile ----------
test("backupFile copies existing and returns path", () => {
  const d = tmpdir(); w(d, "x.json", '{"a":1}');
  const r = backupFile(path.join(d, "x.json"));
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(rj(d, path.basename(r.backup)).a, 1);
});

test("backupFile returns null backup for missing", () => {
  const r = backupFile(path.join(tmpdir(), "nope.json"));
  assert.equal(r.backup, null);
});

// ---------- packageToken ----------
test("packageToken extracts package, skipping flags and flag values", () => {
  assert.equal(packageToken(["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"]), "@playwright/mcp");
  assert.equal(packageToken(["-y", "@playwright/mcp"]), "@playwright/mcp");
  assert.equal(packageToken(["--headless"]), null);
  assert.equal(packageToken(null), null);
});

test("setMcpServer conflict when same command but different package (regression)", () => {
  // Regression: packageToken used to return "-y" for both sides, making any
  // two npx servers look compatible. A different package must conflict.
  const cfg = { mcpServers: { playwright: { command: "npx", args: ["-y", "@someother/pkg", "--headless"] } } };
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest"], lifecycle: "lazy" };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "conflict");
});

test("setMcpServer compatible same package different flags updates", () => {
  const cfg = { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] } } };
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"], lifecycle: "lazy" };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "updated");
});

test("setMcpServer replaces a compatible rolling package token with the exact managed args", () => {
  const cfg = {
    mcpServers: {
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--headless"],
        env: { USER_SETTING: "preserved" },
      },
    },
  };
  const def = {
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.79", "--headless", "--browser", "chrome"],
    lifecycle: "lazy",
  };
  const res = setMcpServer(cfg, "playwright", def, ["command", "args"]);
  assert.equal(res.action, "updated");
  assert.deepEqual(cfg.mcpServers.playwright.args, def.args);
  assert.deepEqual(cfg.mcpServers.playwright.env, { USER_SETTING: "preserved" });
});

test("CLI set-server replaces managed direct tools and preserves unrelated MCP fields", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  w(d, "mcp.json", JSON.stringify({
    settings: { disableProxyTool: false },
    mcpServers: {
      other: { command: "other" },
      playwright: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.79", "--headless", "--browser", "chrome"],
        lifecycle: "lazy",
        directTools: ["browser_navigate", "browser_evaluate"],
        env: { USER_SETTING: "preserved" },
      },
    },
  }));
  const directTools = [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_wait_for",
    "browser_take_screenshot",
  ];
  const def = {
    command: "npx",
    args: ["-y", "@playwright/mcp@0.0.79", "--headless", "--browser", "chrome"],
    lifecycle: "lazy",
    directTools,
  };

  const res = runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  assert.equal(res.exit, 0);
  const out = rj(d, "mcp.json");
  assert.deepEqual(out.mcpServers.playwright.directTools, directTools);
  assert.deepEqual(out.mcpServers.playwright.env, { USER_SETTING: "preserved" });
  assert.deepEqual(out.mcpServers.other, { command: "other" });
  assert.equal(out.settings.disableProxyTool, false);
});

// ---------- CLI end-to-end fixtures ----------
function runCli(args, expectExit) {
  try {
    const out = execFileSync(process.execPath, [LIB, ...args], { encoding: "utf8" });
    return { exit: 0, out };
  } catch (e) {
    return { exit: e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}

test("CLI merge-object fresh fixture", () => {
  const d = tmpdir();
  const f = path.join(d, "settings.json");
  const res = runCli(["merge-object", f, JSON.stringify({ searchRouting: { providers: ["exa"] } })]);
  assert.equal(res.exit, 0);
  assert.equal(rj(d, "settings.json").searchRouting.providers[0], "exa");
});

test("CLI merge-object existing-complex preserves unrelated", () => {
  const d = tmpdir(); const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({ defaultTools: ["read", "powershell"], extra: true, searchRouting: { providers: ["openai"], custom: "keep" } }));
  const pui = { searchRouting: { providers: ["exa", "duckduckgo"], useCurrentModel: false, fallbackOn: ["quota"] }, fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false }, workflow: "none" };
  runCli(["merge-object", f, JSON.stringify(pui)]);
  const out = rj(d, "settings.json");
  assert.equal(out.extra, true);
  assert.equal(out.defaultTools[1], "powershell");
  assert.deepEqual(out.searchRouting.providers, ["openai", "exa", "duckduckgo"]);
  assert.equal(out.searchRouting.custom, "keep");
  assert.equal(out.workflow, "none");
  assert.equal(out.fetchRouting.allowRemoteHostedProviders, false);
});

test("CLI default-tools-merge existing-pinned preserves", () => {
  const d = tmpdir(); const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({ defaultTools: ["read", "bash", "powershell"] }));
  runCli(["default-tools-merge", f, JSON.stringify(["read", "bash", "edit", "write", "grep", "find", "ls"])]);
  const out = rj(d, "settings.json");
  assert.deepEqual(out.defaultTools, ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
});

test("CLI default-tools-merge idempotent on second run", () => {
  const d = tmpdir(); const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({ defaultTools: ["read", "powershell"] }));
  const req = JSON.stringify(["read", "bash", "edit", "write", "grep", "find", "ls"]);
  runCli(["default-tools-merge", f, req]);
  runCli(["default-tools-merge", f, req]);
  const out = rj(d, "settings.json");
  assert.deepEqual(out.defaultTools, ["read", "powershell", "bash", "edit", "write", "grep", "find", "ls"]);
});

test("CLI set-server fresh", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"], lifecycle: "lazy" };
  const res = runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  assert.equal(res.exit, 0);
  assert.deepEqual(rj(d, "mcp.json").mcpServers.playwright, def);
});

test("CLI set-server existing-compatible updates preserving other servers", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  w(d, "mcp.json", JSON.stringify({ mcpServers: { other: { command: "x" }, playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"], env: { K: "v" } } } }));
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--browser", "chrome"], lifecycle: "lazy" };
  const res = runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  assert.equal(res.exit, 0);
  const out = rj(d, "mcp.json");
  assert.deepEqual(out.mcpServers.other, { command: "x" });
  assert.equal(out.mcpServers.playwright.env.K, "v");
  assert.equal(out.mcpServers.playwright.lifecycle, "lazy");
});

test("CLI set-server existing-conflicting exits 2, does not overwrite", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  w(d, "mcp.json", JSON.stringify({ mcpServers: { playwright: { command: "python", args: ["-m", "srv"] } } }));
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest"], lifecycle: "lazy" };
  const res = runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  assert.equal(res.exit, 2);
  assert.deepEqual(rj(d, "mcp.json").mcpServers.playwright, { command: "python", args: ["-m", "srv"] });
});

test("CLI set-server idempotent", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  const def = { command: "npx", args: ["-y", "@playwright/mcp@latest"], lifecycle: "lazy" };
  runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  runCli(["set-server", f, "playwright", JSON.stringify(def)]);
  assert.deepEqual(rj(d, "mcp.json").mcpServers.playwright, def);
});

test("CLI validate invalid file exits 1", () => {
  const d = tmpdir(); const f = path.join(d, "bad.json");
  w(d, "bad.json", "{broken");
  const res = runCli(["validate", f]);
  assert.equal(res.exit, 1);
  assert.match(res.out, /INVALID/);
});

test("CLI validate missing exits 0", () => {
  const d = tmpdir(); const f = path.join(d, "nope.json");
  const res = runCli(["validate", f]);
  assert.equal(res.exit, 0);
});

test("CLI remove-server", () => {
  const d = tmpdir(); const f = path.join(d, "mcp.json");
  w(d, "mcp.json", JSON.stringify({ mcpServers: { playwright: { command: "npx" }, keep: { command: "y" } } }));
  runCli(["remove-server", f, "playwright"]);
  const out = rj(d, "mcp.json");
  assert.equal(out.mcpServers.playwright, undefined);
  assert.deepEqual(out.mcpServers.keep, { command: "y" });
});

test("CLI backup creates timestamped copy", () => {
  const d = tmpdir(); const f = path.join(d, "x.json");
  w(d, "x.json", '{"a":1}');
  const res = runCli(["backup", f]);
  assert.ok(res.out.includes(".pui-backup-"));
});

test("fresh fixture: full PUI web-access merge", () => {
  const d = tmpdir(); const f = path.join(d, "web-search.json");
  const pui = {
    searchRouting: { providers: ["exa", "duckduckgo"], useCurrentModel: false, fallbackOn: ["quota", "transient", "network", "invalid-response", "unsupported"] },
    fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
    workflow: "none",
  };
  runCli(["merge-object", f, JSON.stringify(pui)]);
  const out = rj(d, "web-search.json");
  assert.deepEqual(out.searchRouting.providers, ["exa", "duckduckgo"]);
  assert.equal(out.workflow, "none");
  assert.equal(out.fetchRouting.allowRemoteHostedProviders, false);
});

test("existing-complex web-access: preserves api keys + unrelated settings", () => {
  const d = tmpdir(); const f = path.join(d, "web-search.json");
  w(d, "web-search.json", JSON.stringify({ openaiApiKey: "sk-xxx", customThing: true, searchRouting: { providers: ["brave"] } }));
  const pui = {
    searchRouting: { providers: ["exa", "duckduckgo"], useCurrentModel: false, fallbackOn: ["quota"] },
    fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
    workflow: "none",
  };
  runCli(["merge-object", f, JSON.stringify(pui)]);
  const out = rj(d, "web-search.json");
  assert.equal(out.openaiApiKey, "sk-xxx");
  assert.equal(out.customThing, true);
  // NOTE: existing providers preserved + pui appended (not replaced) per merge semantics
  assert.deepEqual(out.searchRouting.providers, ["brave", "exa", "duckduckgo"]);
  assert.equal(out.workflow, "none");
});

test("pwa-disabled path: no autostart fields written by config", () => {
  // Autostart is OS-level, not in JSON. Verify nothing pwa-related lands in config.
  const d = tmpdir(); const f = path.join(d, "settings.json");
  runCli(["merge-object", f, JSON.stringify({ defaultTools: ["read", "bash"] })]);
  const out = rj(d, "settings.json");
  assert.equal(out.autostart, undefined);
  assert.equal(out.pwa, undefined);
});

test("CLI prioritize moves PUI providers first, preserves user providers", () => {
  const d = tmpdir(); const f = path.join(d, "web-search.json");
  w(d, "web-search.json", JSON.stringify({ searchRouting: { providers: ["brave", "openai", "duckduckgo", "exa"] } }));
  const res = runCli(["prioritize", f, "searchRouting.providers", JSON.stringify(["exa", "duckduckgo"])]);
  assert.equal(res.exit, 0);
  assert.deepEqual(rj(d, "web-search.json").searchRouting.providers, ["exa", "duckduckgo", "brave", "openai"]);
});

test("CLI prioritize is idempotent", () => {
  const d = tmpdir(); const f = path.join(d, "web-search.json");
  w(d, "web-search.json", JSON.stringify({ searchRouting: { providers: ["brave", "exa"] } }));
  const arg = JSON.stringify(["exa", "duckduckgo"]);
  runCli(["prioritize", f, "searchRouting.providers", arg]);
  runCli(["prioritize", f, "searchRouting.providers", arg]);
  assert.deepEqual(rj(d, "web-search.json").searchRouting.providers, ["exa", "brave"]);
});

test("CLI unpin-package normalizes pinned entries only", () => {
  const d = tmpdir(); const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({
    packages: ["npm:pi-web-access@1.2.3", "npm:@gotgenes/pi-subagents@9.9.9", "npm:some-other-pkg@2.0.0"],
    unrelated: true,
  }));
  runCli(["unpin-package", f, "pi-web-access"]);
  runCli(["unpin-package", f, "@gotgenes/pi-subagents"]);
  const out = rj(d, "settings.json");
  assert.deepEqual(out.packages, ["npm:pi-web-access", "npm:@gotgenes/pi-subagents", "npm:some-other-pkg@2.0.0"]);
  assert.equal(out.unrelated, true);
});

test("CLI set-package replaces conflicting managed pins and preserves unrelated packages", () => {
  const d = tmpdir();
  const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({
    packages: ["npm:pi-web-access@0.20.0", "npm:unrelated@2.0.0", "npm:pi-web-access@0.21.0"],
  }));
  runCli(["set-package", f, "npm:pi-web-access@0.25.0"]);
  assert.deepEqual(rj(d, "settings.json").packages, ["npm:pi-web-access@0.25.0", "npm:unrelated@2.0.0"]);
});

test("path-with-spaces fixture: CLI merge works on dirs with spaces", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pui-test-"));
  const d = path.join(base, "dir with spaces");
  fs.mkdirSync(d);
  const f = path.join(d, "settings.json");
  w(d, "settings.json", JSON.stringify({ defaultTools: ["read"] }));
  const res = runCli(["default-tools-merge", f, JSON.stringify(["read", "bash"])]);
  assert.equal(res.exit, 0, res.out);
  assert.deepEqual(rj(d, "settings.json").defaultTools, ["read", "bash"]);
});
