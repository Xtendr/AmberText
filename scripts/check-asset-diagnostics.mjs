// Read-only controller/UI checks with disposable memory files; native proof separate.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1430";
async function until(page, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await page.evaluate(predicate)) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error("Timed out waiting for actual diagnostic completion");
}
const scenarios = ["missing-shared-outside", "dirty-overlay", "case-distinct", "network-policy", "directory-target", "cancel-retains", "late-edit", "late-root", "failed-source", "failed-read-budget", "result-bound", "stale-files", "keyboard-ui"];
const selected = process.env.AMBERTEXT_SCENARIO ? scenarios.filter(s => s === process.env.AMBERTEXT_SCENARIO) : scenarios;
assert.ok(selected.length, "Unknown diagnostic scenario");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try { for (const scenario of selected) {
  const context = await browser.newContext(), errors = [], network = [];
  try {
    await context.route("**/*", route => { const target = new URL(route.request().url()); if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    await page.goto(url); await page.waitForSelector(".cm-content");
    const result = await page.evaluate(async scenario => {
      const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts"), d = await import("/src/lib/assetDiagnostics.ts");
      const bridge = (await import("/src/editor/bridge.ts")).bridge;
      const check = (value, message) => { if (!value) throw new Error(message); }, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const root = "/Users/you/Notes/reference-" + scenario, first = root + "/A.md", second = root + "/B.md", image = root + "/assets/shared image.png";
      const text = '![a](assets/shared%20image.png#crop)\n[missing](missing.md)\n[remote](https://example.invalid/page)\n[jump](#heading)\n[undefined]\n`![code](bad.png)`\n![outside](../outside.png)';
      s.getState().setSettings({ autosave: false, historyEnabled: false, livePreview: false, viewMode: "write", sidebarOpen: true, sidebarTab: "files" });
      await p.fsApi.createFile(first, text); await p.fsApi.createFile(second, '![b][photo]\n\n[photo]: <assets/shared image.png>');
      await p.fsApi.createFile(image, "Simulated binary metadata fixture"); await p.fsApi.createFile("/Users/you/Notes/outside.png", "Outside fixture");
      await p.fsApi.createFile(root + "/.hidden.md", "![hidden](never.png)"); await p.fsApi.createFile(root + "/node_modules/ignored.md", "![generated](never.png)");
      await a.openFolder(root);
      let id;
      if (["dirty-overlay", "late-edit"].includes(scenario)) {
        id = await a.openPath(first); for (let n = 0; n < 100 && bridge.viewDocId !== id; n++) await wait(10); check(bridge.viewDocId === id, "Open fixture editor missing");
        if (scenario === "dirty-overlay") bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "![dirty](new-unsaved.png)" } });
      }
      if (scenario === "case-distinct") { await p.fsApi.createFile(root + "/assets/Shared image.png", "Separate fixture"); await p.fsApi.writeText(first, "![A](assets/Shared%20image.png)", (await p.fsApi.readText(first)).revision); }
      if (scenario === "network-policy") await p.fsApi.writeText(first, '[u](//server/share/a.png)\n[f](file:///C:/a.png)\n[r](https://example.invalid/x)', (await p.fsApi.readText(first)).revision);
      if (scenario === "directory-target") { await p.fsApi.createDir(root + "/folder"); await p.fsApi.writeText(first, '[folder](folder)', (await p.fsApi.readText(first)).revision); }
      const original = await p.fsApi.readText(first), imageBefore = await p.fsApi.readText(image);
      const realRead = p.fsApi.readText, realTarget = d.assetDiagnosticsApi.target, realSource = d.assetDiagnosticsApi.read;
      const attempts = [];
      window.fixtureAttempts = attempts;
      for (const method of ["writeText", "createFile", "createDir", "writeBase64", "copyFile", "rename", "trash"]) p.fsApi[method] = async () => { attempts.push(method); throw new Error("Diagnostics attempted mutation: " + method); };
      p.fsApi.readText = async path => { check(!/\.(png|jpg)$/i.test(path), "Diagnostics read image bytes"); return realRead(path); };
      if (scenario === "failed-source") d.assetDiagnosticsApi.read = async (root, path) => { if (path === first) throw new Error("Injected denied document"); return realSource(root, path); };
      if (scenario === "cancel-retains") { d.assetDiagnosticsApi.read = async (root, path) => { if (path === second) d.stopAssetDiagnostics(); return realSource(root, path); }; }
      if (["late-edit", "late-root"].includes(scenario)) { let changed = false; d.assetDiagnosticsApi.target = async (...args) => { const result = await realTarget(...args); if (!changed) { changed = true; if (scenario === "late-edit") a.updateContent(id, "Later writing retained"); else await a.openFolder("/Users/you/Notes"); } return result; }; }
      if (scenario === "network-policy") d.assetDiagnosticsApi.target = async (root, path) => { check(!path.includes("server") && !path.includes("example.invalid") && !path.includes("file:"), "Network/file URL was probed"); return realTarget(root, path); };
      if (scenario === "failed-read-budget") {
        d.assetDiagnosticsApi.catalogue = async () => ({ paths: Array.from({ length: 200 }, (_, i) => root + "/f" + i + ".md"), coverage: { visited:200, eligible:200, scanned:0, bytesRead:0, excluded:0, skipped:0, partial:false, cancelled:false, warnings:[] } });
        let reads = 0; d.assetDiagnosticsApi.read = async () => { reads++; throw new Error("Injected unreadable file"); };
        await d.scanAssetDiagnostics(); const state = d.useAssetDiagnostics.getState(); check(reads === 127 && state.coverage.partial && state.coverage.bytesRead === 0 && state.coverage.warnings.some(w => w.includes("too large to check completely")), "Failed read budget: " + JSON.stringify({ reads, coverage: state.coverage })); return { attempts };
      }
      if (scenario === "result-bound") {
        d.assetDiagnosticsApi.catalogue = async () => ({ paths: Array.from({ length: 11 }, (_, i) => root + "/f" + i + ".md"), coverage: { visited:11, eligible:11, scanned:0, bytesRead:0, excluded:0, skipped:0, partial:false, cancelled:false, warnings:[] } });
        const content = Array(2000).fill("![x](assets/shared%20image.png)").join(" ");
        d.assetDiagnosticsApi.read = async () => ({ ...original, content, byteLength: new TextEncoder().encode(content).length });
        await d.scanAssetDiagnostics(); const state = d.useAssetDiagnostics.getState(); check(state.records.length === 20000 && state.coverage.partial && state.coverage.scanned === 10, "Reference result bound or coverage hidden"); return { attempts };
      }
      if (scenario === "keyboard-ui") return { first, attempts };
      const done = await d.scanAssetDiagnostics(), state = d.useAssetDiagnostics.getState();
      if (scenario === "cancel-retains") { check(!done && state.coverage.cancelled && state.coverage.partial && state.records.some(r => r.sourcePath === first) && state.records.every(r => r.sourcePath !== second), "Cancellation hid completed results or accepted a late file"); }
      else if (["late-edit", "late-root"].includes(scenario)) { check(!done && state.stale && !state.busy && state.records.length === 0, "Late sources published current diagnostics"); if (id) check(s.getState().docs.find(x => x.id === id).content === "Later writing retained", "Diagnostic overwrote later writing"); }
      else if (scenario === "failed-source") check(done && state.coverage.partial && state.records.every(r => r.sourcePath !== first) && state.coverage.warnings.some(w => w.includes("denied")), "Source failure hidden or fallback guessed");
      else if (scenario === "dirty-overlay") { check(done && state.records.filter(r => r.sourcePath === first).length === 1 && state.records.some(r => r.target === "new-unsaved.png" && r.source === "buffer" && r.documentId === id), "Unsaved references did not replace disk references"); }
      else if (scenario === "case-distinct") { const found = state.records.filter(r => r.kind === "image"); check(found.length === 2 && found.every(r => r.uses === 1 && r.documents === 1), "Case-distinct fixture images were merged"); }
      else if (scenario === "directory-target") check(state.records.find(r => r.sourcePath === first).status === "unknown" && state.coverage.partial, "Folder was counted as a present image/file");
      else if (scenario === "network-policy") check(state.records.filter(r => r.sourcePath === first).every(r => r.status === "unknown" || r.status === "remote"), "Network target became a local file");
      else {
        check(done && state.coverage.scanned === 2 && state.coverage.excluded >= 2 && !state.coverage.partial, "Basic bounded coverage mismatch");
        check(state.records.filter(r => r.status === "missing").length === 1 && state.records.filter(r => r.status === "unresolved").length === 1, "Undefined bracket and missing file were confused");
        check(state.records.filter(r => r.canonicalPath === image).length === 2 && state.records.filter(r => r.canonicalPath === image).every(r => r.uses === 2 && r.documents === 2), "Shared image consumers missing");
        check(state.records.some(r => r.outside && r.status === "present") && !state.records.some(r => r.target === "bad.png" || r.target === "never.png"), "Outside references or code exclusions mismatch");
        if (scenario === "stale-files") { window.dispatchEvent(new CustomEvent("ambertext:filesystem-changed", { detail: [first] })); check(d.useAssetDiagnostics.getState().stale, "Filesystem change did not invalidate diagnostics"); }
      }
      check((await realRead(first)).content === original.content && (await realRead(image)).content === imageBefore.content, "Read-only check changed writing/image fixture");
      check(!attempts.length, "Read-only check attempted mutation"); return { attempts };
    }, scenario);
    if (scenario === "keyboard-ui") {
      await page.evaluate(async () => (await import("/src/state/store.ts")).setState({ assetsOpen: true })); const panel = page.getByRole("dialog", { name: "Images and links", exact: true }); await panel.waitFor();
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("ambertext:filesystem-changed", { detail: [] })));
      assert.equal(await page.evaluate(async () => (await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState().stale), false, "Diagnostics were outdated before any check");
      assert.doesNotMatch(await panel.getByRole("status").innerText(), /changed/i);
      const button = panel.getByRole("button", { name: "Check images and links" }); await button.focus(); await page.keyboard.press("Space");
      await until(page, async () => { const s = (await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState(); return !s.busy && s.coverage.scanned === 2; });
      assert.match(await panel.innerText(), /1 missing, 1 file used in more than one document/);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("ambertext:filesystem-changed", { detail: [] })));
      assert.match(await panel.getByRole("status").innerText(), /changed/i);
      const observed = await page.evaluate(async () => ({ attempts: window.fixtureAttempts, error: (await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState().error }));
      assert.equal(observed.error, null); assert.deepEqual(observed.attempts, []);
      if (process.env.AMBERTEXT_SCREENSHOT) await page.screenshot({ path: process.env.AMBERTEXT_SCREENSHOT });
    }
    assert.deepEqual(result.attempts, []); assert.deepEqual(errors, []); assert.deepEqual(network, []); console.log("PASS " + scenario);
  } finally { await context.close(); }
} } finally { await browser.close(); }
