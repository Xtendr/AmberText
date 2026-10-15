// Isolated frontend fixtures. Browser reload is not an installed-app migration test.
// Native byte/journal/process-termination checks are in Rust; native-close below uses a mocked IPC boundary.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1425";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const scenarios = ["restart-dirty", "restart-divergent", "restart-clean", "restart-missing", "restart-untitled", "legacy-import", "corrupt-fallback", "storage-full", "storage-denied", "checkpoint-before-overwrite", "checkpoint-before-reload", "reload-preserves-local", "overwrite-preserves-disk", "bom-crlf-save", "mixed-format", "legacy-conversion", "edits-during-checkpoint", "close-waits-for-latest", "close-draft-save-as",
  "recovery-down-saves-and-closes", "recovery-down-before-save", "keep-1252-checkpoints-once", "close-asks-for-unsaved-format", "corrupt-journal-set-aside", "recovery-over-limit", "unchanged-flush-skipped"];
try {
  for (const scenario of scenarios.filter(s => !process.env.AMBERTEXT_TEST_SCENARIO || s === process.env.AMBERTEXT_TEST_SCENARIO)) {
    const context = await browser.newContext();
    try {
      await context.route("**/*", route => {
        const target = new URL(route.request().url());
        return target.origin === new URL(url).origin || !/^https?:$/.test(target.protocol) ? route.continue() : route.abort();
      });
      const page = await context.newPage(); const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      if (scenario === "legacy-import") await page.addInitScript(() => {
        localStorage.setItem("margin:session", JSON.stringify({ docs: [{ id: "legacy-source", path: "/Users/you/Notes/Reading list.md", name: "Legacy", content: "Old unsaved writing" }], activeId: "legacy-source", root: null }));
      });
      if (scenario === "corrupt-fallback") await page.addInitScript(() => localStorage.setItem("ambertext:recovery-fallback", "{damaged-source"));
      if (scenario === "corrupt-journal-set-aside") await page.addInitScript(() => localStorage.setItem("ambertext:recovery-journal", "{damaged-journal"));
      await page.goto(url); await page.waitForSelector(".cm-content");
      const result = await page.evaluate(async scenario => {
        const a = await import("/src/state/actions.ts"); const s = await import("/src/state/store.ts");
        const p = await import("/src/lib/platform.ts"); const r = await import("/src/lib/recovery.ts");
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
        const answer = async action => {
          const until = Date.now() + 5000;
          while (!s.getState().dialog && Date.now() < until) await pause(10);
          check(s.getState().dialog, "Expected a format/replacement choice"); a.resolveDialog(action);
        };
        s.getState().setSettings({ autosave: false }); await a.flushRecovery();
        const path = "/Users/you/Notes/Reading list.md";
        if (scenario.startsWith("restart-")) {
          const file = await p.fsApi.readText(path);
          const doc = { id: "stable-recovery", name: "Recovered", currentPath: path, originalPath: path,
            content: "Recovered unsaved writing שלום 🙂", savedContent: file.content, savedRevision: file.revision,
            format: file.format, originalText: file.content, updatedAt: Date.now(), reason: null };
          if (scenario === "restart-divergent") { doc.savedContent = "Older disk writing"; doc.savedRevision = { ...file.revision, sha256: "a".repeat(64) }; }
          if (scenario === "restart-clean") { doc.content = doc.savedContent = "Older saved writing"; doc.savedRevision = { ...file.revision, sha256: "a".repeat(64) }; }
          if (scenario === "restart-missing") doc.currentPath = doc.originalPath = "/Users/you/Notes/missing-fixture.md";
          if (scenario === "restart-untitled") { doc.currentPath = doc.originalPath = null; doc.savedContent = ""; doc.savedRevision = null; }
          // Normal browser reload runs beforeunload. Keep its outgoing state equal to
          // the seeded record; otherwise that legitimate close flush replaces the fixture.
          s.setState({ docs: [{ ...s.getState().docs[0], id: doc.id, name: doc.name, path: doc.currentPath, originalPath: doc.originalPath,
            content: doc.content, savedContent: doc.savedContent, revision: doc.savedRevision, format: doc.format,
            originalText: doc.originalText, conflict: false, saving: false }], activeId: doc.id, workspace: null });
          await r.recoveryApi.write({ version: 1, updatedAt: Date.now() + 5000, docs: [doc], activeId: doc.id, root: null, legacySourceHash: null });
          localStorage.removeItem(r.FALLBACK_KEY);
          return { restart: true, expectedDisk: file.content, savedRevision: file.revision };
        }
        if (scenario === "legacy-import") {
          const source = localStorage.getItem("margin:session"); const restored = s.getState().docs.find(d => d.id === "legacy-source");
          check(restored.conflict && restored.revision === null, "Legacy import guessed a saved baseline");
          check(s.getState().docs.some(d => d.recoveryReason === "disk-version"), "Legacy divergence lost disk copy");
          const journal = (await r.recoveryApi.load()).snapshot;
          check(journal.legacySourceHash && localStorage.getItem("ambertext:legacy-source:" + journal.legacySourceHash) === source, "Exact legacy source was not verified");
          await a.flushRecovery(); check(localStorage.getItem("margin:session") === source, "Legacy source changed");
          return { passed: true };
        }
        if (scenario === "corrupt-fallback") {
          check(localStorage.getItem(r.FALLBACK_KEY) === "{damaged-source", "Damaged fallback overwritten");
          check(s.getState().recoveryWarning?.includes("retained"), "Damaged fallback warning lost");
          return { passed: true };
        }
        const id = await a.openPath(path); const baseline = (await p.fsApi.readText(path)).content;
        a.updateContent(id, "Our unsaved writing");
        if (scenario === "storage-full" || scenario === "storage-denied") {
          const set = Storage.prototype.setItem;
          Storage.prototype.setItem = () => { throw new DOMException("Injected storage failure", scenario === "storage-full" ? "QuotaExceededError" : "SecurityError"); };
          try {
            a.updateContent(id, "Still editable after storage failure");
            check(!await a.flushAll(), "Close approved despite failed recovery");
            check(s.getState().docs.find(d => d.id === id).content === "Still editable after storage failure", "Storage failure lost writing");
            check(s.getState().recoveryWarning, "Recovery failure was hidden");
            await pause(30); check(document.querySelector('[role="alert"]'), "No persistent visible warning");
          } finally { Storage.prototype.setItem = set; }
          check(await a.flushRecovery(), "Retry did not recover");
          return { passed: true };
        }
        if (scenario === "checkpoint-before-overwrite" || scenario === "checkpoint-before-reload") {
          const disk = await p.fsApi.readText(path); await p.fsApi.writeText(path, "External disk version", disk.revision);
          r.recoveryApi.write = async () => { throw new Error("Injected recovery denied"); };
          if (scenario.endsWith("overwrite")) { const op = a.saveDoc(id); await answer("overwrite"); await answer("cancel"); check(!await op, "Replacement passed failed checkpoint"); }
          else await a.reloadFromDisk(id);
          check(s.getState().docs.find(d => d.id === id).content === "Our unsaved writing", "Failed checkpoint replaced local writing");
          check((await p.fsApi.readText(path)).content === "External disk version", "Failed checkpoint changed disk writing");
          check(s.getState().recoveryWarning, "Missing checkpoint warning"); return { passed: true };
        }
        if (scenario === "reload-preserves-local" || scenario === "overwrite-preserves-disk") {
          const disk = await p.fsApi.readText(path); await p.fsApi.writeText(path, "External disk version", disk.revision);
          if (scenario.startsWith("reload")) {
            await a.reloadFromDisk(id); check(s.getState().docs.find(d => d.id === id).content === "External disk version", "Reload failed");
            check(s.getState().docs.some(d => d.recoveryReason === "before-reload" && d.content === "Our unsaved writing"), "Reload lost local copy");
          } else {
            const op = a.saveDoc(id); await answer("overwrite"); check(await op, "Reviewed replacement failed");
            check((await p.fsApi.readText(path)).content === "Our unsaved writing", "Replacement failed to save local writing");
            check(s.getState().docs.some(d => d.recoveryReason === "before-save" && d.content === "External disk version"), "Replacement lost disk copy");
          }
          const journal = (await r.recoveryApi.load()).snapshot;
          check(journal.docs.some(d => d.reason === (scenario.startsWith("reload") ? "before-reload" : "before-save")), "Preserved copy not in verified recovery");
          return { passed: true };
        }
        if (scenario === "bom-crlf-save") {
          const format = { ...p.defaultTextFormat(), bom: true, eol: "\r\n" };
          const file = await p.fsApi.readText(path); await p.fsApi.writeText(path, "First\nSecond", file.revision, format);
          await a.reloadFromDisk(id); a.updateContent(id, "First\nSecond æ🙂\nThird"); check(await a.saveDoc(id), "Formatted save failed");
          const saved = await p.fsApi.readText(path); check(saved.format.bom && saved.format.eol === "\r\n", "BOM or CRLF lost");
          check(saved.content === "First\r\nSecond æ🙂\r\nThird", "Character/line ending mismatch");
          const draft = a.newDoc("Copy\nLine", "Format copy");
          s.setState(state => ({ docs: state.docs.map(d => d.id === draft ? { ...d, format } : d) }));
          p.dialogs.saveFile = async () => "/Users/you/Notes/formatted-copy.md";
          check(await a.saveDocAs(draft), "Formatted Save As failed");
          const copy = await p.fsApi.readText("/Users/you/Notes/formatted-copy.md"); check(copy.format.bom && copy.format.eol === "\r\n", "Save As format lost");
          return { passed: true };
        }
        if (scenario === "mixed-format") {
          await p.fsApi.createFile("/Users/you/Notes/mixed.md", "a\r\nb\nc\r"); const mixed = await a.openPath("/Users/you/Notes/mixed.md");
          const original = await p.fsApi.readText("/Users/you/Notes/mixed.md");
          check(await a.saveDoc(mixed), "Clean mixed file save should be a no-op");
          check((await p.fsApi.readText("/Users/you/Notes/mixed.md")).revision.sha256 === original.revision.sha256, "Clean file changed bytes");
          a.updateContent(mixed, "a\nb\nc\nedited"); check(!await a.saveDoc(mixed, { auto: true }), "Autosave normalized mixed endings");
          let op = a.saveDoc(mixed); await answer("cancel"); check(!await op, "Cancelled format save succeeded");
          op = a.saveDoc(mixed); await answer("crlf"); check(await op, "Reviewed CRLF save failed");
          const saved = await p.fsApi.readText("/Users/you/Notes/mixed.md"); check(saved.format.eol === "\r\n", "Choice ignored");
          check(s.getState().docs.some(d => d.originalText === original.content && d.recoveryReason === "before-save"), "Original mixed bytes not retained as text/metadata");
          return { passed: true };
        }
        if (scenario === "legacy-conversion") {
          s.setState(state => ({ docs: state.docs.map(d => d.id === id ? { ...d, format: { encoding: "windows1252", bom: false, eol: "\n", confirmed: false } } : d) }));
          check(!await a.saveDoc(id, { auto: true }), "Background save confirmed a guessed encoding");
          const write = p.fsApi.writeText.bind(p.fsApi); let rejected = 0;
          p.fsApi.writeText = async (...args) => {
            if (args[3].encoding === "windows1252") { rejected++; throw { kind: "unsupported", message: "Injected unrepresentable character" }; }
            return write(...args);
          };
          const op = a.saveDoc(id); await answer("legacy"); await answer("utf8"); check(await op && rejected === 1, "Reviewed conversion did not save once");
          check(s.getState().docs.find(d => d.id === id).format.encoding === "utf8", "Converted metadata not committed");
          return { passed: true, limitation: "Frontend policy uses injected native encoder failure; Rust proves actual bytes" };
        }
        if (scenario === "close-waits-for-latest") {
          const write = r.recoveryApi.write.bind(r.recoveryApi); let release, entered;
          const ready = new Promise(resolve => { entered = resolve; }); let calls = 0;
          r.recoveryApi.write = async snapshot => { if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); } return write(snapshot); };
          const op = a.flushAll(); await ready; a.updateContent(id, "Newer writing while closing"); release();
          check(await op, "Stable close checkpoint failed");
          check((await r.recoveryApi.load()).snapshot.docs.find(d => d.id === id).content === "Newer writing while closing", "Close used stale writing");
          return { passed: true };
        }
        if (scenario === "edits-during-checkpoint") {
          const write = r.recoveryApi.write.bind(r.recoveryApi); let release, entered;
          const ready = new Promise(resolve => { entered = resolve; }); let calls = 0;
          r.recoveryApi.write = async snapshot => { if (++calls === 1) { entered(); await new Promise(resolve => { release = resolve; }); } return write(snapshot); };
          const op = a.saveDoc(id); await ready; a.updateContent(id, "Newer text during checkpoint"); release();
          check(await op, "Save checkpoint failed");
          check((await p.fsApi.readText(path)).content === "Our unsaved writing", "Save wrote text outside its verified checkpoint");
          check(s.getState().docs.find(d => d.id === id).content === "Newer text during checkpoint" && s.isDirty(s.getState().docs.find(d => d.id === id)), "Newer writing falsely marked saved");
          check(await a.flushRecovery(), "Latest writing did not enter recovery");
          check((await r.recoveryApi.load()).snapshot.docs.find(d => d.id === id).content === "Newer text during checkpoint", "Recovery omitted newer writing");
          return { passed: true };
        }
        if (scenario === "close-draft-save-as") {
          const draft = a.newDoc("Draft saved while closing", "Closing fixture");
          p.dialogs.saveFile = async () => "/Users/you/Notes/closing-fixture.md";
          const op = a.closeDoc(draft); await answer("save"); check(await op, "Draft close failed");
          check(!s.getState().docs.some(d => d.path === "/Users/you/Notes/closing-fixture.md"), "Saved replacement identity left tab open");
          check((await p.fsApi.readText("/Users/you/Notes/closing-fixture.md")).content === "Draft saved while closing", "Closed draft missing on disk");
          return { passed: true };
        }
        if (scenario === "recovery-down-saves-and-closes") {
          r.recoveryApi.write = async () => { throw new Error("Injected recovery denied"); };
          check(await a.saveDoc(id), "A failed recovery store blocked the real save");
          check((await p.fsApi.readText(path)).content === "Our unsaved writing", "Save did not reach the file");
          check(s.getState().recoveryWarning, "Recovery failure was hidden");
          const warning = s.getState().recoveryWarning; a.updateContent(id, "More writing"); check(await a.saveDoc(id), "Second save blocked");
          check(s.getState().recoveryWarning === warning, "Warning changed between saves");
          let op = a.closeWindow(); await answer("cancel"); check(!await op, "Close passed a cancelled choice");
          op = a.closeWindow(); await answer("close"); check(await op, "Close stayed blocked by recovery");
          return { passed: true };
        }
        if (scenario === "recovery-down-before-save") {
          const disk = await p.fsApi.readText(path); await p.fsApi.writeText(path, "External disk version", disk.revision);
          r.recoveryApi.write = async () => { throw new Error("Injected recovery denied"); };
          let op = a.saveDoc(id); await answer("overwrite"); await answer("cancel"); check(!await op, "Declined save went ahead");
          check((await p.fsApi.readText(path)).content === "External disk version", "Declined save changed the file");
          op = a.saveDoc(id); await answer("overwrite"); await answer("save"); check(await op, "Save anyway did not save");
          check((await p.fsApi.readText(path)).content === "Our unsaved writing", "Save anyway did not write");
          return { passed: true };
        }
        if (scenario === "keep-1252-checkpoints-once") {
          s.setState(state => ({ docs: state.docs.map(d => d.id === id ? { ...d, format: { encoding: "windows1252", bom: false, eol: "\n", confirmed: true } } : d) }));
          const write = p.fsApi.writeText.bind(p.fsApi); p.fsApi.writeText = (path, content, expected, format) => write(path, content, expected, { ...format, encoding: "utf8" });
          check(await a.saveDoc(id), "First save failed"); a.updateContent(id, "Second edit"); check(await a.saveDoc(id, { auto: true }), "Autosave failed");
          a.updateContent(id, "Third edit"); check(await a.saveDoc(id, { auto: true }), "Autosave failed again");
          check(!s.getState().docs.some(d => d.recoveryReason === "before-save"), "Kept format still made a Before save copy");
          return { passed: true };
        }
        if (scenario === "close-asks-for-unsaved-format") {
          s.getState().setSettings({ autosave: true });
          s.setState(state => ({ docs: state.docs.map(d => d.id === id ? { ...d, format: { encoding: "windows1252", bom: false, eol: "\n", confirmed: false } } : d) }));
          a.updateContent(id, "Edit autosave must not write");
          const op = a.closeWindow(); await answer("cancel"); check(!await op, "Close passed unwritten changes");
          check((await p.fsApi.readText(path)).content === baseline, "Autosave wrote an unconfirmed format");
          return { passed: true };
        }
        if (scenario === "corrupt-journal-set-aside") {
          check(await a.flushRecovery(), "Write failed over a damaged journal");
          const kept = Object.keys(localStorage).filter(k => k.startsWith("ambertext:recovery-journal.corrupt-"));
          check(kept.length === 1 && localStorage.getItem(kept[0]) === "{damaged-journal", "Damaged journal not kept aside");
          check((await r.recoveryApi.load()).snapshot, "New journal unreadable");
          return { passed: true };
        }
        if (scenario === "recovery-over-limit") {
          const format = p.defaultTextFormat();
          const mk = (n, dirty) => ({ id: "bulk-" + n, name: "Bulk " + n, currentPath: null, originalPath: null, content: dirty ? "dirty" : "", savedContent: "", savedRevision: null, format, originalText: "", updatedAt: Date.now(), reason: null });
          const docs = Array.from({ length: 300 }, (_, n) => mk(n, n === 299));
          const written = await r.recoveryApi.write({ version: 1, updatedAt: Date.now(), docs, activeId: "bulk-0", root: null, legacySourceHash: null });
          check(written.omitted === 44, "Expected 44 omitted, got " + written.omitted);
          const kept = (await r.recoveryApi.load()).snapshot.docs;
          check(kept.length === 256 && kept.some(d => d.id === "bulk-299") && kept.some(d => d.id === "bulk-0"), "Unsaved or active writing not kept first");
          return { passed: true };
        }
        if (scenario === "unchanged-flush-skipped") {
          check(await a.flushRecovery(), "Flush failed");
          const write = r.recoveryApi.write.bind(r.recoveryApi); let calls = 0;
          r.recoveryApi.write = async snapshot => { calls++; return write(snapshot); };
          check(await a.flushRecovery() && calls === 0, "Unchanged state was written again");
          a.updateContent(id, "Changed again"); check(await a.flushRecovery() && calls === 1, "Changed state was not written");
          return { passed: true };
        }
        throw new Error("Unhandled scenario " + scenario);
      }, scenario);
      if (result.restart) {
        await page.reload(); await page.waitForSelector(".cm-content");
        await page.evaluate(async ({ scenario, expectedDisk }) => {
          const s = await import("/src/state/store.ts"); const a = await import("/src/state/actions.ts");
          const d = s.getState().docs.find(d => d.id === "stable-recovery");
          const check = (c, m) => { if (!c) throw new Error(m); };
          check(d && s.getState().activeId === d.id, "Stable identity/active tab not restored");
          if (scenario === "restart-clean") check(d.content === expectedDisk && !s.isDirty(d), "Clean recovery ignored current disk");
          else check(d.content === "Recovered unsaved writing שלום 🙂", "Recovered writing mismatch");
          if (scenario === "restart-divergent") { check(d.conflict && !await a.saveDoc(d.id, { auto: true }), "Divergent recovery autosaved"); check(s.getState().docs.some(d => d.recoveryReason === "disk-version" && d.content === expectedDisk), "Disk version missing"); }
          if (scenario === "restart-dirty") check(!d.conflict && d.savedContent === expectedDisk, "Known unchanged baseline became conflict");
          if (scenario === "restart-missing") check(d.path === null && d.originalPath?.endsWith("missing-fixture.md"), "Missing file recreated or original path lost");
          if (scenario === "restart-untitled") check(d.path === null && s.isDirty(d), "Untitled draft lost dirty state");
        }, { scenario, expectedDisk: result.expectedDisk });
      }
      assert.deepEqual(errors, [], scenario + " runtime errors");
      console.log(JSON.stringify({ surface: "isolated browser/frontend", scenario, passed: true, ...(result.limitation ? { limitation: result.limitation } : {}) }));
    } finally { await context.close(); }
  }
  // Exercise the installed Tauri JS close API with a fake IPC boundary, never an actual window.
  const context = await browser.newContext();
  try {
    await context.route("**/close-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Disposable close fixture</title>" }));
    const page = await context.newPage(); await page.goto(url + "/close-fixture");
    await page.evaluate(async () => {
      const callbacks = new Map(); let callbackId = 0; let handler; let destroys = 0;
      window.__TAURI_INTERNALS__ = { metadata: { currentWindow: { label: "fixture" } }, transformCallback(fn) { callbacks.set(++callbackId, fn); return callbackId; },
        async invoke(command, args) { if (command === "plugin:event|listen") { handler = callbacks.get(args.handler); return 1; } if (command === "plugin:window|destroy") { destroys++; return; } throw new Error(command); } };
      const { win } = await import("/src/lib/platform.ts");
      let release; let approve = false; let calls = 0;
      const off = win.onCloseRequested(async () => { calls++; return new Promise(resolve => { release = () => resolve(approve); }); });
      const until = Date.now() + 5000; while (!handler && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      const event = { event: "tauri://close-requested", id: 1, payload: null };
      const first = handler(event); await handler(event);
      if (destroys !== 0 || calls !== 1) throw new Error("Close destroyed early or concurrent close bypassed wait");
      release(); await first; if (destroys !== 0) throw new Error("Failed recovery destroyed window");
      approve = true; const second = handler(event); release(); await second;
      if (destroys !== 1) throw new Error("Verified close did not destroy exactly once");
      // Do not unlisten through a real IPC boundary.
      void off;
    });
    console.log(JSON.stringify({ surface: "Tauri JS with mocked IPC", scenario: "native-close-waits-prevents-retries", passed: true }));
  } finally { await context.close(); }
} finally { await browser.close(); }
