// Disposable headless editor/controller proof; native IO and journals tested separately.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1429";
async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail("Replacement fixture timed out waiting for the awaited state");
}
const scenarios = ["closed-apply", "selection-only", "active-undo", "parked-undo", "dirty-baseline", "autosave", "checkpoint-failure",
  "checkpoint-edit", "checkpoint-disk", "receipt-before-failure", "receipt-after-failure", "cancel-next", "write-failure", "partial-skip",
  "later-disk-revert", "later-buffer-revert", "closed-revert", "active-revert-undo", "parked-revert-undo", "closed-open-dirty-revert",
  "revert-race", "history-off", "format-review", "competing-tabs", "root-during", "recover-drafts", "release-protection", "receipt-corrupt",
  "inspect-interrupted", "receipt-reload", "ui-confirm-cancel", "ui-confirm-apply", "release-before-failure", "release-midway-failure", "release-final-failure", "checkpoint-links-interrupted", "inspect-format-changed", "inspect-history-corrupt", "final-open-race", "final-competing-race"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
try { for (const scenario of scenarios.filter(s => !process.env.AMBERTEXT_SCENARIO || s === process.env.AMBERTEXT_SCENARIO)) {
  const context = await browser.newContext(), errors = [], network = [];
  try {
    await context.route("**/*", r => { const target = new URL(r.request().url()); if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return r.abort(); } return r.continue(); });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    await page.goto(url); await page.waitForSelector(".cm-content");
    const result = await page.evaluate(async scenario => {
      const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts");
      const w = await import("/src/lib/workspaceSearch.ts"), r = await import("/src/lib/workspaceReplacement.ts"), b = await import("/src/lib/workspaceBatch.ts");
      const h = (await import("/src/lib/history.ts")).historyApi, receipts = (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi;
      const bridge = (await import("/src/editor/bridge.ts")).bridge;
      // Resolve the editor's transformed import, including Vite's module version.
      // Importing the unversioned URL creates a second history field and cannot
      // see the real editor's Undo stack.
      const editorModule = await (await fetch("/src/editor/Editor.tsx")).text();
      const commandsUrl = editorModule.match(/from "([^"]*@codemirror_commands[^"]*)"/)[1];
      const commands = await import(commandsUrl);
      const check = (v, m) => { if (!v) throw new Error(m); }, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async fn => { for (let n = 0; n < 300 && !fn(); n++) await wait(10); check(fn(), "Expected fixture state"); };
      const root = "/Users/you/Notes/batch-" + scenario, first = root + "/A.md", second = root + "/B.md";
      const original = "🙂 e\u0301 needle\nneedle end", after = "🙂 e\u0301 revised\nrevised end";
      s.getState().setSettings({ autosave: false, historyEnabled: false });
      await p.fsApi.createFile(first, original); await p.fsApi.createFile(second, "Other needle"); await a.openFolder(root);
      if (scenario.startsWith("ui-confirm-")) { s.getState().setSettings({ sidebarOpen: true, sidebarTab: "search", historyEnabled: true }); return { first, original, after }; }
      let docId;
      const openCases = ["active-undo", "parked-undo", "dirty-baseline", "autosave", "checkpoint-edit", "later-buffer-revert", "active-revert-undo", "parked-revert-undo", "competing-tabs", "final-competing-race"];
      if (openCases.includes(scenario)) {
        docId = await a.openPath(first); await until(() => bridge.viewDocId === docId);
        if (scenario === "dirty-baseline") { bridge.view.dispatch({ changes: { from: bridge.view.state.doc.length, insert: " unsaved" } }); }
        if (scenario.includes("parked")) { const other = await a.openPath(second); await until(() => bridge.viewDocId === other); }
      }
      s.getState().setSettings({ historyEnabled: scenario !== "history-off", autosave: scenario === "autosave" });
      w.useWorkspaceSearch.setState({ query: "needle", options: { caseSensitive: true, wholeWord: false } }); await w.runWorkspaceSearch();
      r.setReplacement("revised"); check(await r.previewWorkspaceReplacement(), "Preview missing: " + JSON.stringify({ search: w.useWorkspaceSearch.getState(), replacement: r.useWorkspaceReplacement.getState() }));
      r.selectReplacement(first, true);
      if (["cancel-next", "write-failure", "partial-skip", "receipt-after-failure", "root-during", "release-midway-failure"].includes(scenario)) r.selectReplacement(second, true);
      const diskBefore = await p.fsApi.readText(first);
      const doc = () => s.getState().docs.find(d => d.id === docId);
      const realCapture = h.capture, realWrite = p.fsApi.writeText, realReceipt = receipts.write;
      let originalAttempts = 0;
      p.fsApi.writeText = async (...args) => { originalAttempts++; return realWrite(...args); };
      if (scenario === "checkpoint-failure") h.capture = async () => { throw new Error("Injected checkpoint failure"); };
      if (scenario === "checkpoint-edit") { let changed = false; h.capture = async request => { const value = await realCapture(request); if (!changed) { changed = true; bridge.view.dispatch({ changes: { from: bridge.view.state.doc.length, insert: " later" } }); } return value; }; }
      if (scenario === "checkpoint-disk") { let changed = false; h.capture = async request => { const value = await realCapture(request); if (!changed) { changed = true; await realWrite(first, "external later writing", diskBefore.revision); } return value; }; }
      if (scenario === "receipt-before-failure") receipts.write = async () => { throw new Error("Injected receipt failure"); };
      if (scenario === "receipt-after-failure") receipts.write = async (receipt, expected) => { if (receipt.files[0].state === "applied") throw new Error("Injected post-apply receipt failure"); return realReceipt(receipt, expected); };
      if (scenario === "cancel-next") p.fsApi.writeText = async (...args) => { originalAttempts++; const value = await realWrite(...args); b.stopWorkspaceBatch(); return value; };
      if (scenario === "write-failure") p.fsApi.writeText = async () => { originalAttempts++; throw new Error("Injected native write failure; outcome uncertain"); };
      if (scenario === "partial-skip") { let changed = false; receipts.write = async (receipt, expected) => { const value = await realReceipt(receipt, expected); if (!changed) { changed = true; await realWrite(first, "External untouched", diskBefore.revision); } return value; }; }
      if (scenario === "format-review") { const read = p.fsApi.readText; p.fsApi.readText = async path => { const file = await read(path); return path === first ? { ...file, format: { ...file.format, eol: "mixed" } } : file; }; r.clearReplacementReview(); await w.runWorkspaceSearch(); check(await r.previewWorkspaceReplacement(), "Mixed source preview missing"); r.selectReplacement(first, true); }
      if (scenario === "competing-tabs") s.setState(state => ({ docs: [...state.docs, { ...doc(), id: crypto.randomUUID(), content: "competing writing" }] }));
      if (scenario === "root-during") { let changed = false; p.fsApi.writeText = async (...args) => { const value = await realWrite(...args); if (!changed) { changed = true; await a.openFolder("/Users/you/Notes"); } return value; }; }
      if (["final-open-race", "final-competing-race"].includes(scenario)) {
        const digest = crypto.subtle.digest.bind(crypto.subtle); let changed = false;
        crypto.subtle.digest = async (algorithm, data) => {
          const value = await digest(algorithm, data);
          if (!changed && new TextDecoder().decode(data) === after && b.useWorkspaceBatch.getState().records[0]?.receipt.files[0].state === "applying") {
            changed = true;
            if (scenario === "final-open-race") await a.openPath(first);
            else s.setState(state => ({ docs: [...state.docs, { ...doc(), id: crypto.randomUUID(), content: "Competing later writing" }] }));
          }
          return value;
        };
      }
      const applied = await b.applyWorkspaceReplacement();
      h.capture = realCapture; receipts.write = realReceipt; p.fsApi.writeText = realWrite;
      const catalogue = await receipts.catalogue(), record = catalogue.records[0], file = record?.receipt.files[0];
      if (["history-off", "receipt-before-failure", "competing-tabs"].includes(scenario)) {
        const disk = await p.fsApi.readText(first);
        check(!applied && originalAttempts === 0 && disk.content === original, "Blocked operation changed writing: " + JSON.stringify({ scenario, applied, originalAttempts, disk: disk.content, batch: b.useWorkspaceBatch.getState() })); return {};
      }
      check(record && file, "Recoverable receipt missing");
      if (["checkpoint-failure", "checkpoint-edit", "checkpoint-disk", "format-review", "final-open-race", "final-competing-race"].includes(scenario)) {
        check(!applied && file.state === "skipped" && originalAttempts === 0, "Unverified checkpoint/source was applied");
        if (scenario === "checkpoint-edit") check(doc().content.endsWith(" later") && !doc().content.includes("revised"), "Concurrent buffer edit overwritten");
        if (scenario === "checkpoint-disk") check((await p.fsApi.readText(first)).content === "external later writing", "Concurrent disk edit overwritten");
        return {};
      }
      if (scenario === "write-failure") { check(!applied && file.state === "applying" && record.receipt.files[1].state === "skipped" && originalAttempts === 1, "Uncertain write did not stop before next file"); check((await p.fsApi.readText(first)).content === original, "Injected failure changed original"); return {}; }
      if (scenario === "receipt-after-failure") {
        check(!applied && file.state === "applying" && (await p.fsApi.readText(first)).content === after && (await p.fsApi.readText(second)).content === "Other needle", "Receipt failure hid change or continued");
        check(await b.inspectReplacementReceipt(record.receipt.id), "Interrupted outcome could not be inspected");
        const inspected = (await receipts.catalogue()).records[0]; check(inspected.receipt.files[0].state === "applied" && inspected.receipt.files[1].state === "skipped", "Inspection did not reconcile exact sources"); return {};
      }
      if (scenario === "partial-skip") { check(file.state === "skipped" && record.receipt.files[1].state === "applied", "Independent unchanged file did not proceed"); check((await p.fsApi.readText(first)).content === "External untouched" && (await p.fsApi.readText(second)).content === "Other revised", "Partial result overwrote later writing"); return {}; }
      if (["cancel-next", "root-during"].includes(scenario)) { check(record.receipt.state === "stopped" && file.state === "applied" && record.receipt.files[1].state === "skipped", "Stop did not retain first/skip next"); check((await p.fsApi.readText(second)).content === "Other needle", "Stopped file was changed"); return {}; }
      check(applied && file.state === "applied" && file.beforeSequence && file.afterSequence && file.diskSequence, "Applied outcome lacks protected original/result links");
      if (scenario.startsWith("release-") && scenario !== "release-protection") {
        const realRelease = h.release; let released = 0;
        h.release = async (...args) => { if (scenario === "release-midway-failure" && released === 1) throw new Error("Injected second release failure"); await realRelease(...args); released++; };
        receipts.write = async (receipt, expected) => { if ((scenario === "release-before-failure" && receipt.state === "releasing") || (scenario === "release-final-failure" && receipt.state === "released")) throw new Error("Injected release journal failure"); return realReceipt(receipt, expected); };
        check(!await b.releaseReplacementReceipt(record.receipt.id), "Release fault was hidden");
        const retained = (await receipts.catalogue()).records[0];
        if (scenario === "release-before-failure") check(released === 0 && retained.receipt.state === "complete", "Copies unprotected before durable release intent");
        else {
          check(retained.receipt.state === "releasing", "Interrupted release still claimed protected copies");
          check(!await b.revertReplacementFile(record.receipt.id, 0), "Partially released operation offered revert");
          check(!await b.inspectReplacementReceipt(record.receipt.id), "Inspection undid durable release intent");
        }
        h.release = realRelease; receipts.write = realReceipt;
        check(await b.releaseReplacementReceipt(record.receipt.id), "Interrupted release could not retry");
        check((await receipts.catalogue()).records[0].receipt.state === "released", "Release retry did not finish journal");
        await h.removeAll(); check((await p.fsApi.readText(first)).content === after, "Release changed canonical writing"); return {};
      }
      check((await h.read(file.documentId, file.beforeSequence)).content === (scenario === "dirty-baseline" ? original + " unsaved" : original), "Protected original mismatch");
      check((await h.read(file.documentId, file.afterSequence)).content === (scenario === "dirty-baseline" ? after + " unsaved" : after), "Protected reviewed result mismatch");
      check((await p.fsApi.readText(second)).content === "Other needle", "Unselected source changed");
      if (docId) {
        check(doc().content === (scenario === "dirty-baseline" ? after + " unsaved" : after) && doc().savedContent === original, "Open baseline changed");
        if (scenario !== "autosave") check((await p.fsApi.readText(first)).content === original, "Manual-save tab was silently written");
      } else check((await p.fsApi.readText(first)).content === after, "Closed source did not save exact review");
      if (["active-undo", "parked-undo"].includes(scenario)) {
        a.activate(docId); await until(() => bridge.viewDocId === docId);
        check(commands.undo(bridge.view), "Replacement has no Undo step"); check(doc().content === original, "Undo did not restore exact original");
        check(commands.redo(bridge.view) && doc().content === after, "Redo lost reviewed text"); return {};
      }
      if (scenario === "autosave") { await until(() => doc().savedContent === after); check((await p.fsApi.readText(first)).content === after, "Replacement did not follow enabled autosave"); check((await h.read(file.documentId, file.diskSequence)).content === original, "Autosave lost protected disk baseline"); return {}; }
      if (scenario === "later-disk-revert") { await realWrite(first, "Later external writing", (await p.fsApi.readText(first)).revision); check(!await b.revertReplacementFile(record.receipt.id, 0) && (await p.fsApi.readText(first)).content === "Later external writing", "Revert overwrote later disk work"); return {}; }
      if (scenario === "later-buffer-revert") { bridge.view.dispatch({ changes: { from: bridge.view.state.doc.length, insert: " later" } }); check(!await b.revertReplacementFile(record.receipt.id, 0) && doc().content === after + " later", "Revert overwrote later buffer work"); return {}; }
      if (scenario === "closed-open-dirty-revert") { docId = await a.openPath(first); await until(() => bridge.viewDocId === docId); bridge.view.dispatch({ changes: { from: bridge.view.state.doc.length, insert: " later" } }); check(!await b.revertReplacementFile(record.receipt.id, 0) && doc().content.endsWith(" later"), "Closed-file revert overwrote new dirty tab"); return {}; }
      if (scenario === "revert-race") { receipts.write = async (receipt, expected) => { const value = await realReceipt(receipt, expected); if (receipt.files[0].state === "reverting") await realWrite(first, "Writing during revert", (await p.fsApi.readText(first)).revision); return value; }; check(!await b.revertReplacementFile(record.receipt.id, 0) && (await p.fsApi.readText(first)).content === "Writing during revert", "Revert raced past final guard"); return {}; }
      if (["closed-revert", "active-revert-undo", "parked-revert-undo"].includes(scenario)) {
        check(await b.revertReplacementFile(record.receipt.id, 0), "Unchanged source could not revert");
        if (docId) { a.activate(docId); await until(() => bridge.viewDocId === docId); check(doc().content === original, "Tab revert mismatch"); check(commands.undo(bridge.view) && doc().content === after, "Revert has no coherent Undo"); }
        else check((await p.fsApi.readText(first)).content === original, "Conditional closed revert mismatch"); return {};
      }
      if (scenario === "recover-drafts") { const originalId = await b.recoverReplacementOriginal(file), resultId = await b.recoverReplacementResult(file); check(s.getState().docs.find(d => d.id === originalId).content === original && s.getState().docs.find(d => d.id === resultId).content === after, "Draft recovery lost protected text"); check((await p.fsApi.readText(first)).content === after, "Recover draft changed current file"); return {}; }
      if (scenario === "release-protection") { check(!await h.removeAll().then(() => true, () => false), "Protected originals could be removed"); check(await b.releaseReplacementReceipt(record.receipt.id), "Explicit release failed"); check(!await b.revertReplacementFile(record.receipt.id, 0), "Released operation could still revert"); check(await h.removeAll().then(() => true, () => false), "Release did not unblock ordinary removal"); return {}; }
      if (scenario === "receipt-corrupt") { const key = "ambertext:replacement-receipt:" + record.receipt.id; localStorage.setItem(key, "corrupt"); const raw = localStorage.getItem(key); check((await receipts.catalogue()).warnings.length, "Corrupt receipt hidden"); check(!await receipts.write(record.receipt, record.revision).then(() => true, () => false) && localStorage.getItem(key) === raw, "Corrupt source overwritten"); return {}; }
      if (scenario === "inspect-interrupted") { const interrupted = structuredClone(record.receipt); interrupted.state = "running"; interrupted.files[0].state = "applying"; await receipts.write(interrupted, record.revision); check(await b.inspectReplacementReceipt(record.receipt.id), "Interrupted inspection failed"); check((await receipts.catalogue()).records[0].receipt.files[0].state === "applied" && (await p.fsApi.readText(first)).content === after, "Inspection mutated source or missed result"); return {}; }
      if (["inspect-format-changed", "inspect-history-corrupt"].includes(scenario)) {
        const interrupted = structuredClone(record.receipt); interrupted.state = "running"; interrupted.files[0].state = "applying"; await receipts.write(interrupted, record.revision);
        if (scenario === "inspect-format-changed") { const read = p.fsApi.readText; p.fsApi.readText = async path => { const value = await read(path); return path === first ? { ...value, format: { ...value.format, bom: !value.format.bom } } : value; }; }
        else localStorage.setItem("ambertext:history:" + file.documentId, "damaged retained history");
        const inspected = await b.inspectReplacementReceipt(record.receipt.id);
        const retained = (await receipts.catalogue()).records[0];
        check(retained.receipt.files[0].state === "applying" && retained.receipt.files[0].afterRevision.sha256 === file.afterRevision.sha256, "Inspection blessed later format or damaged history");
        if (scenario === "inspect-history-corrupt") check(!inspected && b.useWorkspaceBatch.getState().error && localStorage.getItem("ambertext:history:" + file.documentId) === "damaged retained history", "History corruption was hidden or overwritten");
        check((await p.fsApi.readText(first)).content === after, "Inspection changed canonical writing"); return {};
      }
      if (scenario === "checkpoint-links-interrupted") { const interrupted = structuredClone(record.receipt); interrupted.state = "running"; Object.assign(interrupted.files[0], { state: "applying", diskSequence: null, beforeSequence: null, afterSequence: null }); await receipts.write(interrupted, record.revision); check(await b.inspectReplacementReceipt(record.receipt.id), "Interrupted checkpoint links could not be inspected"); const restored = (await receipts.catalogue()).records[0].receipt.files[0]; check(restored.diskSequence === file.diskSequence && restored.beforeSequence === file.beforeSequence && restored.afterSequence === file.afterSequence && restored.state === "applied", "Durable checkpoint pins did not recover missing receipt links"); check((await p.fsApi.readText(first)).content === after, "Link inspection changed writing"); return {}; }
      return { id: record.receipt.id };
    }, scenario);
    if (scenario === "receipt-reload") {
      await page.reload(); await page.waitForSelector(".cm-content");
      const retained = await page.evaluate(async id => { const api = (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi; const record = (await api.catalogue()).records.find(r => r.receipt.id === id); const h = (await import("/src/lib/history.ts")).historyApi; return !!record && (await h.read(record.receipt.files[0].documentId, record.receipt.files[0].beforeSequence)).content.includes("needle"); }, result.id);
      assert.equal(retained, true, "Receipt/checkpoint links did not survive frontend reload");
    }
    if (scenario.startsWith("ui-confirm-")) {
      await page.getByLabel("Find in folder").fill("needle");
      await page.getByLabel("Replace with").fill("revised");
      await page.getByRole("button", { name: "Preview changes", exact: true }).click();
      await page.getByRole("checkbox", { name: "A.md — 2 changes", exact: true }).check();
      await page.locator(".workspace-replacement").getByRole("button", { name: "Replace in selected files…" }).click();
      const dialog = page.getByRole("alertdialog", { name: "Replace in 1 file?" }); await dialog.waitFor();
      assert.match(await dialog.innerText(), /This makes 2 changes/);
      const before = await page.evaluate(async path => (await (await import("/src/lib/platform.ts")).fsApi.readText(path)).content, result.first);
      assert.equal(before, result.original, "Confirmation changed writing before consent");
      await dialog.getByRole("button", { name: scenario === "ui-confirm-cancel" ? "Cancel" : "Replace", exact: true }).click();
      if (scenario === "ui-confirm-apply") await until(() => page.evaluate(async () => (await (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi.catalogue()).records[0]?.receipt.state === "complete"));
      const text = await page.evaluate(async path => (await (await import("/src/lib/platform.ts")).fsApi.readText(path)).content, result.first);
      assert.equal(text, scenario === "ui-confirm-cancel" ? result.original : result.after);
    }
    assert.deepEqual(errors, []); assert.deepEqual(network, []); console.log("PASS " + scenario);
  } finally { await context.close(); }
} } finally { await browser.close(); }
