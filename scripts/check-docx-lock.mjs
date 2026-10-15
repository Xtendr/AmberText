// Exact adoption audit: preserve all existing locked packages and record new closure.
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import assert from "node:assert/strict";
const before = JSON.parse(execFileSync("git", ["show", "291f0e1f86559e0d644d61e36ab451eb27e0ab6f:package-lock.json"], { encoding: "utf8", windowsHide: true }));
const after = JSON.parse(await readFile("package-lock.json", "utf8"));
for (const [path, entry] of Object.entries(before.packages)) {
 if (path === "") continue;
 assert.deepEqual(after.packages[path], entry, `Preexisting locked package changed: ${path}`);
}
const expectedRoot = structuredClone(before.packages[""]); expectedRoot.dependencies.docx = "9.6.1";
assert.deepEqual(after.packages[""], expectedRoot);
assert.equal(after.packages["node_modules/docx"].integrity, "sha512-ZJja9/KBUuFC109sCMzovoq2GR2wCG/AuxivjA+OHj/q0TEgJIm3S7yrlUxIy3B+bV8YDj/BiHfWyrRFmyWpDQ==");
const entries = [], visited = new Set();
async function collect(name, parent) {
 const require = createRequire(join(parent, "package.json"));
 let location;
 try { location = require.resolve(`${name}/package.json`); }
 catch {
  let folder = dirname(require.resolve(name));
  for (;;) {
   try { const candidate = JSON.parse(await readFile(join(folder, "package.json"), "utf8")); if (candidate.name === name) { location = join(folder, "package.json"); break; } } catch { /* parent */ }
   const next = dirname(folder); if (next === folder) throw new Error(`Cannot locate ${name}`); folder = next;
  }
 }
 const p = JSON.parse(await readFile(location, "utf8")), identity = `${p.name}@${p.version}`;
 if (visited.has(identity)) return; visited.add(identity);
 entries.push({ name: p.name, version: p.version, license: p.license ?? null, path: location.slice(resolve("node_modules").length + 1).replaceAll("\\", "/") });
 for (const dep of Object.keys(p.dependencies ?? {})) await collect(dep, dirname(location));
}
await collect("docx", resolve("."));
const additions = Object.keys(after.packages).filter(path => !Object.hasOwn(before.packages, path));
assert.equal(additions.length, entries.length);
const evidence = { pinned: "docx9.6.1", unchangedExistingPackages: Object.keys(before.packages).length - 1, additions, resolvedClosure: entries, limit: "Resolver metadata, not dependency provenance inside the prebuilt candidate ESM or a release/legal audit" };
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2));
console.log(`PASS preserve-${evidence.unchangedExistingPackages}-existing-lock-entries-and-${entries.length}-new-package-closure`);
