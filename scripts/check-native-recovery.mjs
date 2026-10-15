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
try {
  const firstPid = await launch();
  // Exercise both ready reveal and delayed startup fallback before writing.
  await page.evaluate(async () => (await import("/src/lib/platform.ts")).win.show());
  await pause(3500); await assertInvisible(); passed("invisible-native-startup-ready-and-fallback");
  await page.evaluate(async ({ documentPath, deletedPath }) => {
    const a = await import("/src/state/actions.ts"); const s = await import("/src/state/store.ts"); const r = await import("/src/lib/recovery.ts");
    const id = await a.openPath(documentPath); a.updateContent(id, "Unsaved before crash שלום 🙂\nSecond line");
    const draft = a.newDoc("Untitled before crash مرحبا", "Native crash draft");
    const deleted = await a.openPath(deletedPath); a.updateContent(deleted, "Unsaved writing from a deleted file");
    if (!await a.flushRecovery()) throw new Error("Native recovery did not verify");
    const loaded = await r.recoveryApi.load();
    if (!loaded.snapshot.docs.some(d => d.id === id && d.savedContent === "First saved line\nSecond æ line" && d.format.bom && d.format.eol === "\r\n")) throw new Error("Native journal lost baseline/format");
    window.fixtureIds = { id, draft, deleted };
  }, { documentPath, deletedPath });
  const ids = await page.evaluate(() => window.fixtureIds);
  const journal = JSON.parse(await readFile(path.join(profile, "recovery/current.json"), "utf8"));
  assert(journal.snapshot.docs.some(d => d.id === ids.draft && d.content === "Untitled before crash مرحبا"));
  await killOwned();
  await unlink(deletedPath); // Only this harness-created disposable document is removed.
  // Disk now diverges while the disposable app is stopped.
  await writeFile(documentPath, Buffer.from("\ufeffExternal disk edit\r\nDifferent second line", "utf8"));
  const secondPid = await launch();
  await page.evaluate(async ({ ids, documentPath }) => {
    const s = await import("/src/state/store.ts"); const a = await import("/src/state/actions.ts"); const p = await import("/src/lib/platform.ts");
    const d = s.getState().docs.find(d => d.id === ids.id);
    if (!d?.conflict || d.content !== "Unsaved before crash שלום 🙂\nSecond line") throw new Error("Native restart did not preserve conflicting recovered writing");
    if (!s.getState().docs.some(d => d.recoveryReason === "disk-version" && d.content === "External disk edit\nDifferent second line")) throw new Error("Native restart lost disk version");
    if (!s.getState().docs.some(d => d.id === ids.draft && d.content === "Untitled before crash مرحبا")) throw new Error("Native restart lost untitled identity/text");
    const missing = s.getState().docs.find(d => d.id === ids.deleted);
    if (!missing || missing.path !== null || missing.content !== "Unsaved writing from a deleted file" || !missing.originalPath.endsWith("deleted-fixture.md")) throw new Error("Native restart failed to keep missing-file writing as a draft");
    if (await a.saveDoc(d.id, { auto: true })) throw new Error("Native recovery autosaved a conflict");
    if ((await p.fsApi.readText(documentPath)).content !== "External disk edit\r\nDifferent second line") throw new Error("Native recovery changed disk bytes");
  }, { ids, documentPath });
  await assert.rejects(readFile(deletedPath), { code: "ENOENT" });
  passed("forced-app-termination-restart-divergence-untitled-missing-file", { ownedPids: [firstPid, secondPid] });
  // Resolve through the real dialog controls and native writer.
  await page.evaluate(async ids => {
    const a = await import("/src/state/actions.ts"); window.fixtureSave = a.saveDoc(ids.id);
  }, ids);
  await page.getByRole("button", { name: "Save mine", exact: true }).click();
  assert(await page.evaluate(() => window.fixtureSave));
  assert.equal(await readFile(documentPath, "utf8"), "\ufeffUnsaved before crash שלום 🙂\r\nSecond line");
  passed("reviewed-conflict-native-bom-crlf-character-save");
  // Real legacy byte interpretation and an unrepresentable Unicode edit.
  const legacyPath = path.join(files, "legacy-characters.md");
  await writeFile(legacyPath, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x80]));
  await page.evaluate(async legacyPath => {
    const a = await import("/src/state/actions.ts"); window.legacyId = await a.openPath(legacyPath);
    a.updateContent(window.legacyId, "café\n€ 🙂"); window.legacySave = a.saveDoc(window.legacyId);
  }, legacyPath);
  await page.getByRole("button", { name: "Keep Windows-1252", exact: true }).click();
  await page.getByRole("button", { name: "Convert to UTF-8", exact: true }).click();
  assert(await page.evaluate(() => window.legacySave));
  assert.equal(await readFile(legacyPath, "utf8"), "café\r\n€ 🙂");
  passed("native-windows1252-explicit-unrepresentable-conversion");
  // Exact legacy localStorage source is retained across repeated app restart.
  const source = JSON.stringify({ docs: [{ id: "native-legacy", name: "Old draft", content: "Legacy draft writing" }], activeId: "native-legacy", root: null });
  const hash = await page.evaluate(async source => {
    const r = await import("/src/lib/recovery.ts"); const one = await r.recoveryApi.preserveLegacy(source); const two = await r.recoveryApi.preserveLegacy(source);
    if (one !== two) throw new Error("Native legacy import is not idempotent"); return one;
  }, source);
  assert.equal(await readFile(path.join(profile, "recovery", `legacy-${hash}.json`), "utf8"), source);
  passed("native-legacy-source-idempotence", { limitation: "Disposable source preservation, not old/new installed-identifier migration" });
  const destination = path.join(files, "readonly-destination.md"); await writeFile(destination, "Existing destination bytes");
  await chmod(destination, 0o444);
  try {
    await page.evaluate(async destination => {
      const a = await import("/src/state/actions.ts"); const s = await import("/src/state/store.ts"); const p = await import("/src/lib/platform.ts");
      const other = await a.openPath(destination); a.updateContent(other, "Other unsaved writing");
      const source = a.newDoc("Source unsaved writing", "Native Save As fixture");
      s.setState({ goals: { ["draft:" + source]: 1234 } });
      p.dialogs.saveFile = async () => destination; // Selection only is stubbed; replacement/write is native.
      window.nativeCopyFixture = { other, source, destination };
      window.nativeCopySave = a.saveDocAs(source);
    }, destination);
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    assert(!await page.evaluate(() => window.nativeCopySave));
    await page.evaluate(async () => {
      const s = await import("/src/state/store.ts"); const { other, source, destination } = window.nativeCopyFixture;
      if (s.getState().docs.find(d => d.id === source)?.path !== null || s.getState().goals["draft:" + source] !== 1234) throw new Error("Native Save As failure committed associations");
      if (s.getState().docs.find(d => d.id === other)?.content !== "Other unsaved writing") throw new Error("Native Save As failure lost the destination tab");
      if (!s.getState().docs.some(d => d.recoveryReason === "before-replacement" && d.originalPath === destination && d.content === "Existing destination bytes")) throw new Error("Native replacement failed to checkpoint destination");
    });
    assert.equal(await readFile(destination, "utf8"), "Existing destination bytes");
    passed("native-readonly-Save-As-rollback-preserves-destination-tab-goal", { limitation: "File-picker selection stubbed; app confirmation and native write are real" });
  } finally { await chmod(destination, 0o666); }
  await page.evaluate(async () => {
    const a = await import("/src/state/actions.ts"); window.nativeCopySave = a.saveDocAs(window.nativeCopyFixture.source);
  });
  await page.getByRole("button", { name: "Replace", exact: true }).click();
  assert(await page.evaluate(() => window.nativeCopySave));
  assert.equal(await readFile(destination, "utf8"), "Source unsaved writing");
  await page.evaluate(async () => {
    const s = await import("/src/state/store.ts"); const { other, source, destination } = window.nativeCopyFixture;
    if (s.getState().docs.find(d => d.id === other)?.content !== "Other unsaved writing" || !s.getState().docs.find(d => d.id === other)?.conflict) throw new Error("Successful native replacement lost dirty destination tab");
    const copy = s.getState().docs.find(d => d.path === destination && d.id !== other);
    if (!copy || copy.id === source || s.getState().goals[destination] !== 1234) throw new Error("Successful native Save As did not commit distinct copy identity/goal");
  });
  passed("native-Save-As-success-keeps-other-dirty-buffer", { limitation: "File-picker selection stubbed" });
  // The actual native close request must await recovery and exit without harness termination.
  await page.evaluate(async () => (await import("/src/lib/platform.ts")).win.close());
  const closeUntil = Date.now() + 8000;
  while (child.exitCode === null && Date.now() < closeUntil) await pause(50);
  assert.equal(child.exitCode, 0, "Verified native close did not exit normally");
  const closedJournal = JSON.parse(await readFile(path.join(profile, "recovery/current.json"), "utf8"));
  assert(closedJournal.snapshot.docs.some(d => d.content === "Other unsaved writing"), "Native close omitted dirty destination writing");
  await killOwned(); await launch();
  passed("actual-native-close-awaits-journal-normal-exit-restart");
  // Exercise actual boot import from the old localStorage key in a current-identifier
  // disposable profile. Preserve both earlier native slots in fixture archives first.
  await page.evaluate(async source => {
    const { FALLBACK_KEY } = await import("/src/lib/recovery.ts");
    localStorage.setItem("margin:session", source); localStorage.removeItem(FALLBACK_KEY);
  }, source);
  await killOwned();
  for (const name of ["current.json", "previous.json"]) {
    const from = path.resolve(profile, "recovery", name);
    const to = path.resolve(profile, "recovery", "verified-pre-migration-" + name);
    assert(from.startsWith(fixtureRoot + path.sep) && to.startsWith(fixtureRoot + path.sep), "Fixture archive left its root");
    const bytes = await readFile(from); await rename(from, to); assert.deepEqual(await readFile(to), bytes);
  }
  await launch();
  await page.evaluate(async ({ source, hash }) => {
    const s = await import("/src/state/store.ts"); const a = await import("/src/state/actions.ts"); const r = await import("/src/lib/recovery.ts");
    if (s.getState().docs.find(d => d.id === "native-legacy")?.content !== "Legacy draft writing") throw new Error("Native boot failed to import legacy localStorage");
    if (!await a.flushRecovery() || (await r.recoveryApi.load()).snapshot.legacySourceHash !== hash) throw new Error("Native import did not commit verified source fingerprint");
    if (localStorage.getItem("margin:session") !== source) throw new Error("Native import modified original legacy source");
  }, { source, hash });
  assert.equal(await readFile(path.join(profile, "recovery", `legacy-${hash}.json`), "utf8"), source);
  await killOwned(); await launch();
  await page.evaluate(async source => {
    const s = await import("/src/state/store.ts");
    if (s.getState().docs.filter(d => d.id === "native-legacy").length !== 1 || s.getState().docs.find(d => d.id === "native-legacy").content !== "Legacy draft writing") throw new Error("Repeated native migration duplicated or lost imported writing");
    if (localStorage.getItem("margin:session") !== source) throw new Error("Repeated migration changed legacy source");
  }, source);
  passed("native-boot-legacy-localStorage-import-repeated-restart", { limitation: "Current-identifier disposable profile, not old/new installed-identifier continuity" });
  // Corrupt one real native slot after stopping only the task-owned app.
  assert(await page.evaluate(async () => (await import("/src/state/actions.ts")).flushRecovery()));
  await killOwned();
  const corruptPath = path.join(profile, "recovery/current.json"); await writeFile(corruptPath, "{deliberately-corrupt-fixture");
  await launch();
  await page.getByRole("alert").filter({ hasText: "Recovery" }).first().waitFor();
  assert.equal(await readFile(corruptPath, "utf8"), "{deliberately-corrupt-fixture");
  assert(!await page.evaluate(async () => (await import("/src/state/actions.ts")).flushAll()));
  await page.evaluate(async () => (await import("/src/lib/platform.ts")).win.close());
  await pause(500);
  assert.equal(child.exitCode, null, "Failed native recovery allowed window close");
  assert(await page.locator(".cm-content").count(), "Failed recovery removed editable writing");
  passed("native-corrupt-journal-readable-fallback-visible-warning-close-refusal");
  await assertInvisible();
  await page.screenshot({ path: path.join(fixtureRoot, "native-recovery-warning.png") });
  await writeFile(path.join(fixtureRoot, "results.json"), JSON.stringify({ results, profile, executable: exe,
    executableSha256: createHash("sha256").update(executableBytes).digest("hex"), userAgent, windowChecks, pageErrors,
    limitation: "Separate Windows development app on local NTFS; installed migration, macOS, assistive technology, physical IME, hardware power loss and provider volumes remain unverified" }, null, 2));
} finally { await killOwned(); }
