const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { refreshModels } = require("../assets/pui-model-refresh.cjs");

function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", bin: { pi: "cli.cjs" } }));
  fs.writeFileSync(path.join(pkg, "cli.cjs"), source);
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir, "models-store.json"), '{"cached":true}');
  const warnings = [];
  return { root, agentDir, warnings, options: { packageRoot: root, env: { ...process.env, PI_OFFLINE: "0", PI_CODING_AGENT_DIR: agentDir }, warn: (s) => warnings.push(s), timeoutMs: 2000 } };
}

test("startup refresh runs only model update, preserves config and backs up cached JSON", (t) => {
  const f = fixture(t, `const fs=require('node:fs'),path=require('node:path');
    if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['update','--models','--no-approve']))process.exit(7);
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR,'models-store.json'),'{"fresh":true}');`);
  for (const name of ["settings.json", "models.json", "auth.json"]) fs.writeFileSync(path.join(f.agentDir, name), '{"untouched":true}');
  assert.equal(refreshModels(f.options).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.agentDir, "models-store.json"))), { fresh: true });
  const backups = fs.readdirSync(f.agentDir).filter(n => n.startsWith("models-store.json.pui-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(f.agentDir, backups[0]), "utf8"), '{"cached":true}');
  for (const name of ["settings.json", "models.json", "auth.json"]) assert.equal(fs.readFileSync(path.join(f.agentDir, name), "utf8"), '{"untouched":true}');
  assert.deepEqual(f.warnings, []);
});

test("failed and timed-out refresh warns without exposing subprocess output or blocking startup", (t) => {
  for (const source of ["console.error('synthetic-private-value');process.exit(3)", "setInterval(()=>{},1000)"]) {
    const f = fixture(t, source);
    const result = refreshModels({ ...f.options, timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(f.warnings.length, 1);
    assert.match(f.warnings[0], /cached models/i);
    assert.doesNotMatch(f.warnings[0], /synthetic-private-value/);
    assert.equal(fs.readFileSync(path.join(f.agentDir, "models-store.json"), "utf8"), '{"cached":true}');
  }
});

test("offline startup skips refresh and backup", (t) => {
  const f = fixture(t, "process.exit(1)");
  assert.equal(refreshModels({ ...f.options, env: { ...f.options.env, PI_OFFLINE: "1" } }).skipped, true);
  assert.deepEqual(fs.readdirSync(f.agentDir), ["models-store.json"]);
  assert.equal(f.warnings.length, 0);
});

test("missing runtime and invalid catalog are reported safely and left untouched", (t) => {
  const f = fixture(t, "process.exit(0)");
  fs.writeFileSync(path.join(f.agentDir, "models-store.json"), "invalid json");
  assert.equal(refreshModels(f.options).ok, false);
  assert.equal(fs.readFileSync(path.join(f.agentDir, "models-store.json"), "utf8"), "invalid json");
  assert.match(f.warnings[0], /cached models/i);
  const runtime = path.join(f.root, "node_modules", "@earendil-works", "pi-coding-agent");
  fs.renameSync(runtime, `${runtime}-unavailable`);
  const before = fs.readdirSync(f.agentDir);
  assert.equal(refreshModels(f.options).ok, false);
  assert.deepEqual(fs.readdirSync(f.agentDir), before, "missing runtime must not launch a refresh or create a backup");
});
