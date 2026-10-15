// Runtime check of the approved installed package; not a reader fidelity check.
import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url), { chromium } = require("playwright-core"), JSZip = require("jszip");
assert.ok(process.argv[2], "Pass explicit bundle evidence directory");
const directory = resolve(process.argv[2]), metadata = JSON.parse(await readFile(join(directory, "candidate-build.json"), "utf8"));
const sources = new Map(await Promise.all(metadata.results.map(async result => [`/${result.target}.mjs`, await readFile(join(directory, result.target, result.file))])));
const server = createServer((req, res) => { const source = sources.get(req.url); res.writeHead(200, { "Content-Type": source ? "text/javascript" : "text/html" }); res.end(source ?? "<!doctype html><title>Private candidate check</title>"); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ channel: "msedge", headless: true });
const results = [];
try {
 const context = await browser.newContext(), page = await context.newPage(), errors = [], network = [];
 page.on("pageerror", e => errors.push(e.message));
 await context.route("**/*", r => { const url = new URL(r.request().url()); if (/^https?:$/.test(url.protocol) && url.origin !== origin) { network.push(url.href); return r.abort(); } return r.continue(); });
 await page.goto(origin);
 for (const target of ["chrome111", "safari16"]) {
  const base64 = await page.evaluate(async target => { const { candidatePacket } = await import(`/${target}.mjs`); const image = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4sMLgPwAHHALIqHHLzwAAAABJRU5ErkJggg=="), c => c.charCodeAt(0)); const packet = await candidatePacket(image); let binary = ""; for (const n of packet) binary += String.fromCharCode(n); return btoa(binary); }, target);
  const bytes = Buffer.from(base64, "base64"), zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const xml = await zip.file("word/document.xml").async("string"), footnotes = await zip.file("word/footnotes.xml").async("string");
  assert.match(xml, /<w:footnoteReference w:id="1"/); assert.match(footnotes, /Native Word footnote fixture/);
  assert.match(xml, /العربية English/); assert.match(xml, /const source = 1;/);
  results.push({ target, packetBytes: bytes.length, footnoteStructure: true, runtime: "Headless Windows Edge; Safari target is not macOS runtime proof" });
  console.log(`PASS installed-${target}-bundle-runtime-and-native-footnote-structure`);
 }
 assert.deepEqual(errors, []); assert.deepEqual(network, []);
 await writeFile(join(directory, "candidate-runtime.json"), JSON.stringify({ results, errors, externalNetworkAttempts: network.length }, null, 2));
 await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
