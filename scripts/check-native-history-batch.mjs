// Windows WebView2 integration in an explicitly isolated invisible test app.
// Requires a separately built executable with the supplied TAURI_CONFIG compiled in.
// Never launches or terminates an installed editor; only the process spawned here is killed.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, chmod, unlink, rename } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const { chromium } = createRequire(import.meta.url)("playwright-core");
assert(process.env.AMBERTEXT_ALLOW_VISIBLE_NATIVE_FIXTURE !== "1", "Visible native fixtures are forbidden for this harness");
const configPath = process.env.AMBERTEXT_NATIVE_CONFIG;
assert(configPath, "Supply the disposable TAURI_CONFIG file; installed profiles are forbidden");
const config = JSON.parse(await readFile(configPath, "utf8"));
const fixtureRoot = path.dirname(path.resolve(configPath));
const profile = path.resolve(config.app.appDirectoriesOverride);
assert(profile.startsWith(fixtureRoot + path.sep), "Profile must be inside the fixture directory");
assert(config.app.windows.length === 1 && config.app.windows[0].visible === false && config.app.windows[0].focusable === false && config.app.windows[0].focus === false, "Fixture must stay invisible and cannot receive OS focus");
assert(config.identifier.startsWith("studio.ambertext.validation.hidden."), "Only debug-only hidden validation identifiers are permitted");
const exe = path.resolve(process.env.AMBERTEXT_NATIVE_EXE || "src-tauri/target/debug/AmberText.exe");
assert(exe.startsWith(fixtureRoot + path.sep), "Only a copied executable inside the disposable fixture root may launch");
const executableBytes = await readFile(exe);
assert(executableBytes.includes(Buffer.from(config.identifier)), "Executable lacks the disposable identifier");
assert(executableBytes.includes(Buffer.from("AMBERTEXT_HIDDEN_VALIDATION_V1")), "Executable lacks the invisible validation guard");
assert(executableBytes.includes(Buffer.from(profile)), "Executable lacks this compiled disposable profile; rebuild it with this TAURI_CONFIG before launch");
const endpoint = "http://127.0.0.1:9425";
try { await fetch(endpoint + "/json/version"); throw new Error("Debug endpoint already in use; will not attach to an existing app"); }
catch (error) { if (!error.cause) throw error; }
const files = path.join(fixtureRoot, "files"); await mkdir(files, { recursive: true });
await assert.rejects(readFile(path.join(profile, "recovery/current.json")), { code: "ENOENT" });
const documentPath = path.join(files, "copied-writing.md");
const deletedPath = path.join(files, "deleted-fixture.md");
await writeFile(documentPath, Buffer.from("\ufeffFirst saved line\r\nSecond æ line", "utf8"));
await writeFile(deletedPath, "Saved missing-file baseline");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page;
const results = [];
const windowChecks = [], pageErrors = [];
let userAgent;
function passed(scenario, detail = {}) { assert.deepEqual(pageErrors, [], "Native frontend errors"); const result = { surface: "Windows native Tauri/WebView2 + copied NTFS files", scenario, passed: true, ...detail }; results.push(result); console.log(JSON.stringify(result)); }
async function launch() {
  child = spawn(exe, [], { cwd: path.dirname(exe), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => { output = (output + data).slice(-12000); }); child.stderr.on("data", data => { output = (output + data).slice(-12000); });
  const until = Date.now() + 25000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error("Disposable native process exited: " + output);
    try { const targets = await (await fetch(endpoint + "/json/list")).json(); if (targets.some(t => t.type === "page")) break; } catch {}
    await pause(100);
  }
  browser = await chromium.connectOverCDP(endpoint);
  while (Date.now() < until) {
    page = browser.contexts()[0].pages().find(p => p.url().startsWith(config.build.devUrl));
    if (page) break;
    await pause(100);
  }
  assert(page, "Disposable app did not load the task-owned frontend: " + browser.contexts()[0].pages().map(p => p.url()).join(", "));
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.waitForSelector(".cm-content");
  await assertInvisible();
  const actualProfiles = await page.evaluate(async () => {
    const paths = await import("/node_modules/@tauri-apps/api/path.js");
    return [await paths.appLocalDataDir(), await paths.appDataDir()];
  });
  for (const actual of actualProfiles) assert.equal(path.resolve(actual), profile, "Native app directories are not isolated");
  userAgent = await page.evaluate(() => navigator.userAgent);
  await page.evaluate(async () => (await import("/src/state/store.ts")).getState().setSettings({ autosave: false, material: false }));
  return child.pid;
}
async function assertInvisible() {
  const state = await page.evaluate(async () => (await import("/node_modules/@tauri-apps/api/core.js")).invoke("hidden_validation_state"));
  assert.equal(state.guard, "AMBERTEXT_HIDDEN_VALIDATION_V1");
  assert.equal(state.identifier, config.identifier); assert.equal(state.pid, child.pid);
  assert.equal(state.visible, false, "Owned fixture unexpectedly became visible"); assert.equal(state.focused, false, "Owned fixture unexpectedly received focus");
  windowChecks.push(state);
}
async function killOwned() {
  const owned = child; child = null;
  if (owned && owned.exitCode === null) {
    const exited = new Promise(resolve => owned.once("exit", resolve));
    owned.kill(); await exited;
  }
  await browser?.close().catch(() => {}); browser = null;
  const until = Date.now() + 5000;
  while (Date.now() < until) { try { await fetch(endpoint + "/json/version"); await pause(100); } catch { return; } }
  throw new Error("Task-owned WebView2 endpoint did not stop");
}
// This deliberately reuses the recovery harness's reviewed launch guards.
// Every document below belongs to this fresh fixture, never to an installed app.
const check = (value, message) => { if (!value) throw new Error(message); };
// Playwright's page.waitForFunction tests a returned Promise as truthy; it does
// not await this fixture's dynamic imports/native IPC. Await each sample here.
async function until(predicate, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(50); }
  throw new Error("Timed out waiting for " + description);
}
const nativeRead = file => page.evaluate(async file => (await import("/src/lib/platform.ts")).fsApi.readText(file), file);
const originals = new Map();
const receiptsByCase = {};
async function setupBatch(scenario, { open = false, two = false } = {}) {
  const root = path.join(files, scenario); await mkdir(root);
  const first = path.join(root, "A.md"), second = path.join(root, "B.md");
  const original = "🙂 e\u0301 needle\nneedle end", after = "🙂 e\u0301 revised\nrevised end";
  const bytes = Buffer.from("\ufeff" + original.replaceAll("\n", "\r\n"));
  await writeFile(first, bytes); await writeFile(second, "Other needle"); originals.set(first, bytes);
  const prepared = await page.evaluate(async ({ root, first, second, open, two }) => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge;
    await a.openFolder(root); let docId = null;
    // openFolder deliberately selects Files. Choose Search afterwards and let
    // its actual mounted controls finish their debounced native search.
    s.getState().setSettings({ autosave: false, historyEnabled: true, sidebarOpen: true, sidebarTab: "search" });
    if (open) { docId = await a.openPath(first); for (let n = 0; n < 200 && bridge.viewDocId !== docId; n++) await new Promise(r => setTimeout(r, 10)); }
    return { docId };
  }, { root, first, second, open, two });
  await page.getByLabel("Find in folder").fill("needle");
  await page.getByRole("checkbox", { name: "Match case", exact: true }).check();
  await until(() => page.evaluate(async root => {
    const state = (await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState();
    return state.root === root && !state.busy && !state.stale && state.hits.length === 3;
  }, root), "completed native search for " + scenario);
  await page.getByLabel("Replace with").fill("revised");
  await page.getByRole("button", { name: "Preview changes", exact: true }).click();
  await page.getByRole("checkbox", { name: "A.md — 2 changes", exact: true }).check();
  if (two) await page.getByRole("checkbox", { name: "B.md — 1 replacements", exact: true }).check();
  return { scenario, root, first, second, original, after, ...prepared };
}
async function applyBatch(fixture, mode = "ordinary") {
  const outcome = await page.evaluate(async ({ mode }) => {
    const p = await import("/src/lib/platform.ts"), b = await import("/src/lib/workspaceBatch.ts");
    const receipts = (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi;
    const realWrite = p.fsApi.writeText; let attempts = 0;
    p.fsApi.writeText = async (...args) => { attempts++; const value = await realWrite(...args); if (mode === "cancel") b.stopWorkspaceBatch(); return value; };
    try {
      const applied = await b.applyWorkspaceReplacement();
      const record = (await receipts.catalogue()).records[0];
      return { applied, attempts, record, error: b.useWorkspaceBatch.getState().error };
    } finally { p.fsApi.writeText = realWrite; }
  }, { mode });
  check(outcome.record, "Native receipt missing: " + JSON.stringify(outcome));
  receiptsByCase[fixture.scenario] = outcome.record.receipt.id;
  return outcome;
}
async function undoRedo(id, before, after) {
  const result = await page.evaluate(async ({ id, before, after }) => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge;
    a.activate(id); for (let n = 0; n < 200 && bridge.viewDocId !== id; n++) await new Promise(r => setTimeout(r, 10));
    const source = await (await fetch("/src/editor/Editor.tsx")).text();
    const commands = await import(source.match(/from "([^"]*@codemirror_commands[^"]*)"/)[1]);
    const undone = commands.undo(bridge.view), undoText = s.getState().docs.find(d => d.id === id).content;
    const redone = commands.redo(bridge.view), redoText = s.getState().docs.find(d => d.id === id).content;
    return { undone, undoText, redone, redoText };
  }, { id, before, after });
  assert.deepEqual(result, { undone: true, undoText: before, redone: true, redoText: after });
}
try {
  const firstPid = await launch();
  await page.evaluate(async () => (await import("/src/lib/platform.ts")).win.show());
  await pause(3500); await assertInvisible(); passed("invisible-native-startup-ready-and-fallback");
  const history = await page.evaluate(async documentPath => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const h = (await import("/src/lib/history.ts")).historyApi;
    const bridge = (await import("/src/editor/bridge.ts")).bridge;
    s.getState().setSettings({ historyEnabled: true, autosave: false });
    const id = await a.openPath(documentPath), doc = () => s.getState().docs.find(d => d.id === id);
    for (let n = 0; n < 200 && bridge.viewDocId !== id; n++) await new Promise(r => setTimeout(r, 10));
    if (bridge.viewDocId !== id) throw new Error("History fixture editor did not activate");
    const first = await h.versions(id);
    const request = { documentId: id, name: doc().name, currentPath: doc().path, content: "Historical candidate שלום 🙂", diskRevision: null, format: doc().format, reason: "manual-save", operation: null };
    const one = await h.capture(request); for (let n = 0; n < 12; n++) await h.capture(request);
    const dedup = await h.versions(id);
    // Typing goes through the actual editor. updateContent alone updates the
    // store but intentionally cannot rewrite CodeMirror's active/parked state.
    bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "Current writing after candidate" } });
    if (doc().content !== bridge.view.state.doc.toString()) throw new Error("Native typing/store mismatch");
    const saved = await a.saveDoc(id);
    const manifest = await h.versions(id);
    s.setState({ historyOpen: id });
    return { id, first, one, dedup, saved, manifest, candidate: request.content };
  }, documentPath);
  check(history.saved, "Actual native manual save failed");
  check(history.first.entries[0].representation === "raw-disk", "Native opening checkpoint is not raw bytes");
  assert.equal(history.dedup.entries.length, history.one.entries.length);
  const rawEntry = history.first.entries[0];
  assert.deepEqual(await readFile(path.join(profile, "history/blobs", rawEntry.sha256 + ".bin")), Buffer.from("\ufeffFirst saved line\r\nSecond æ line"));
  passed("history-native-opening-raw-bom-crlf-manual-save-and-12-repeat-dedup");
  const panel = page.getByRole("dialog", { name: "Version history" }); await panel.waitFor();
  await panel.getByLabel("Version").selectOption(String(history.one.entries.at(-1).sequence));
  await page.waitForFunction(() => document.querySelector(".history-preview pre")?.textContent === "Historical candidate שלום 🙂");
  const beforePreview = await readFile(documentPath);
  for (const mode of ["Formatted", "Compare with now", "Source"]) await panel.getByRole("button", { name: mode, exact: true }).click();
  assert.deepEqual(await readFile(documentPath), beforePreview);
  await panel.getByRole("button", { name: "Open as new document", exact: true }).click();
  const draft = await page.evaluate(async id => {
    const s = await import("/src/state/store.ts"); return { original: s.getState().docs.find(d => d.id === id), draft: s.getState().docs.find(d => d.id === s.getState().activeId) };
  }, history.id);
  assert.equal(draft.draft.path, null); assert.equal(draft.draft.content, history.candidate);
  assert.equal(draft.original.content, "Current writing after candidate"); assert.deepEqual(await readFile(documentPath), beforePreview);
  passed("native-history-three-preview-modes-and-recover-as-draft-leave-current-file-unchanged");
  const restored = await page.evaluate(async ({ id, sequence }) => (await import("/src/state/actions.ts")).restoreHistoryVersion(id, sequence), { id: history.id, sequence: history.one.entries.at(-1).sequence });
  check(restored, "Native history restore failed");
  assert.equal((await nativeRead(documentPath)).content.replaceAll("\r\n", "\n"), history.candidate);
  await undoRedo(history.id, "Current writing after candidate", history.candidate);
  const checkpoints = await page.evaluate(async id => (await (await import("/src/lib/history.ts")).historyApi.versions(id)).entries.filter(e => e.reason === "before-restore"), history.id);
  check(checkpoints.some(e => e.representation === "raw-disk") && checkpoints.some(e => e.representation === "buffer-utf8"), "Restore omitted native before snapshots");
  passed("native-history-restore-protects-original-and-buffer-with-real-editor-undo-redo");
  check(await page.evaluate(async () => { const s = await import("/src/state/store.ts"); s.setState({ historyOpen: null }); return (await import("/src/state/actions.ts")).flushRecovery(); }), "Native restart recovery flush did not verify");
  const historyRecord = path.join(profile, "history/documents", history.id + ".json");
  const savedHistory = await readFile(historyRecord);
  await killOwned(); check(await launch() !== firstPid, "Restart reused process");
  const retained = await page.evaluate(async id => {
    const h = (await import("/src/lib/history.ts")).historyApi, s = await import("/src/state/store.ts");
    return { manifest: await h.versions(id), original: s.getState().docs.find(d => d.id === id), draft: s.getState().docs.find(d => d.content === "Historical candidate שלום 🙂" && !d.path) };
  }, history.id);
  assert.equal(retained.original.content, history.candidate); check(retained.draft, "Recovered history draft did not survive restart");
  // Startup can add a genuine opening milestone; all prior versions must survive.
  for (const entry of JSON.parse(savedHistory).manifest.entries) check(retained.manifest.entries.some(e => e.sequence === entry.sequence && e.sha256 === entry.sha256), "Restart lost a prior native history entry");
  passed("forced-owned-process-restart-retains-native-history-and-recovered-draft");
  const ui = await setupBatch("ui-closed");
  await page.locator(".workspace-replacement").getByRole("button", { name: "Replace in selected files…" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Replace in 1 file?" }); await dialog.waitFor();
  assert.match(await dialog.innerText(), /This makes 2 changes/);
  assert.deepEqual(await readFile(ui.first), originals.get(ui.first));
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await readFile(ui.first), originals.get(ui.first));
  await page.locator(".workspace-replacement").getByRole("button", { name: "Replace in selected files…" }).click();
  await dialog.getByRole("button", { name: "Replace", exact: true }).click();
  await until(() => page.evaluate(async () => {
    const b = await import("/src/lib/workspaceBatch.ts");
    const record = (await (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi.catalogue()).records[0];
    return !b.useWorkspaceBatch.getState().busy && record?.receipt.state === "complete";
  }), "durable native replacement completion");
  const uiRecord = await page.evaluate(async () => (await (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi.catalogue()).records[0]);
  receiptsByCase[ui.scenario] = uiRecord.receipt.id;
  check(uiRecord.receipt.files[0].state === "applied", "Native reviewed file not applied: " + JSON.stringify(uiRecord));
  assert.deepEqual(await readFile(ui.first), Buffer.from("\ufeff" + ui.after.replaceAll("\n", "\r\n")));
  assert.equal(await readFile(ui.second, "utf8"), "Other needle");
  check(uiRecord.receipt.files[0].diskSequence && uiRecord.receipt.files[0].beforeSequence && uiRecord.receipt.files[0].afterSequence, "Native review omitted checkpoint links");
  passed("native-review-confirmation-cancel-then-apply-exact-bom-crlf-selected-file-only");
  const active = await setupBatch("active-buffer", { open: true });
  const activeOutcome = await applyBatch(active); check(activeOutcome.applied, activeOutcome.error);
  assert.equal(activeOutcome.attempts, 0); assert.deepEqual(await readFile(active.first), originals.get(active.first));
  await undoRedo(active.docId, active.original, active.after);
  passed("native-open-buffer-apply-is-one-undo-step-and-does-not-silently-save");
  const cancelled = await setupBatch("cancel-between-files", { two: true });
  const cancelOutcome = await applyBatch(cancelled, "cancel");
  assert.equal(cancelOutcome.record.receipt.state, "stopped");
  assert.deepEqual(cancelOutcome.record.receipt.files.map(f => f.state), ["applied", "skipped"]);
  assert.equal(cancelOutcome.attempts, 1); assert.equal(await readFile(cancelled.second, "utf8"), "Other needle");
  passed("native-cancel-after-real-write-stops-before-next-file-and-keeps-receipt");
  const readonly = await setupBatch("readonly-destination", { two: true });
  await chmod(readonly.first, 0o444);
  let readonlyOutcome; try { readonlyOutcome = await applyBatch(readonly); } finally { await chmod(readonly.first, 0o666); }
  check(!readonlyOutcome.applied, "Read-only destination unexpectedly succeeded");
  assert.equal(readonlyOutcome.attempts, 1); assert.equal(readonlyOutcome.record.receipt.files[0].state, "applying");
  assert.equal(readonlyOutcome.record.receipt.files[1].state, "skipped");
  assert.deepEqual(await readFile(readonly.first), originals.get(readonly.first));
  assert.equal(await readFile(readonly.second, "utf8"), "Other needle");
  passed("actual-native-readonly-write-failure-preserves-bytes-and-stops-next-file", { message: readonlyOutcome.record.receipt.files[0].message });
  const interrupted = await setupBatch("interrupted-after-disk-write", { two: true });
  // Pause the frontend only after a real disk write, before the final receipt.
  // This is a controlled IPC boundary interruption, not hardware power loss.
  await page.evaluate(async () => {
    const p = await import("/src/lib/platform.ts"), b = await import("/src/lib/workspaceBatch.ts");
    const real = p.fsApi.writeText;
    p.fsApi.writeText = async (...args) => { const result = await real(...args); window.__nativeWriteCompleted = true; await new Promise(() => {}); return result; };
    void b.applyWorkspaceReplacement().catch(error => { window.__nativeBatchError = String(error); });
  });
  await page.waitForFunction(() => window.__nativeWriteCompleted === true || window.__nativeBatchError);
  check(!await page.evaluate(() => window.__nativeBatchError), "Interrupted batch failed before boundary");
  const applying = await page.evaluate(async () => (await (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi.catalogue()).records[0]);
  assert.equal(applying.receipt.files[0].state, "applying"); assert.equal(applying.receipt.files[1].state, "pending");
  const receiptPath = path.join(profile, "replacement-receipts", applying.receipt.id + ".json");
  const receiptBeforeRestart = await readFile(receiptPath);
  assert.deepEqual(await readFile(interrupted.first), Buffer.from("\ufeff" + interrupted.after.replaceAll("\n", "\r\n")));
  await assertInvisible(); await killOwned(); await launch();
  assert.deepEqual(await readFile(receiptPath), receiptBeforeRestart);
  const inspected = await page.evaluate(async id => {
    const b = await import("/src/lib/workspaceBatch.ts"), receipts = (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi;
    const success = await b.inspectReplacementReceipt(id); return { success, record: (await receipts.catalogue()).records.find(r => r.receipt.id === id), error: b.useWorkspaceBatch.getState().error };
  }, applying.receipt.id);
  check(inspected.success, inspected.error); assert.deepEqual(inspected.record.receipt.files.map(f => f.state), ["applied", "skipped"]);
  assert.equal(await readFile(interrupted.second, "utf8"), "Other needle");
  passed("owned-process-interruption-after-native-write-retains-journal-and-reconciles-on-restart");
  receiptsByCase[interrupted.scenario] = applying.receipt.id;
  const protectedFile = inspected.record.receipt.files[0];
  const copies = await page.evaluate(async file => {
    const b = await import("/src/lib/workspaceBatch.ts"), s = await import("/src/state/store.ts");
    const before = await b.recoverReplacementOriginal(file), after = await b.recoverReplacementResult(file);
    return { before: s.getState().docs.find(d => d.id === before), after: s.getState().docs.find(d => d.id === after) };
  }, protectedFile);
  assert.equal(copies.before.path, null); assert.equal(copies.before.content, interrupted.original);
  assert.equal(copies.after.path, null); assert.equal(copies.after.content, interrupted.after);
  assert.deepEqual(await readFile(interrupted.first), Buffer.from("\ufeff" + interrupted.after.replaceAll("\n", "\r\n")));
  passed("native-protected-original-and-reviewed-result-recover-as-separate-drafts-after-restart");
  const reverted = await page.evaluate(async id => (await import("/src/lib/workspaceBatch.ts")).revertReplacementFile(id, 0), applying.receipt.id);
  check(reverted, "Native conditional revert failed"); assert.deepEqual(await readFile(interrupted.first), originals.get(interrupted.first));
  passed("native-conditional-closed-revert-restores-exact-original-bom-crlf-bytes");
  await writeFile(ui.first, "Later external writing שלום");
  const refused = await page.evaluate(async id => (await import("/src/lib/workspaceBatch.ts")).revertReplacementFile(id, 0), uiRecord.receipt.id);
  assert.equal(refused, false); assert.equal(await readFile(ui.first, "utf8"), "Later external writing שלום");
  passed("native-revert-refuses-later-external-writing");
  const removal = await page.evaluate(async () => {
    const h = (await import("/src/lib/history.ts")).historyApi;
    const maintained = await h.maintain(); let error; try { await h.removeAll(); } catch (e) { error = e; }
    return { maintained, refused: !!error };
  });
  check(removal.refused, "Native protected checkpoints could be removed");
  check(removal.maintained.byteUsage > 0, "Native maintenance reported no history");
  passed("native-history-maintenance-preserves-protected-checkpoints-and-refuses-removal");
  const identityRoot = path.join(files, "identity"); await mkdir(identityRoot);
  const identityPath = path.join(identityRoot, "original.md"), renamedPath = path.join(identityRoot, "renamed.md");
  const copyPath = path.join(identityRoot, "copy.md"), movedPath = path.join(identityRoot, "moved.md");
  const identityBytes = Buffer.from("\ufeffOriginal identity\r\nSecond line");
  await writeFile(identityPath, identityBytes);
  const identity = await page.evaluate(async ({ identityPath, copyPath }) => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const h = (await import("/src/lib/history.ts")).historyApi, p = await import("/src/lib/platform.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge;
    const id = await a.openPath(identityPath);
    if (!await a.closeDoc(id)) throw new Error("Clean identity close failed");
    await a.renameEntry(identityPath, "renamed.md");
    const original = await h.versions(id);
    if (await a.openPath(original.currentPath) !== id) throw new Error("Native rename forked history");
    for (let n = 0; n < 200 && bridge.viewDocId !== id; n++) await new Promise(r => setTimeout(r, 10));
    bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "Copied writing שלום\nCopy second" } });
    const real = p.dialogs.saveFile; p.dialogs.saveFile = async () => copyPath;
    try { if (!await a.saveDocAs(id)) throw new Error("Native copy save failed"); } finally { p.dialogs.saveFile = real; }
    const copy = s.getState().docs.find(d => d.path === copyPath);
    if (!copy || copy.id === id) throw new Error("Native Save As shared original identity");
    const originalAfter = await h.versions(id), copied = await h.versions(copy.id);
    if (!await a.closeDoc(copy.id)) throw new Error("Clean copy close failed");
    return { id, original, originalAfter, copied, copyId: copy.id };
  }, { identityPath, copyPath });
  await assert.rejects(readFile(identityPath), { code: "ENOENT" });
  assert.deepEqual(await readFile(renamedPath), identityBytes);
  assert.equal(path.resolve(identity.originalAfter.currentPath), renamedPath);
  assert.equal(path.resolve(identity.copied.currentPath), copyPath);
  const copiedBytes = Buffer.from("\ufeffCopied writing שלום\r\nCopy second");
  assert.deepEqual(await readFile(copyPath), copiedBytes);
  passed("native-closed-rename-reuses-history-and-save-as-creates-distinct-copy-with-original-retained", { filePicker: "Stubbed destination; actual native save/history commands" });
  await rename(copyPath, movedPath);
  const moved = await page.evaluate(async ({ movedPath, copyId }) => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge, h = (await import("/src/lib/history.ts")).historyApi;
    const temporaryId = await a.openPath(movedPath);
    if (temporaryId === copyId) throw new Error("External movement was silently guessed");
    for (let n = 0; n < 200 && bridge.viewDocId !== temporaryId; n++) await new Promise(r => setTimeout(r, 10));
    bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "Moved unsaved writing" } });
    if (!await a.relinkHistory(copyId, temporaryId)) throw new Error("Native explicit relink failed");
    return { activeId: s.getState().activeId, temporary: await h.versions(temporaryId), connected: await h.versions(copyId) };
  }, { movedPath, copyId: identity.copyId });
  assert.equal(moved.activeId, identity.copyId); assert.equal(moved.temporary.currentPath, null);
  assert.equal(path.resolve(moved.connected.currentPath), movedPath); assert.deepEqual(await readFile(movedPath), copiedBytes);
  await undoRedo(identity.copyId, "Copied writing שלום\nCopy second", "Moved unsaved writing");
  passed("native-external-move-explicit-relink-keeps-unsaved-writing-undo-and-separate-history");
  const missingPath = path.join(identityRoot, "externally-deleted.md"); await writeFile(missingPath, "Saved before external delete");
  const missing = await page.evaluate(async missingPath => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const bridge = (await import("/src/editor/bridge.ts")).bridge, h = (await import("/src/lib/history.ts")).historyApi;
    const id = await a.openPath(missingPath); for (let n = 0; n < 200 && bridge.viewDocId !== id; n++) await new Promise(r => setTimeout(r, 10));
    bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "Unsaved before external deletion שלום" } });
    if (!await a.captureHistoryDoc(s.getState().docs.find(d => d.id === id), "close")) throw new Error("Native missing-file checkpoint failed");
    const version = (await h.versions(id)).entries.at(-1);
    window.__nativeMissingClose = a.closeDoc(id); return { id, sequence: version.sequence };
  }, missingPath);
  await page.getByRole("alertdialog").getByRole("button", { name: "Don't save", exact: true }).click();
  check(await page.evaluate(() => window.__nativeMissingClose), "Native discard close failed");
  check(missingPath.startsWith(files + path.sep), "External-deletion fixture escaped its directory"); await unlink(missingPath);
  const recoveredMissing = await page.evaluate(async ({ id, sequence }) => {
    const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
    const recovered = await a.recoverHistoryVersion(id, sequence); return s.getState().docs.find(d => d.id === recovered);
  }, missing);
  assert.equal(recoveredMissing.path, null); assert.equal(recoveredMissing.content, "Unsaved before external deletion שלום");
  await assert.rejects(readFile(missingPath), { code: "ENOENT" });
  passed("native-history-after-external-delete-recovers-unsaved-draft-without-recreating-file", { limitation: "External fixture deletion; does not exercise Windows Recycle Bin UI" });
  const failurePath = path.join(identityRoot, "history-failure.md"); await writeFile(failurePath, "Original storage-failure writing");
  const failureId = await page.evaluate(async failurePath => (await import("/src/state/actions.ts")).openPath(failurePath), failurePath);
  const failureManifest = path.join(profile, "history/documents", failureId + ".json");
  const retainedFailureManifest = await readFile(failureManifest); await chmod(failureManifest, 0o444);
  let failure;
  try {
    failure = await page.evaluate(async id => {
      const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts");
      const bridge = (await import("/src/editor/bridge.ts")).bridge;
      for (let n = 0; n < 200 && bridge.viewDocId !== id; n++) await new Promise(r => setTimeout(r, 10));
      bridge.view.dispatch({ changes: { from: 0, to: bridge.view.state.doc.length, insert: "Ordinary save despite history failure" } });
      const saved = await a.saveDoc(id), warned = !!s.getState().historyWarning;
      await a.maintainHistory(); const warningRetained = !!s.getState().historyWarning;
      const restored = await a.restoreHistoryVersion(id, 1);
      return { saved, warned, warningRetained, restored, current: s.getState().docs.find(d => d.id === id).content };
    }, failureId);
    assert.deepEqual(failure, { saved: true, warned: true, warningRetained: true, restored: false, current: "Ordinary save despite history failure" });
    assert.equal(await readFile(failurePath, "utf8"), failure.current); assert.deepEqual(await readFile(failureManifest), retainedFailureManifest);
  } finally { await chmod(failureManifest, 0o666); }
  passed("actual-native-readonly-history-manifest-allows-ordinary-save-but-blocks-required-restore");
  check(await page.evaluate(async () => (await import("/src/state/actions.ts")).retryHistory()), "Native history retry failed after restoring owned fixture permissions");
  check(!await page.evaluate(async () => (await import("/src/state/store.ts")).getState().historyWarning), "Verified native retry retained warning");
  passed("native-history-warning-clears-only-after-verified-retry");
  const agedId = "aged-retention-fixture";
  await page.evaluate(async documentId => {
    const h = (await import("/src/lib/history.ts")).historyApi;
    for (let n = 1; n <= 6; n++) await h.capture({ documentId, name: "Artificially aged disposable fixture", currentPath: null,
      content: "Retention version " + n, diskRevision: null, format: { encoding: "utf8", bom: false, eol: "\n", confirmed: true }, reason: "manual-save", operation: n === 1 ? "retention-pin" : null });
    const s = await import("/src/state/store.ts"); s.getState().setSettings({ historyEnabled: false });
    if (!await (await import("/src/state/actions.ts")).flushRecovery()) throw new Error("Aged fixture shutdown did not verify");
  }, agedId);
  await assertInvisible(); await killOwned();
  const agedPath = path.join(profile, "history/documents", agedId + ".json");
  const envelope = JSON.parse(await readFile(agedPath, "utf8")), day = 86400000, today = Math.floor(Date.now() / day) * day;
  const dates = [today - 180 * day, today - 180 * day + 1000, today - 30 * day + 3600000, today - 30 * day + 7200000, today - day, today - 180 * day];
  envelope.manifest.entries.forEach((entry, n) => { entry.capturedAt = dates[n]; });
  envelope.sha256 = createHash("sha256").update(JSON.stringify(envelope.manifest)).digest("hex");
  await writeFile(agedPath, JSON.stringify(envelope));
  const unchangedMarkdown = new Map(); for (const file of [documentPath, renamedPath, movedPath, failurePath]) unchangedMarkdown.set(file, await readFile(file));
  await launch();
  const retention = await page.evaluate(async id => {
    const s = await import("/src/state/store.ts"); s.getState().setSettings({ historyEnabled: true });
    const h = (await import("/src/lib/history.ts")).historyApi;
    const maintained = await h.maintain(); return { maintained, manifest: await h.versions(id) };
  }, agedId);
  assert.deepEqual(retention.manifest.entries.map(e => e.sequence), [1, 4, 5, 6]);
  check(retention.maintained.removedVersions >= 2, "Native age cleanup did not prune older unprotected entries");
  for (const [file, bytes] of unchangedMarkdown) assert.deepEqual(await readFile(file), bytes);
  for (const n of [2, 3]) await assert.rejects(readFile(path.join(profile, "history/blobs", envelope.manifest.entries[n - 1].sha256 + ".bin")), { code: "ENOENT" });
  passed("native-aged-retention-keeps-recent-daily-latest-and-pinned-versions-without-writing-markdown", { timing: "Artificially aged checksummed auxiliary manifest while owned app stopped; actual native maintenance after restart" });
  await assertInvisible();
  await page.screenshot({ path: path.join(fixtureRoot, "native-history-batch-final.png") });
  await writeFile(path.join(fixtureRoot, "results.json"), JSON.stringify({ results, profile, executable: exe,
    executableSha256: createHash("sha256").update(executableBytes).digest("hex"), userAgent, windowChecks, pageErrors, receiptsByCase,
    limitation: "Frozen S3 baseline in a separate invisible Windows development app on copied local NTFS documents; macOS, installed migration, screen readers, physical IME, aged/full-volume retention, provider volumes and hardware power loss remain unverified. Cancel/crash timing is deliberately controlled; actual disk/journal/checkpoints and restarts use native IPC." }, null, 2));
} catch (error) {
  let diagnostics;
  try { diagnostics = await page?.evaluate(async () => ({
    batch: (await import("/src/lib/workspaceBatch.ts")).useWorkspaceBatch.getState(),
    receipts: await (await import("/src/lib/replacementReceipts.ts")).replacementReceiptApi.catalogue(),
    search: (await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState(),
  })); } catch (captureError) { diagnostics = { captureError: String(captureError) }; }
  await writeFile(path.join(fixtureRoot, "failed-results.json"), JSON.stringify({ results, error: String(error), stack: error.stack, windowChecks, pageErrors, diagnostics }, null, 2));
  throw error;
} finally { await killOwned(); }
