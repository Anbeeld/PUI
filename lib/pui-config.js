#!/usr/bin/env node
// Shared, cross-platform configuration helpers for PUI.
// Used by install/update/uninstall/doctor scripts on both Windows and macOS
// so JSON merge logic has one source of truth and one test suite.
//
// This module is intentionally dependency-free and uses only Node built-ins.
//
// Exposed as a CLI (for shell scripts) and as a require'd module (for tests):
//   node lib/pui-config.js <command> [args...]
//
// Commands:
//   merge-object   <file> <json-string>        Merge JSON object into file (deep).
//   merge-array    <file> <key> <json-array>   Merge array under key (dedup, preserve existing).
//   set-server     <file> <name> <json-def>    Set mcpServers[name] = def (merge, preserve unknown).
//   remove-server  <file> <name>               Remove mcpServers[name] if it matches pui-managed shape.
//   prioritize     <file> <dot.key> <json-array>  Move listed items to front of that array (preserve rest).
//   unpin-package  <file> <name>               Normalize packages[] "npm:<name>@x.y.z" entries to "npm:<name>".
//   set-package    <file> <exact-spec>         Replace all pins for one managed package with one exact spec.
//   read           <file>                      Print parsed JSON or {} if missing.
//   validate       <file>                       Exit 0 if file parses, 1 otherwise; print error.
//   backup         <file>                      Copy file to <file>.pui-backup-<timestamp>.
//   default-tools-merge <file> <json-array>    Merge required tools into defaultTools (dedup, preserve).
//   remove-array-items <file> <dot.key> <json-array>  Remove retired values from an array.
//   set-owned-fields <file> <dot.key> <json-object>  Replace managed leaves; preserve sibling fields.
//   verify-owned-fields <file> <dot.key> <json-object>  Exit 0 only when managed leaves match.
//   remove-owned-fields <file> <dot.key> <json-object>  Remove exact managed leaves; exit 2 on drift.
//   resolve-config-path <fallback> <xdg-relative>  Resolve an existing XDG file or the fallback path.
//   config-candidate-paths <fallback> <xdg-relative>  Print XDG and fallback ownership paths.
//   reconcile-model-mappings <file> <json-object>  Add/update shipped defaults without reviving user deletions.
//   validate-model-mappings <file>               Validate the PUI subagent mapping schema.
//
// Merge semantics:
//   - Deep merge for objects: existing keys preserved, PUI keys added/overwritten only when PUI owns them.
//   - Arrays under defaultTools: append missing PUI entries, preserve existing, no duplicates.
//   - MCP servers: PUI owns the "playwright" entry only if absent or compatible; conflicts are reported, not overwritten.
//
// Idempotency: running the same command twice yields the same result with no duplicates.
//
// JSON parse errors on target files are NEVER silently overwritten: validate/merge exit non-zero
// and print the path + parse error so the caller stops before mutation.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { isDeepStrictEqual } = require("util");

function readJsonSafe(file) {
  if (!fs.existsSync(file)) return { ok: true, value: {}, existed: false };
  try {
    const text = fs.readFileSync(file, "utf8");
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Top-level JSON must be an object", existed: true };
    }
    return { ok: true, value, existed: true };
  } catch (e) {
    return { ok: false, error: e.message, existed: true };
  }
}

function atomicWriteFile(file, content) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(file)}.pui-tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    if (process.platform !== "win32") {
      try {
        const dirFd = fs.openSync(dir, "r");
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch { /* best-effort directory durability on filesystems that support it */ }
    }
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function writeJson(file, value) {
  atomicWriteFile(file, JSON.stringify(value, null, 2) + "\n");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validMappingRecord(value) {
  if (!isPlainObject(value)) return false;
  const keys = new Set();
  for (const [parent, child] of Object.entries(value)) {
    const normalized = parent.toLowerCase();
    if (parent === "" || parent !== parent.trim() || keys.has(normalized) || typeof child !== "string" || child.trim() === "") return false;
    keys.add(normalized);
  }
  return true;
}

function caseInsensitiveKey(record, key) {
  const normalized = key.toLowerCase();
  return Object.keys(record).find((candidate) => candidate.toLowerCase() === normalized);
}

function validateModelMappingsConfig(value) {
  if (!isPlainObject(value)) return { ok: false, error: "Top-level JSON must be an object" };
  if (value.schemaVersion !== 1) return { ok: false, error: "schemaVersion must be 1" };
  if (!validMappingRecord(value.modelMappings)) return { ok: false, error: "modelMappings must contain non-empty string keys and values" };
  if (value._pui !== undefined && (!isPlainObject(value._pui) || !validMappingRecord(value._pui.defaultMappings))) {
    return { ok: false, error: "_pui.defaultMappings must contain non-empty string keys and values" };
  }
  return { ok: true };
}

function reconcileModelMappings(existing, defaults) {
  if (!isPlainObject(existing) || !validMappingRecord(defaults)) throw new Error("model mapping inputs must be objects with non-empty string keys and values");
  if (Object.keys(existing).length > 0) {
    const validated = validateModelMappingsConfig(existing);
    if (!validated.ok) throw new Error(validated.error);
  }
  const current = { ...(existing.modelMappings || {}) };
  const previousDefaults = isPlainObject(existing._pui?.defaultMappings)
    ? existing._pui.defaultMappings
    : {};

  for (const [parent, previousChild] of Object.entries(previousDefaults)) {
    if (caseInsensitiveKey(defaults, parent) !== undefined) continue;
    const currentKey = caseInsensitiveKey(current, parent);
    if (currentKey !== undefined && current[currentKey] === previousChild) delete current[currentKey];
  }
  for (const [parent, child] of Object.entries(defaults)) {
    const previousKey = caseInsensitiveKey(previousDefaults, parent);
    const currentKey = caseInsensitiveKey(current, parent);
    if (previousKey === undefined) {
      if (currentKey === undefined) current[parent] = child;
    } else if (currentKey !== undefined && current[currentKey] === previousDefaults[previousKey]) {
      current[currentKey] = child;
    }
  }

  return {
    ...existing,
    schemaVersion: 1,
    modelMappings: current,
    _pui: {
      ...(isPlainObject(existing._pui) ? existing._pui : {}),
      defaultMappings: { ...defaults },
    },
  };
}

function deepMerge(base, pui, puiOwnedKeys, inheritedOwned = false) {
  // Deep merge pui into base. base wins for unknown keys; pui wins for puiOwnedKeys.
  // puiOwnedKeys is a set of dotted paths PUI is allowed to overwrite.
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(pui)) {
    const pv = pui[k];
    const bv = base[k];
    const ownedPath = inheritedOwned || (puiOwnedKeys ? puiOwnedKeys.has(k) : false);
    if (pv && typeof pv === "object" && !Array.isArray(pv) && bv && typeof bv === "object" && !Array.isArray(bv)) {
      out[k] = deepMerge(bv, pv, null, ownedPath);
    } else if (Array.isArray(pv) && Array.isArray(bv)) {
      // Arrays always dedup-merge: preserve existing entries, append missing PUI entries.
      // PUI must not delete unrelated user providers or tools.
      out[k] = mergeArrayUnique(bv, pv);
    } else if (ownedPath || bv === undefined) {
      out[k] = pv;
    } else {
      // existing non-pui value: preserve
      out[k] = bv;
    }
  }
  return out;
}

function mergeArrayUnique(existing, required) {
  const out = [...existing];
  for (const item of required) {
    if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item);
  }
  return out;
}

function removeArrayItemsAtPath(config, keyPath, retired) {
  if (!Array.isArray(retired)) throw new Error("retired values must be an array");
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  if (!parts.length || parts.some((part) => !part)) throw new Error("array path must not be empty");

  let parent = config;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) return 0;
    parent = parent[part];
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return 0;
  const key = parts[parts.length - 1];
  if (!Array.isArray(parent[key])) return 0;

  const before = parent[key].length;
  parent[key] = parent[key].filter((item) => !retired.some((value) => JSON.stringify(value) === JSON.stringify(item)));
  return before - parent[key].length;
}

function setOwnedFieldsAtPath(config, keyPath, managed) {
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("managed fields must be an object");
  }
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  if (!parts.length || parts.some((part) => !part)) throw new Error("object path must not be empty");

  let parent = config;
  for (const part of parts.slice(0, -1)) {
    if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) parent[part] = {};
    parent = parent[part];
  }
  const key = parts[parts.length - 1];
  const target = parent[key] && typeof parent[key] === "object" && !Array.isArray(parent[key]) ? parent[key] : {};
  for (const [field, value] of Object.entries(managed)) target[field] = structuredClone(value);
  parent[key] = target;
  return target;
}

function ownedFieldsTargetAtPath(config, keyPath) {
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  if (!parts.length || parts.some((part) => !part)) throw new Error("object path must not be empty");
  let parent = config;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) return { parts, parent: null, target: null };
    parent = parent[part];
  }
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return { parts, parent: null, target: null };
  const target = parent[parts[parts.length - 1]];
  return {
    parts,
    parent,
    target: target && typeof target === "object" && !Array.isArray(target) ? target : null,
  };
}

function ownedFieldsMatchAtPath(config, keyPath, managed) {
  if (!managed || typeof managed !== "object" || Array.isArray(managed)) {
    throw new Error("managed fields must be an object");
  }
  const { target } = ownedFieldsTargetAtPath(config, keyPath);
  return Boolean(target) && Object.entries(managed).every(([field, value]) =>
    Object.hasOwn(target, field) && isDeepStrictEqual(target[field], value));
}

function removeOwnedFieldsAtPath(config, keyPath, managed) {
  if (!ownedFieldsMatchAtPath(config, keyPath, managed)) return false;
  const { parts, parent, target } = ownedFieldsTargetAtPath(config, keyPath);
  for (const field of Object.keys(managed)) delete target[field];
  if (Object.keys(target).length === 0) delete parent[parts[parts.length - 1]];
  return true;
}

function expandHome(file, home = os.homedir()) {
  return String(file).replace(/^~(?=$|[\\/])/, home);
}

function configCandidatePaths(fallback, xdgRelative, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const fallbackPath = path.resolve(expandHome(fallback, home));
  const candidates = [];
  const rawXdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  if (rawXdg) {
    const xdgHome = expandHome(rawXdg, home);
    if (path.isAbsolute(xdgHome)) candidates.push(path.resolve(xdgHome, xdgRelative));
  }
  candidates.push(fallbackPath);
  const seen = new Set();
  return candidates.filter((candidate) => {
    const identity = process.platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function resolveConfigPath(fallback, xdgRelative, options = {}) {
  const exists = options.exists ?? fs.existsSync;
  const candidates = configCandidatePaths(fallback, xdgRelative, options);
  return candidates.find((candidate, index) => index < candidates.length - 1 && exists(candidate))
    ?? candidates[candidates.length - 1];
}

function packageToken(args) {
  // Extract the npm package name (e.g. "@playwright/mcp") from an args array.
  // Skips flag tokens ("-y", "--browser") and their values ("chrome"); the
  // package spec is the first positional token containing "@" or "/",
  // so compatibility checks compare actual packages rather than "npx"/"-y".
  if (!Array.isArray(args)) return null;
  for (const a of args) {
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (/[@/]/.test(a)) return a.replace(/@[^/]*$/, "").replace(/@$/, "");
  }
  return null;
}

function piPackageName(spec) {
  if (typeof spec !== "string" || !spec.startsWith("npm:")) return null;
  const value = spec.slice(4);
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return value;
  return value.slice(0, separator);
}

function setMcpServer(config, name, definition, puiManagedFields) {
  // Merge server into config.mcpServers. Preserve unknown existing fields on a compatible server.
  // Compatible = same command AND same npm package token (different flags = compatible, PUI updates).
  // Do NOT overwrite an existing materially-different user server (conflict).
  const servers = config.mcpServers || {};
  const existing = servers[name];
  if (existing) {
    const sameCommand = existing.command === definition.command;
    const defPkg = packageToken(definition.args);
    const exPkg = packageToken(existing.args);
    const compatible = sameCommand && (defPkg === null || exPkg === null || defPkg === exPkg);
    if (compatible) {
      const merged = deepMerge(existing, definition, new Set(puiManagedFields));
      for (const field of puiManagedFields) {
        if (Object.hasOwn(definition, field)) merged[field] = structuredClone(definition[field]);
      }
      servers[name] = merged;
      config.mcpServers = servers;
      return { action: "updated", name };
    }
    return { action: "conflict", name, existing };
  }
  servers[name] = definition;
  config.mcpServers = servers;
  return { action: "added", name };
}

function backupFile(file) {
  if (!fs.existsSync(file)) return { ok: true, backup: null };
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.pui-backup-${ts}`;
  fs.copyFileSync(file, backup);
  return { ok: true, backup };
}

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const expand = (p) => p.replace(/^~(?=$|\\|\/)/, process.env.HOME || process.env.USERPROFILE || "");
  // If an arg starts with @, treat it as a path to a JSON file to read inline.
  const readArg = (a) => {
    if (typeof a === "string" && a.startsWith("@") && a.length > 1 && fs.existsSync(a.slice(1))) {
      try { return fs.readFileSync(a.slice(1), "utf8"); } catch (e) { return a; }
    }
    return a;
  };

  if (cmd === "read") {
    const file = expand(args[1]);
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    process.stdout.write(JSON.stringify(r.value, null, 2) + "\n");
    return;
  }

  if (cmd === "validate") {
    const file = expand(args[1]);
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`INVALID: ${file}: ${r.error}`); process.exit(1); }
    console.log(r.existed ? "VALID" : "MISSING_OK");
    return;
  }

  if (cmd === "validate-model-mappings") {
    const file = expand(args[1]);
    const r = readJsonSafe(file);
    if (!r.ok || !r.existed) { console.error(`INVALID: ${file}: ${r.error || "file is missing"}`); process.exit(1); }
    const validated = validateModelMappingsConfig(r.value);
    if (!validated.ok) { console.error(`INVALID: ${file}: ${validated.error}`); process.exit(1); }
    console.log("VALID");
    return;
  }

  if (cmd === "reconcile-model-mappings") {
    const file = expand(args[1]);
    const defaults = JSON.parse(readArg(args[2]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    if (r.existed) {
      const validated = validateModelMappingsConfig(r.value);
      if (!validated.ok) { console.error(`ERROR: ${file}: ${validated.error}`); process.exit(1); }
    }
    try {
      const reconciled = reconcileModelMappings(r.value, defaults);
      if (!isDeepStrictEqual(reconciled, r.value)) writeJson(file, reconciled);
      process.stdout.write(JSON.stringify({ ok: true, file, changed: !isDeepStrictEqual(reconciled, r.value) }) + "\n");
    } catch (error) {
      console.error(`ERROR: ${file}: ${error.message}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "backup") {
    const file = expand(args[1]);
    const r = backupFile(file);
    if (r.backup) console.log(r.backup);
    return;
  }

  if (cmd === "merge-object") {
    const file = expand(args[1]);
    const pui = JSON.parse(readArg(args[2]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    // PUI owns the top-level keys it writes.
    const owned = new Set(Object.keys(pui));
    const merged = deepMerge(r.value, pui, owned);
    writeJson(file, merged);
    process.stdout.write(JSON.stringify({ ok: true, file }) + "\n");
    return;
  }

  if (cmd === "default-tools-merge") {
    const file = expand(args[1]);
    const required = JSON.parse(readArg(args[2]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    const existing = Array.isArray(r.value.defaultTools) ? r.value.defaultTools : [];
    r.value.defaultTools = mergeArrayUnique(existing, required);
    writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, defaultTools: r.value.defaultTools }) + "\n");
    return;
  }

  if (cmd === "remove-array-items") {
    const file = expand(args[1]);
    const keyPath = args[2];
    const retired = JSON.parse(readArg(args[3]));
    if (!fs.existsSync(file)) {
      process.stdout.write(JSON.stringify({ ok: true, file, key: keyPath, removed: [] }) + "\n");
      return;
    }
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    let removed;
    try {
      removed = removeArrayItemsAtPath(r.value, keyPath, retired);
    } catch (error) {
      console.error(`ERROR: ${file}: ${error.message}`);
      process.exit(1);
    }
    if (removed > 0) writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, key: keyPath, removed }) + "\n");
    return;
  }

  if (cmd === "set-owned-fields") {
    const file = expand(args[1]);
    const keyPath = args[2];
    const managed = JSON.parse(readArg(args[3]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    try {
      setOwnedFieldsAtPath(r.value, keyPath, managed);
    } catch (error) {
      console.error(`ERROR: ${file}: ${error.message}`);
      process.exit(1);
    }
    writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, key: keyPath }) + "\n");
    return;
  }

  if (cmd === "verify-owned-fields" || cmd === "remove-owned-fields") {
    const file = expand(args[1]);
    const keyPath = args[2];
    const managed = JSON.parse(readArg(args[3]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    let matches;
    try {
      matches = ownedFieldsMatchAtPath(r.value, keyPath, managed);
    } catch (error) {
      console.error(`ERROR: ${file}: ${error.message}`);
      process.exit(1);
    }
    if (!matches) process.exit(2);
    let backup = null;
    if (cmd === "remove-owned-fields") {
      backup = backupFile(file).backup;
      removeOwnedFieldsAtPath(r.value, keyPath, managed);
      writeJson(file, r.value);
    }
    process.stdout.write(JSON.stringify({ ok: true, file, key: keyPath, backup }) + "\n");
    return;
  }

  if (cmd === "resolve-config-path") {
    process.stdout.write(resolveConfigPath(args[1], args[2]) + "\n");
    return;
  }

  if (cmd === "config-candidate-paths") {
    process.stdout.write(configCandidatePaths(args[1], args[2]).join("\n") + "\n");
    return;
  }

  if (cmd === "set-server") {
    const file = expand(args[1]);
    const name = args[2];
    const def = JSON.parse(readArg(args[3]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    const puiManaged = ["command", "args", "directTools"];
    const result = setMcpServer(r.value, name, def, puiManaged);
    if (result.action === "conflict") {
      console.error(`CONFLICT: ${file}: mcpServers.${name} exists with different shape`);
      process.stdout.write(JSON.stringify({ ok: false, action: "conflict", file, name }) + "\n");
      process.exit(2);
    }
    writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, action: result.action, file, name }) + "\n");
    return;
  }

  if (cmd === "remove-server") {
    const file = expand(args[1]);
    const name = args[2];
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    const servers = r.value.mcpServers || {};
    if (servers[name]) {
      delete servers[name];
      r.value.mcpServers = servers;
      writeJson(file, r.value);
      process.stdout.write(JSON.stringify({ ok: true, action: "removed", file, name }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({ ok: true, action: "absent", file, name }) + "\n");
    }
    return;
  }

  if (cmd === "prioritize") {
    // prioritize <file> <dot.key> <json-array>
    // Move the listed items to the front of the array at dot.key (existing
    // order preserved for the rest). Used to make PUI's keyless providers
    // primary without deleting user-owned providers.
    const file = expand(args[1]);
    const keyPath = args[2].split(".");
    const first = JSON.parse(readArg(args[3]));
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    let node = r.value;
    for (const k of keyPath.slice(0, -1)) {
      if (!node || typeof node !== "object") { console.error(`ERROR: ${file}: missing object at '${k}'`); process.exit(1); }
      node = node[k];
    }
    const last = keyPath[keyPath.length - 1];
    const arr = Array.isArray(node ? node[last] : null) ? node[last] : [];
    const head = [];
    const rest = [];
    for (const item of arr) {
      const isHead = head.length < first.length && first.some((x) => JSON.stringify(x) === JSON.stringify(item));
      (isHead ? head : rest).push(item);
    }
    // Preserve requested order in head.
    head.sort((a, b) => first.findIndex((x) => JSON.stringify(x) === JSON.stringify(a)) - first.findIndex((x) => JSON.stringify(x) === JSON.stringify(b)));
    node[last] = head.concat(rest.filter((x) => !head.some((h) => JSON.stringify(h) === JSON.stringify(x))));
    writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, key: args[2], value: node[last] }) + "\n");
    return;
  }

  if (cmd === "unpin-package") {
    // unpin-package <file> <name>
    // In packages[], normalize entries like "npm:<name>@1.2.3" to "npm:<name>".
    // Other entries are untouched. Reports what changed.
    const file = expand(args[1]);
    const name = args[2];
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    const pkgs = Array.isArray(r.value.packages) ? r.value.packages : [];
    let changed = 0;
    r.value.packages = pkgs.map((p) => {
      if (typeof p === "string" && p.startsWith(`npm:${name}@`)) {
        changed++;
        return `npm:${name}`;
      }
      return p;
    });
    if (changed > 0) writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, name, unpinned: changed }) + "\n");
    return;
  }

  if (cmd === "set-package") {
    const file = expand(args[1]);
    const exactSpec = args[2];
    const name = piPackageName(exactSpec);
    if (!name || !/@\d+\.\d+\.\d+$/.test(exactSpec)) {
      console.error(`ERROR: invalid exact Pi package spec: ${exactSpec}`);
      process.exit(1);
    }
    const r = readJsonSafe(file);
    if (!r.ok) { console.error(`ERROR: ${file}: ${r.error}`); process.exit(1); }
    const packages = Array.isArray(r.value.packages) ? r.value.packages : [];
    const out = [];
    let inserted = false;
    for (const spec of packages) {
      if (piPackageName(spec) === name) {
        if (!inserted) { out.push(exactSpec); inserted = true; }
      } else out.push(spec);
    }
    if (!inserted) out.push(exactSpec);
    r.value.packages = out;
    writeJson(file, r.value);
    process.stdout.write(JSON.stringify({ ok: true, file, name, spec: exactSpec }) + "\n");
    return;
  }

  console.error("Usage: pui-config.js <command> [args...]");
  process.exit(64);
}

module.exports = {
  readJsonSafe,
  atomicWriteFile,
  writeJson,
  deepMerge,
  mergeArrayUnique,
  removeArrayItemsAtPath,
  setOwnedFieldsAtPath,
  ownedFieldsMatchAtPath,
  removeOwnedFieldsAtPath,
  configCandidatePaths,
  resolveConfigPath,
  packageToken,
  piPackageName,
  setMcpServer,
  backupFile,
  reconcileModelMappings,
  validateModelMappingsConfig,
};

if (require.main === module) main();
