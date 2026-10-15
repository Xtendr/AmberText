// Check installed pinned package compatibility with the project's actual Vite.
import { build } from "vite";
import { resolve, join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

assert.ok(process.argv[2], "Explicit writable research output directory required");
const out = resolve(process.argv[2]);
const candidate = await readFile("node_modules/docx/dist/index.mjs");
assert.equal(createHash("sha256").update(candidate).digest("hex"), "21a9b418075bf88ba388dff7776cd4449d90f3f63f7788e92427fe01a933b7c5", "Installed artifact differs from tested candidate");
const results = [];
for (const target of ["chrome111", "safari16"]) {
  const directory = join(out, target);
  const result = await build({ configFile: false, logLevel: "warn", build: { target, minify: true, write: false, lib: { entry: resolve("scripts/docx-candidate-entry.ts"), formats: ["es"], fileName: "candidate" } } });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => r.output);
  await mkdir(directory, { recursive: true });
  for (const chunk of chunks) {
    assert.equal(chunk.type, "chunk");
    assert.deepEqual(chunk.imports, [], "Candidate requires external runtime modules");
    assert.deepEqual(chunk.dynamicImports, [], "Candidate requires unrecorded lazy imports");
    await writeFile(join(directory, chunk.fileName), chunk.code);
    results.push({ target, file: chunk.fileName, bytes: Buffer.byteLength(chunk.code), gzipBytes: gzipSync(chunk.code).length, sha256: createHash("sha256").update(chunk.code).digest("hex") });
  }
  console.log(`PASS installed-candidate-vite-build-${target}`);
}
await writeFile(join(out, "candidate-build.json"), JSON.stringify({ version: "9.6.1", results, limitation: "Isolated candidate API probe, not actual export UI or macOS WebView runtime proof" }, null, 2));
