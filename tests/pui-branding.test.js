const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const brandingScript = path.join(repoRoot, "lib", "pui-branding.js");
const { applyBranding, replaceBranding, replaceCssLayout } = require(brandingScript);

function writeFixture(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

test("dynamic titles use PUI-first ordering in every display mode", () => {
  const source = replaceBranding(
    'function makeTitle(project){return project?`${project} - Pi Web`:"Pi Web";} makeTitle("anbeeld-com");',
  );

  assert.doesNotMatch(source, /display-mode/);
  const serverTitle = vm.runInNewContext(source);
  const browserTitle = vm.runInNewContext(source, {
    window: { matchMedia: () => ({ matches: false }) },
  });
  const pwaTitle = vm.runInNewContext(source, {
    window: { matchMedia: () => ({ matches: true }) },
  });
  const pwaPuiProjectTitle = vm.runInNewContext(source.replace("anbeeld-com", "PUI"), {
    window: { matchMedia: () => ({ matches: true }) },
  });

  assert.equal(serverTitle, "PUI - anbeeld-com");
  assert.equal(browserTitle, "PUI - anbeeld-com");
  assert.equal(pwaTitle, "PUI - anbeeld-com");
  assert.equal(pwaPuiProjectTitle, "PUI - PUI");
});

test("branding migrates the previous display-mode title expression", () => {
  const previous =
    'const tab=project?typeof window !== "undefined"&&window.matchMedia("(display-mode: standalone)").matches?`PUI - ${project}`:`${project} - PUI`:"PUI";';

  assert.equal(replaceBranding(previous), 'const tab=project?`PUI - ${project}`:"PUI";');
});

test("apply changes only top-level Pi Web branding surfaces to PUI", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-branding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const serverPage = writeFixture(
    root,
    ".next/server/app/page.js",
    'let m={title:"Pi Web",description:"Pi Web interface for the pi coding agent",applicationName:"Pi Web",appleWebApp:{title:"Pi Web"}};const release="Pi Web v{version} is available. View release notes";const splash=expanded?"0.8.9p0.84.2":"Pi Web";const sidebar={children:"Pi Web"};const tab=project?`${project} - Pi Web`:"Pi Web";',
  );
  const notFoundPage = writeFixture(
    root,
    ".next/server/app/_not-found/page.js",
    'let m={title:"Pi Web",description:"Pi Web interface for the pi coding agent",applicationName:"Pi Web",appleWebApp:{title:"Pi Web"}};',
  );
  const html = writeFixture(
    root,
    ".next/server/app/index.html",
    '<title>Pi Web</title><script src="/_next/static/chunks/app/page-buildhash.js"></script><meta name="description" content="Pi Web interface for the pi coding agent"/><meta name="application-name" content="Pi Web"/><meta name="apple-mobile-web-app-title" content="Pi Web"/>\n[[\\"$\\",\\"title\\",\\"0\\",{\\"children\\":\\"Pi Web\\"}],[\\"$\\",\\"meta\\",\\"1\\",{\\"name\\":\\"description\\",\\"content\\":\\"Pi Web interface for the pi coding agent\\"}],[\\"$\\",\\"meta\\",\\"2\\",{\\"name\\":\\"application-name\\",\\"content\\":\\"Pi Web\\"}],[\\"$\\",\\"meta\\",\\"6\\",{\\"name\\":\\"apple-mobile-web-app-title\\",\\"content\\":\\"Pi Web\\"}]]',
  );
  const manifestBody = writeFixture(
    root,
    ".next/server/app/manifest.webmanifest.body",
    '{"id":"/","name":"Pi Web","short_name":"Pi Web","description":"Local web interface for the pi coding agent"}',
  );
  const manifestRoute = writeFixture(
    root,
    ".next/server/app/manifest.webmanifest/route.js",
    'let manifest={id:"/",name:"Pi Web",short_name:"Pi Web",description:"Local web interface for the pi coding agent"};',
  );
  const rsc = writeFixture(
    root,
    ".next/server/app/index.rsc",
    '[["$","title","0",{"children":"Pi Web"}],["$","meta","1",{"name":"description","content":"Pi Web interface for the pi coding agent"}],["$","meta","2",{"name":"application-name","content":"Pi Web"}],["$","meta","6",{"name":"apple-mobile-web-app-title","content":"Pi Web"}],["chunk","static/chunks/app/page-buildhash.js"]]',
  );
  const clientReferenceManifest = writeFixture(
    root,
    ".next/server/app/page_client-reference-manifest.js",
    'self.__RSC_MANIFEST={entryJSFiles:{"app/page":["static/chunks/app/page-buildhash.js"]}};',
  );
  const clientPage = writeFixture(
    root,
    ".next/static/chunks/app/page-buildhash.js",
    'const release="Pi Web v{version} is available. View release notes";const splash=typewriter(expanded?"0.8.9p0.84.2":"Pi Web",animate);const sidebar={children:"Pi Web"};const tab=project?`${project} - Pi Web`:"Pi Web";',
  );
  const componentDiagnostic = writeFixture(
    root,
    ".next/static/chunks/app/layout-buildhash.js",
    'console.error("Failed to register the Pi Web service worker:", error);',
  );
  const serviceWorker = writeFixture(
    root,
    "public/sw.js",
    'const STATIC_CACHE=`pi-web-static-${CACHE_VERSION}`;',
  );

  const result = spawnSync(process.execPath, [brandingScript, "apply", root], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  assert.equal(
    fs.readFileSync(serverPage, "utf8"),
    'let m={title:"PUI",description:"PUI - opinionated Pi setup",applicationName:"PUI",appleWebApp:{title:"PUI"}};const release="Pi Web v{version} is available. View release notes";const splash=expanded?"0.8.9p0.84.2":"PUI";const sidebar={children:"PUI"};const tab=project?`PUI - ${project}`:"PUI";',
  );
  assert.doesNotMatch(fs.readFileSync(notFoundPage, "utf8"), /Pi Web/);
  assert.match(fs.readFileSync(html, "utf8"), /<title>PUI<\/title>/);
  assert.doesNotMatch(fs.readFileSync(html, "utf8"), /Pi Web/);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestBody, "utf8")), {
    id: "/",
    name: "PUI",
    short_name: "PUI",
    description: "PUI - opinionated Pi setup",
  });
  assert.doesNotMatch(fs.readFileSync(manifestRoute, "utf8"), /Pi Web|Local web interface/);
  assert.doesNotMatch(fs.readFileSync(rsc, "latin1"), /Pi Web/);
  assert.match(fs.readFileSync(clientPage, "utf8"), /Pi Web v\{version\} is available/);
  assert.match(fs.readFileSync(clientPage, "utf8"), /"0\.8\.9p0\.84\.2":"PUI",animate/);
  assert.match(fs.readFileSync(clientPage, "utf8"), /children:"PUI"/);
  assert.doesNotMatch(fs.readFileSync(clientPage, "utf8"), /display-mode/);
  assert.match(fs.readFileSync(clientPage, "utf8"), /`PUI - \$\{project\}`/);
  const clientHash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(clientPage))
    .digest("hex")
    .slice(0, 12);
  const versionedChunk = `page-buildhash.js?pui=${clientHash}`;
  assert.ok(fs.readFileSync(html, "utf8").includes(versionedChunk));
  assert.ok(fs.readFileSync(rsc, "latin1").includes(versionedChunk));
  assert.ok(fs.readFileSync(clientReferenceManifest, "utf8").includes(versionedChunk));
  assert.equal(
    fs.readFileSync(componentDiagnostic, "utf8"),
    'console.error("Failed to register the Pi Web service worker:", error);',
  );
  assert.match(fs.readFileSync(serviceWorker, "utf8"), /-static-\$\{CACHE_VERSION\}-pui-/);
  assert.equal(
    fs.readFileSync(`${serviceWorker}.pui-original`, "utf8"),
    'const STATIC_CACHE=`pi-web-static-${CACHE_VERSION}`;',
  );

  for (const changed of [serverPage, notFoundPage, html, manifestBody, manifestRoute, rsc, clientPage, serviceWorker]) {
    assert.equal(fs.existsSync(`${changed}.pui-original`), true);
  }
  assert.equal(fs.existsSync(`${componentDiagnostic}.pui-original`), false);
});

test("widget trigger cell shrinks to content instead of reserving 70% of the shelf", () => {
  // pi-web stretches the widget trigger cell to 70% of the footer shelf when a
  // status line is present (flex:0 70%), so a single widget leaves a large
  // empty gap between the triggers and the status text.
  const upstreamRule =
    ".extension-status-shelf.has-widgets.has-status .extension-widget-triggers{border-right:1px solid var(--border);flex:0 70%;max-width:70%}";
  const result = replaceCssLayout(`.a{color:red}${upstreamRule}.b{color:blue}`);

  assert.ok(result.includes("flex:0 1 auto;max-width:70%"));
  assert.ok(!result.includes("flex:0 70%"));
  assert.ok(
    result.includes(
      ".extension-status-shelf.has-widgets.has-status .extension-widget-trigger:last-child{border-right:0}",
    ),
  );
  assert.equal(replaceCssLayout(result), result);
  assert.equal(replaceCssLayout(".a{color:red}"), ".a{color:red}");
});

test("apply patches the built CSS layout once and keeps the original", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-branding-layout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  writeFixture(root, ".next/server/app/page.js", "export {};");
  const upstream =
    ".x{color:red}.extension-status-shelf.has-widgets.has-status .extension-widget-triggers{border-right:1px solid var(--border);flex:0 70%;max-width:70%}.y{color:blue}";
  const css = writeFixture(root, ".next/static/css/app-hash.css", upstream);

  applyBranding(root);
  const patched = fs.readFileSync(css, "utf8");
  assert.ok(patched.includes("flex:0 1 auto;max-width:70%"));
  assert.ok(!patched.includes("flex:0 70%"));
  assert.ok(patched.includes(".extension-widget-trigger:last-child{border-right:0}"));
  assert.equal(fs.readFileSync(`${css}.pui-original`, "utf8"), upstream);

  applyBranding(root);
  assert.equal(fs.readFileSync(css, "utf8"), patched);
  assert.equal(fs.readdirSync(path.dirname(css)).filter((name) => name.endsWith(".pui-original")).length, 1);
});

test("every install and update entry point applies the shared branding helper", () => {
  for (const script of ["install.ps1", "update.ps1", "install.sh", "update.sh"]) {
    const content = fs.readFileSync(path.join(repoRoot, script), "utf8");
    assert.match(content, /lib[\\/]pui-branding\.js/);
    assert.doesNotMatch(content, /\$brandPairs|patch_brand\(\)/);
  }
});

test("the Unix installer reports applied branding only after helper success", () => {
  const content = fs.readFileSync(path.join(repoRoot, "install.sh"), "utf8");
  assert.match(
    content,
    /if node "\$SCRIPT_DIR\/lib\/pui-branding\.js" apply "\$PIWEB_PKG_ROOT"; then\s+echo "  branding override applied/,
  );
});

test("apply fails when an existing service worker cannot be cache-busted", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pui-branding-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".next", "server", "app"), { recursive: true });
  writeFixture(root, "public/sw.js", "const CACHE = 'unexpected';");

  const result = spawnSync(process.execPath, [brandingScript, "apply", root], {
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /service worker/i);
});
