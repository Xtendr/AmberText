// Explicit research fixture; uses bundled artifact packages without app adoption.
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { buildFixtureDocument } from "./docx-feasibility-adapter.mjs";

const packages = process.env.AMBERTEXT_ARTIFACT_PACKAGES;
if (!packages) throw new Error("Set AMBERTEXT_ARTIFACT_PACKAGES to the dependency loader's bundled package directory");
const require = createRequire(join(packages, "docx/package.json"));
const { chromium } = require("playwright-core");
const candidateRoot = join(packages, "docx"), packageInfo = JSON.parse(await readFile(join(candidateRoot, "package.json"), "utf8"));
assert.equal(packageInfo.version, "9.6.1", "Reassess candidate API if the bundled version changes");
const api = await import(pathToFileURL(join(candidateRoot, "dist/index.mjs")));
const root = dirname(fileURLToPath(import.meta.url)), output = resolve(process.argv[2] || "");
assert.ok(process.argv[2], "Pass an explicit writable research output directory");
const markdown = await readFile(join(root, "fixtures/s5-features.md"), "utf8");
const script = await readFile(join(root, "docx-feasibility-adapter.mjs"));
const candidate = await readFile(join(candidateRoot, "dist/index.mjs"));
const server = createServer((request, response) => {
  const body = request.url === "/candidate.mjs" ? candidate : request.url === "/adapter.mjs" ? script : request.url === "/" ? Buffer.from("<!doctype html><title>Isolated export fixture</title>") : null;
  response.writeHead(body ? 200 : 404, { "Content-Type": request.url?.endsWith(".mjs") ? "text/javascript" : "text/html" }); response.end(body ?? "Unavailable");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`, app = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1431";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const context = await browser.newContext(), errors = [], network = [];
  await context.route("**/*", route => { const url = new URL(route.request().url()); if (/^https?:$/.test(url.protocol) && ![origin, new URL(app).origin].includes(url.origin)) { network.push(url.href); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await page.goto(app); await page.waitForSelector(".cm-content");
  const tokens = await page.evaluate(async markdown => {
    const owner = await import("/src/lib/markdown.ts");
    return JSON.parse(JSON.stringify(owner.parseMarkdownTokens(markdown)));
  }, markdown);
  const before = createHash("sha256").update(markdown).digest("hex");
  // The only approved image is a disposable local PNG supplied explicitly.
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4sMLgPwAHHALIqHHLzwAAAABJRU5ErkJggg==";
  const png = Buffer.from(pngBase64, "base64");
  const asset = { type: "png", bytes: new Uint8Array(png), width: 32, height: 32 };
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "owner-tokens.json"), JSON.stringify(tokens, null, 2));
  const nodeResult = buildFixtureDocument(api, tokens, new Map([["assets/fixture.png", asset]]));
  const nodeBytes = new Uint8Array(await api.Packer.toArrayBuffer(nodeResult.document));
  await writeFile(join(output, "node-fixture.docx"), nodeBytes);
  console.log("PASS pinned-node-packer-and-owner-token-adapter");
  await page.goto(origin);
  const browserResult = await page.evaluate(async ({ tokens, pngBase64 }) => {
    const api = await import("/candidate.mjs"), { buildFixtureDocument } = await import("/adapter.mjs");
    const bytes = Uint8Array.from(atob(pngBase64), c => c.charCodeAt(0));
    const result = buildFixtureDocument(api, tokens, new Map([["assets/fixture.png", { type: "png", bytes, width: 32, height: 32 }]]), { direction: "rtl" });
    const packed = new Uint8Array(await api.Packer.toArrayBuffer(result.document));
    let binary = ""; for (const byte of packed) binary += String.fromCharCode(byte);
    return { base64: btoa(binary), warnings: result.warnings, anchors: result.anchors };
  }, { tokens, pngBase64 });
  await writeFile(join(output, "browser-rtl-fixture.docx"), Buffer.from(browserResult.base64, "base64"));
  console.log("PASS pinned-browser-packer-rtl-and-ltr-code");
  const kinds = new Set(nodeResult.warnings.map(w => w.kind));
  for (const kind of ["unresolved-or-file-link", "unavailable-image", "remote-image-not-fetched", "math-source-fallback", "footnote-fallback", "diagram-source-fallback", "unsupported-block", "task-rendered-as-text"]) assert.ok(kinds.has(kind), `Missing warning: ${kind}`);
  assert.ok(nodeResult.anchors.some(([id]) => id === "repeated-heading-1"));
  assert.ok(nodeResult.anchors.some(([id]) => id === "日本語-heading"));
  assert.deepEqual(browserResult.warnings, nodeResult.warnings);
  assert.equal(createHash("sha256").update(await readFile(join(root, "fixtures/s5-features.md"))).digest("hex"), before);
  assert.deepEqual(errors, []); assert.deepEqual(network, []);
  console.log("PASS explicit-fallbacks-source-preservation-no-network");
  // Record exact resolved dependency metadata; this is not a legal/security audit.
  const closure = [], visited = new Set();
  async function metadata(name, parent) {
    const resolver = createRequire(join(parent, "package.json"));
    let location;
    try { location = resolver.resolve(`${name}/package.json`); }
    catch {
      let directory = dirname(resolver.resolve(name));
      for (;;) {
        try { const p = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); if (p.name === name) { location = join(directory, "package.json"); break; } } catch { /* ascend */ }
        const next = dirname(directory); if (next === directory) throw new Error(`Package metadata not found: ${name}`); directory = next;
      }
    }
    const p = JSON.parse(await readFile(location, "utf8")), key = `${p.name}@${p.version}`;
    if (visited.has(key)) return; visited.add(key);
    closure.push({ name: p.name, version: p.version, license: p.license ?? null, dependencies: p.dependencies ?? {} });
    for (const dependency of Object.keys(p.dependencies ?? {})) await metadata(dependency, dirname(location));
  }
  await metadata("docx", candidateRoot);
  await writeFile(join(output, "evidence.json"), JSON.stringify({ candidate: { version: packageInfo.version, license: packageInfo.license, esmSha256: createHash("sha256").update(candidate).digest("hex"), esmBytes: candidate.length, esmGzipBytes: gzipSync(candidate).length }, closure, tokenTypes: [...new Set(tokens.flatMap(t => [t.type, ...(t.children ?? []).map(c => c.type)]))], warnings: nodeResult.warnings, anchors: nodeResult.anchors, sourceSha256: before, imageSha256: createHash("sha256").update(png).digest("hex"), nodeBytes: nodeBytes.length, browserBytes: Buffer.from(browserResult.base64, "base64").length, externalNetworkAttempts: network.length, readerFidelity: "UNVERIFIED: Word/LibreOffice not opened", nativeDelivery: "UNVERIFIED: no actual native IPC/installed app export" }, null, 2));
  console.log(`PASS resolved-package-metadata (${closure.length} packages)`);
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
