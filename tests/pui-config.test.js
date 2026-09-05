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
  removeArrayItemsAtPath,
  setOwnedFieldsAtPath,
  removeOwnedFieldsAtPath,
  ownedFieldsMatchAtPath,
  configCandidatePaths,
  resolveConfigPath,
  readJsonSafe,
  backupFile,
  writeJson,
  reconcileModelMappings,
  validateModelMappingsConfig,
  validateReasoningSummaryModesConfig,
  validateSessionTitlesConfig,
} = require(LIB);

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pui-test-"));
}
function w(d, f, c) { fs.writeFileSync(path.join(d, f), c); }
function rj(d, f) { return JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); }

// ---------- subagent model mappings ----------
test("reconcileModelMappings appends new defaults without resurrecting deleted mappings", () => {
  const existing = {
    schemaVersion: 1,
    modelMappings: { custom: "custom-child" },
    _pui: { defaultMappings: { sol: "luna" } },
    unrelated: true,
  };
  const out = reconcileModelMappings(existing, { sol: "luna", opus: "sonnet" });
  assert.deepEqual(out, {
    schemaVersion: 1,
    modelMappings: { custom: "custom-child", opus: "sonnet" },
    _pui: { defaultMappings: { sol: "luna", opus: "sonnet" } },
    unrelated: true,
  });
});

test("reconcileModelMappings updates untouched defaults and preserves user overrides", () => {
  const defaults = { sol: "new-luna", opus: "new-sonnet" };
  const out = reconcileModelMappings({
    schemaVersion: 1,
    modelMappings: { sol: "old-luna", opus: "custom-sonnet" },
    _pui: { defaultMappings: { sol: "old-luna", opus: "old-sonnet" } },
  }, defaults);
  assert.deepEqual(out.modelMappings, { sol: "new-luna", opus: "custom-sonnet" });
  assert.deepEqual(out._pui.defaultMappings, defaults);
});

test("reconcileModelMappings removes retired untouched defaults and keeps changed ones", () => {
  const out = reconcileModelMappings({
    schemaVersion: 1,
    modelMappings: { retired: "child", customized: "user-child" },
    _pui: { defaultMappings: { retired: "child", customized: "old-child" } },
  }, {});
  assert.deepEqual(out.modelMappings, { customized: "user-child" });
  assert.deepEqual(out._pui.defaultMappings, {});
});

test("reconcileModelMappings preserves user key casing without creating a duplicate mapping", () => {
  const canonical = "openai-codex/gpt-5.6-sol";
  const userKey = "OpenAI-Codex/GPT-5.6-Sol";
  const out = reconcileModelMappings({
    schemaVersion: 1,
    modelMappings: { [userKey]: "openai-codex/gpt-5.6-luna" },
    _pui: { defaultMappings: { [canonical]: "openai-codex/gpt-5.6-luna" } },
  }, { [canonical]: "openai-codex/gpt-5.6-terra" });
  assert.deepEqual(out.modelMappings, { [userKey]: "openai-codex/gpt-5.6-terra" });
  assert.deepEqual(out._pui.defaultMappings, { [canonical]: "openai-codex/gpt-5.6-terra" });
});

test("validateModelMappingsConfig accepts fuzzy strings and rejects malformed mappings", () => {
  assert.equal(validateModelMappingsConfig({ schemaVersion: 1, modelMappings: { sol: "luna" }, _pui: { defaultMappings: { sol: "luna" } } }).ok, true);
  assert.equal(validateModelMappingsConfig({ schemaVersion: 2, modelMappings: {} }).ok, false);
  assert.equal(validateModelMappingsConfig({ schemaVersion: 1, modelMappings: { sol: 42 } }).ok, false);
  assert.equal(validateModelMappingsConfig({ schemaVersion: 1, modelMappings: { Sol: "luna", sol: "terra" } }).ok, false);
  assert.equal(validateModelMappingsConfig({ schemaVersion: 1, modelMappings: { " sol ": "luna" } }).ok, false);
});

test("writeJson atomically preserves the previous file when rename fails", (t) => {
  const dir = tmpdir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, '{"before":true}\n');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error("injected rename failure"); };
  try {
    assert.throws(() => writeJson(file, { after: true }), /injected rename failure/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(file, "utf8"), '{"before":true}\n');
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

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

test("removeArrayItemsAtPath removes retired features and preserves other settings", () => {
  const config = {
    enabledFeatures: ["autocomplete", "agentTools", "customFeature"],
    unrelated: { keep: true },
  };
  const removed = removeArrayItemsAtPath(config, "enabledFeatures", ["agentTools"]);
  assert.equal(removed, 1);
  assert.deepEqual(config.enabledFeatures, ["autocomplete", "customFeature"]);
  assert.deepEqual(config.unrelated, { keep: true });
});

test("setOwnedFieldsAtPath replaces managed arrays and preserves unrelated settings", () => {
  const config = {
    guidance: { promptGuidelines: ["user value"], futureField: true },
    collapseKey: "alt+o",
  };
  setOwnedFieldsAtPath(config, "guidance", {
    description: "managed",
    promptGuidelines: ["compact guidance"],
  });
  assert.deepEqual(config, {
    guidance: {
      description: "managed",
      promptGuidelines: ["compact guidance"],
      futureField: true,
    },
    collapseKey: "alt+o",
  });
});

test("owned guidance removal is exact and preserves unrelated settings", () => {
  const managed = { description: "managed", promptGuidelines: ["compact guidance"] };
  const config = {
    guidance: { ...managed, futureField: true },
    collapseKey: "alt+o",
  };
  assert.equal(ownedFieldsMatchAtPath(config, "guidance", managed), true);
  assert.equal(removeOwnedFieldsAtPath(config, "guidance", managed), true);
  assert.deepEqual(config, { guidance: { futureField: true }, collapseKey: "alt+o" });

  const changed = { guidance: { ...managed, description: "user changed" }, collapseKey: "alt+o" };
  assert.equal(ownedFieldsMatchAtPath(changed, "guidance", managed), false);
  assert.equal(removeOwnedFieldsAtPath(changed, "guidance", managed), false);
  assert.equal(changed.guidance.description, "user changed");
});

test("configCandidatePaths includes XDG and legacy paths for ownership cleanup", () => {
  assert.deepEqual(
    configCandidatePaths("~/.config/rpiv-ask-user-question/config.json", "rpiv-ask-user-question/config.json", {
      env: { XDG_CONFIG_HOME: "/tmp/custom-config" },
      home: "/home/example",
    }),
    [
      path.resolve("/tmp/custom-config/rpiv-ask-user-question/config.json"),
      path.resolve("/home/example/.config/rpiv-ask-user-question/config.json"),
    ],
  );
  assert.deepEqual(
    configCandidatePaths("~/.config/rpiv-ask-user-question/config.json", "rpiv-ask-user-question/config.json", {
      env: { XDG_CONFIG_HOME: "relative/config" },
      home: "/home/example",
    }),
    [path.resolve("/home/example/.config/rpiv-ask-user-question/config.json")],
  );
});

test("resolveConfigPath uses an existing absolute XDG file and otherwise falls back", () => {
  assert.equal(
    resolveConfigPath("~/.config/rpiv-ask-user-question/config.json", "rpiv-ask-user-question/config.json", {
      env: { XDG_CONFIG_HOME: "/tmp/custom-config" },
      home: "/home/example",
      exists: (file) => file === path.resolve("/tmp/custom-config/rpiv-ask-user-question/config.json"),
    }),
    path.resolve("/tmp/custom-config/rpiv-ask-user-question/config.json"),
  );
  for (const xdg of ["/tmp/missing", "relative/config"]) {
    assert.equal(
      resolveConfigPath("~/.config/rpiv-ask-user-question/config.json", "rpiv-ask-user-question/config.json", {
        env: { XDG_CONFIG_HOME: xdg },
        home: "/home/example",
        exists: () => false,
      }),
      path.resolve("/home/example/.config/rpiv-ask-user-question/config.json"),
    );
  }
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

test("CLI rejects an existing empty mapping config instead of treating it as missing", () => {
  const d = tmpdir();
  const f = path.join(d, "subagents.json");
  fs.writeFileSync(f, "{}\n");
  const result = runCli(["reconcile-model-mappings", f, JSON.stringify({ sol: "luna" })]);
  assert.notEqual(result.exit, 0);
  assert.match(result.out, /schemaVersion must be 1/);
  assert.deepEqual(rj(d, "subagents.json"), {});
});

test("CLI reconciles new mapping defaults without reviving a removed default", () => {
  const d = tmpdir();
  const f = path.join(d, "subagents.json");
  assert.equal(runCli(["reconcile-model-mappings", f, JSON.stringify({ sol: "luna" })]).exit, 0);
  const initial = rj(d, "subagents.json");
  assert.deepEqual(initial.modelMappings, { sol: "luna" });
  delete initial.modelMappings.sol;
  fs.writeFileSync(f, JSON.stringify(initial));
  assert.equal(runCli(["reconcile-model-mappings", f, JSON.stringify({ sol: "luna", opus: "sonnet" })]).exit, 0);
  assert.deepEqual(rj(d, "subagents.json").modelMappings, { opus: "sonnet" });
  assert.equal(runCli(["validate-model-mappings", f]).exit, 0);
});

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

test("CLI remove-array-items removes retired FFF features", () => {
  const d = tmpdir(); const f = path.join(d, "pi-fff.json");
  w(d, "pi-fff.json", JSON.stringify({
    enabledFeatures: ["autocomplete", "agentTools", "customFeature"],
    unrelated: "preserved",
  }));
  const res = runCli(["remove-array-items", f, "enabledFeatures", JSON.stringify(["agentTools"])]);
  assert.equal(res.exit, 0, res.out);
  const out = rj(d, "pi-fff.json");
  assert.deepEqual(out.enabledFeatures, ["autocomplete", "customFeature"]);
  assert.equal(out.unrelated, "preserved");
});

test("CLI set-owned-fields converges guidance without merging prompt arrays", () => {
  const d = tmpdir(); const f = path.join(d, "ask-user.json");
  w(d, "ask-user.json", JSON.stringify({
    guidance: { promptGuidelines: ["user value"], futureField: true },
    collapseKey: "alt+o",
  }));
  const managed = { description: "managed", promptGuidelines: ["compact guidance"] };
  const res = runCli(["set-owned-fields", f, "guidance", JSON.stringify(managed)]);
  assert.equal(res.exit, 0, res.out);
  assert.deepEqual(rj(d, "ask-user.json"), {
    guidance: { promptGuidelines: ["compact guidance"], futureField: true, description: "managed" },
    collapseKey: "alt+o",
  });
});

test("CLI remove-owned-fields refuses drift and removes only exact managed leaves", () => {
  const d = tmpdir(); const f = path.join(d, "ask-user.json");
  const managed = { description: "managed", promptGuidelines: ["compact guidance"] };
  w(d, "ask-user.json", JSON.stringify({ guidance: { ...managed, futureField: true }, collapseKey: "alt+o" }));
  let res = runCli(["remove-owned-fields", f, "guidance", JSON.stringify(managed)]);
  assert.equal(res.exit, 0, res.out);
  const removal = JSON.parse(res.out);
  assert.equal(fs.existsSync(removal.backup), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(removal.backup, "utf8")), {
    guidance: { ...managed, futureField: true }, collapseKey: "alt+o",
  });
  assert.deepEqual(rj(d, "ask-user.json"), { guidance: { futureField: true }, collapseKey: "alt+o" });

  w(d, "ask-user.json", JSON.stringify({ guidance: { ...managed, description: "user changed" }, collapseKey: "alt+o" }));
  res = runCli(["remove-owned-fields", f, "guidance", JSON.stringify(managed)]);
  assert.equal(res.exit, 2, res.out);
  assert.equal(rj(d, "ask-user.json").guidance.description, "user changed");
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

test("CLI remove-array-items on a missing file writes nothing", () => {
  const d = tmpdir();
  const missing = path.join(d, "absent.json");
  const res = runCli(["remove-array-items", missing, "enabledFeatures", JSON.stringify(["agentTools"])]);
  assert.equal(res.exit, 0, res.out);
  assert.equal(fs.existsSync(missing), false);
});

test("CLI remove-array-items skips writing when nothing changes", () => {
  const d = tmpdir();
  const f = path.join(d, "features.json");
  const before = JSON.stringify({ enabledFeatures: ["autocomplete"] });
  fs.writeFileSync(f, before);
  const res = runCli(["remove-array-items", f, "enabledFeatures", JSON.stringify(["agentTools"])]);
  assert.equal(res.exit, 0, res.out);
  assert.equal(fs.readFileSync(f, "utf8"), before);
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

test("session-title config accepts an ordered exact-or-fuzzy model list", () => {
  assert.equal(validateSessionTitlesConfig({ schemaVersion: 1, models: ["openai-codex/gpt-5.6-luna", "haiku"] }).ok, true);
  for (const value of [
    null,
    {},
    { schemaVersion: 2, models: [] },
    { schemaVersion: 1, models: {} },
    { schemaVersion: 1, models: [""] },
    { schemaVersion: 1, models: [" luna"] },
    { schemaVersion: 1, models: ["luna", "LUNA"] },
  ]) assert.equal(validateSessionTitlesConfig(value).ok, false, JSON.stringify(value));
});

test("session-title config is created only when missing", () => {
  const d = tmpdir(); const f = path.join(d, "session-titles.json");
  const first = runCli(["ensure-session-titles", f, JSON.stringify(["luna"])]);
  assert.equal(first.exit, 0, first.out);
  assert.deepEqual(rj(d, "session-titles.json"), { schemaVersion: 1, models: ["luna"] });

  const exact = '{\n  "schemaVersion": 1,\n  "models": ["haiku"],\n  "userField": true\n}\n';
  fs.writeFileSync(f, exact);
  const second = runCli(["ensure-session-titles", f, JSON.stringify([])]);
  assert.equal(second.exit, 0, second.out);
  assert.equal(fs.readFileSync(f, "utf8"), exact);
});

test("invalid existing session-title config fails without overwriting", () => {
  const d = tmpdir(); const f = path.join(d, "session-titles.json");
  const invalid = '{"schemaVersion":1,"models":["luna","LUNA"]}\n';
  fs.writeFileSync(f, invalid);
  const result = runCli(["ensure-session-titles", f, "[]"]);
  assert.notEqual(result.exit, 0);
  assert.equal(fs.readFileSync(f, "utf8"), invalid);
});

test("reasoning-summary config accepts only the versioned mode contract", () => {
  assert.equal(validateReasoningSummaryModesConfig({ schemaVersion: 1, modelModes: {
    "gpt-5.6-sol": "auto", "gpt-5.6-terra": "concise", "gpt-5.6-luna": "detailed", other: "none",
  }}).ok, true);
  for (const value of [
    null,
    {},
    { schemaVersion: 2, modelModes: {} },
    { schemaVersion: 1, modelModes: [] },
    { schemaVersion: 1, modelModes: { model: "verbose" } },
    { schemaVersion: 1, modelModes: { "": "auto" } },
  ]) assert.equal(validateReasoningSummaryModesConfig(value).ok, false, JSON.stringify(value));
});

test("reasoning-summary config is created only when missing", () => {
  const d = tmpdir(); const f = path.join(d, "reasoning-summaries.json");
  const defaults = { "gpt-5.6-sol": "detailed", "gpt-5.6-terra": "detailed", "gpt-5.6-luna": "detailed" };
  const first = runCli(["ensure-reasoning-summary-modes", f, JSON.stringify(defaults)]);
  assert.equal(first.exit, 0, first.out);
  assert.deepEqual(rj(d, "reasoning-summaries.json"), { schemaVersion: 1, modelModes: defaults });

  const exact = '{\n  "schemaVersion": 1,\n  "modelModes": {\n    "gpt-5.6-sol": "none"\n  },\n  "userField": true\n}\n';
  fs.writeFileSync(f, exact);
  const second = runCli(["ensure-reasoning-summary-modes", f, JSON.stringify(defaults)]);
  assert.equal(second.exit, 0, second.out);
  assert.equal(fs.readFileSync(f, "utf8"), exact);
});

test("invalid existing reasoning-summary config fails without overwriting", () => {
  const d = tmpdir(); const f = path.join(d, "reasoning-summaries.json");
  const invalid = '{"schemaVersion":1,"modelModes":{"gpt-5.6-sol":"verbose"}}\n';
  fs.writeFileSync(f, invalid);
  const result = runCli(["ensure-reasoning-summary-modes", f, '{"gpt-5.6-sol":"detailed"}']);
  assert.notEqual(result.exit, 0);
  assert.equal(fs.readFileSync(f, "utf8"), invalid);
});
