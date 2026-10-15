// Headless frontend/history fixtures; memory-backed files and localStorage.
// Native raw bytes, transaction failures and retention have separate Rust proof.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1427";
async function until(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail("History fixture timed out waiting for the awaited state");
}
const scenarios = ["dedup-raw", "manual-save", "autosave-bounded", "five-minute-capture", "save-history-failure", "reload-history-failure", "overwrite-history-failure", "close-reopen", "duplicate-identities", "save-as-identity", "rename-closed", "relink-moved", "trash-recovery", "recreate-missing", "new-draft", "restore-active", "restore-parked", "restore-disk-conflict", "restore-checkpoint-failure", "restore-concurrent-edit", "privacy-remove", "privacy-controls", "corrupt-retained", "offline-preview", "large-fallback", "diff-fallback", "keyboard-preview"];
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext(); const errors = []; const network = [];
    try {
      await context.route("**/*",route => {
        const target = new URL(route.request().url());
        if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return route.abort(); }
        return route.continue();
      });
      const page = await context.newPage(); page.on("pageerror",e => errors.push(e.message));
      await page.goto(url); await page.waitForSelector(".cm-content");
      if (scenario === "five-minute-capture") await page.clock.install();
      const result = await page.evaluate(async scenario => {
        const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts"), h = await import("/src/lib/history.ts");
        const b = (await import("/src/editor/bridge.ts")).bridge;
        const check = (value,message) => { if (!value) throw new Error(message); };
        const wait = ms => new Promise(resolve => setTimeout(resolve,ms));
        const until = async fn => { const end = Date.now()+5000; while (!fn() && Date.now()<end) await wait(10); check(fn(),"Expected fixture state"); };
        const answer = async action => { await until(() => s.getState().dialog); a.resolveDialog(action); };
        s.getState().setSettings({ autosave: false, historyEnabled: true });
        const path = "/Users/you/Notes/history-"+scenario+".md", original = "Original writing שלום 🙂\n";
        await p.fsApi.createFile(path,scenario === "dedup-raw" ? "\ufeffOriginal\r\n" : original);
        const id = await a.openPath(path); await until(() => b.viewDocId === id);
        const doc = () => s.getState().docs.find(d => d.id === id);
        if (scenario === "dedup-raw") {
          const initial = await h.historyApi.versions(id); check(initial.entries[0].representation === "raw-disk","Opening did not preserve raw bytes");
          await a.captureHistoryDoc(doc(),"manual-save");
          for (let n=0;n<12;n++) await a.captureHistoryDoc(doc(),"interval");
          const m = await h.historyApi.versions(id); check(m.entries.length === 2,"Repeated content created versions");
          const raw = await h.historyApi.read(id,1); check(raw.content === "Original\r\n" && raw.entry.format.bom,"BOM/line-ending metadata lost");
          return {};
        }
        if (scenario === "manual-save" || scenario === "save-history-failure") {
          const capture = h.historyApi.capture.bind(h.historyApi);
          a.updateContent(id,"Changed writing");
          if (scenario === "save-history-failure") h.historyApi.capture = async () => { throw new Error("Injected denied history storage"); };
          check(await a.saveDoc(id),"Ordinary save was blocked by optional history");
          check((await p.fsApi.readText(path)).content === "Changed writing","Saved writing mismatch");
          if (scenario === "manual-save") check((await h.historyApi.versions(id)).entries.some(e => e.reason === "manual-save"),"Manual milestone missing");
          else {
            check(s.getState().historyWarning,"History failure hidden");
            await a.maintainHistory(); check(s.getState().historyWarning,"Read-only maintenance cleared a failed-write warning");
            check(!await a.retryHistory() && s.getState().historyWarning,"Failed retry cleared history warning");
            h.historyApi.capture = capture; check(await a.retryHistory() && !s.getState().historyWarning,"Verified retry did not clear history warning");
          }
          return {};
        }
        if (scenario === "autosave-bounded") {
          s.getState().setSettings({ autosave: true });
          for (let n=0;n<4;n++) { a.updateContent(id,"Autosave "+n); await wait(950); }
          check((await p.fsApi.readText(path)).content === "Autosave 3","Autosave did not reach file");
          check((await h.historyApi.versions(id)).entries.length === 1,"750ms autosaves created per-write history");
          return {};
        }
        if (scenario === "five-minute-capture") { a.updateContent(id,"Timed writing"); return { id }; }
        if (scenario === "reload-history-failure" || scenario === "overwrite-history-failure") {
          a.updateContent(id,"Local unsaved");
          const disk = await p.fsApi.readText(path); await p.fsApi.writeText(path,"External writing",disk.revision);
          h.historyApi.capture = async () => { throw new Error("Injected failed required checkpoint"); };
          if (scenario === "reload-history-failure") { const reloading = a.reloadFromDisk(id); await answer("cancel"); await reloading; }
          else { const saving = a.saveDoc(id); await answer("overwrite"); await answer("cancel"); check(!await saving,"Overwrite ignored history failure"); }
          check(doc().content === "Local unsaved","Failed checkpoint replaced local writing");
          check((await p.fsApi.readText(path)).content === "External writing","Failed checkpoint replaced disk");
          return {};
        }
        if (scenario === "close-reopen") {
          a.updateContent(id,"Closed unsaved version");
          const closing = a.closeDoc(id); await answer("discard"); check(await closing,"Tab close failed");
          const m = await h.historyApi.versions(id); check((await h.historyApi.read(id,m.entries.at(-1).sequence)).content === "Closed unsaved version","Practical close did not preserve writing");
          const reopened = await a.openPath(path); check(reopened === id,"Reopening forked stable history identity"); return {};
        }
        if (scenario === "duplicate-identities") {
          // Drafts must not register their source path; two old records for one file merge to the most recent.
          
          const base = { name: "Dup", currentPath: path.replace(/\//g,"\\"), diskRevision: null, format: doc().format, reason: "manual-save", operation: null };
          await a.closeDoc(id);
          await h.historyApi.capture({ ...base, documentId: "older-record", content: "Older" });
          await new Promise(r => setTimeout(r,5));
          await h.historyApi.capture({ ...base, documentId: "newer-record", currentPath: path, content: "Newer" });
          const reopened = await a.openPath(path); check(reopened === "newer-record","Reopen did not choose the most recent record");
          check((await h.historyApi.versions("older-record")).currentPath === null && (await h.historyApi.versions("older-record")).entries.length === 1,"Older record was not detached with its versions kept");
          check(!s.getState().historyWarning,"Merging raised a history warning");
          return {};
        }
        if (scenario === "save-as-identity") {
          a.updateContent(id,"Copied writing"); const old = p.dialogs.saveFile;
          p.dialogs.saveFile = async () => path+".copy.md";
          try { check(await a.saveDocAs(id),"Save As failed"); } finally { p.dialogs.saveFile = old; }
          const copy = s.getState().docs.find(d => d.path === path+".copy.md");
          check(copy && copy.id !== id,"Save As shared original identity");
          check((await h.historyApi.versions(id)).currentPath === path,"Original history association moved");
          check((await h.historyApi.versions(copy.id)).currentPath === copy.path,"Copy history association missing"); return {};
        }
        if (scenario === "rename-closed") {
          check(await a.closeDoc(id),"Close failed"); await a.renameEntry(path,"history-renamed.md");
          const renamed = "/Users/you/Notes/history-renamed.md";
          check((await h.historyApi.versions(id)).currentPath === renamed,"Closed file history did not follow rename");
          check(await a.openPath(renamed) === id,"Renamed file forked history"); return {};
        }
        if (scenario === "relink-moved") {
          await a.closeDoc(id); const moved = path+".moved.md";
          await p.fsApi.rename(path,moved); const currentId = await a.openPath(moved); await until(() => b.viewDocId === currentId);
          b.view.dispatch({ changes: { from: 0, to: b.view.state.doc.length, insert: "Moved unsaved writing" } });
          check(await a.relinkHistory(id,currentId),"Explicit moved-file history link failed");
          check(s.getState().activeId === id && doc().content === "Moved unsaved writing","Relink lost identity or unsaved text");
          check((await p.fsApi.readText(moved)).content === original,"Relink changed file bytes");
          check((await h.historyApi.versions(currentId)).currentPath === null,"Other history association was not detached");
          (await import("/src/commands.ts")).commandById.get("undo").run();
          check(doc().content === original,"Relink lost editor Undo"); return {};
        }
        if (scenario === "recreate-missing") {
          await a.closeDoc(id); await p.fsApi.trash(path);
          const recovered = await a.recoverHistoryVersion(id,1); check(recovered,"Missing file draft recovery failed");
          check(!await p.fsApi.exists(path),"Recovery silently recreated original path");
          const previous = p.dialogs.saveFile; let suggested = null;
          p.dialogs.saveFile = async value => { suggested = value; return path; };
          try { check(await a.saveDocAs(recovered),"Explicit missing-file recreation failed"); } finally { p.dialogs.saveFile = previous; }
          check(suggested === path,"Recreation did not suggest the historical path for explicit choice");
          check((await p.fsApi.readText(path)).content === original,"Recreated bytes mismatch"); return {};
        }
        if (scenario === "trash-recovery") {
          a.updateContent(id,"Writing before deletion");
          const deleting = a.trashEntry({ name: "fixture", path, isDir: false }); await answer("trash"); await deleting;
          check(!await p.fsApi.exists(path),"Trash did not remove fixture file");
          const m = await h.historyApi.versions(id); const last = m.entries.at(-1);
          check(!m.entries.some(e => e.operation),"Finished delete checkpoint stayed pinned");
          const recovered = await a.recoverHistoryVersion(id,last.sequence);
          check(recovered && s.getState().docs.find(d => d.id === recovered).content === "Writing before deletion","Deleted writing could not recover into a draft");
          check(!await p.fsApi.exists(path),"Recovery silently recreated deleted file"); return {};
        }
        if (scenario.startsWith("restore-")) {
          b.view.dispatch({ changes: { from: 0, to: b.view.state.doc.length, insert: "Current writing" } });
          check(await a.saveDoc(id),"Prepare current file failed"); await until(() => b.view.state.doc.toString() === "Current writing");
          if (scenario === "restore-disk-conflict") {
            const disk = await p.fsApi.readText(path); await p.fsApi.writeText(path,"External latest",disk.revision);
          }
          if (scenario === "restore-checkpoint-failure") h.historyApi.capture = async () => { throw new Error("Injected restore checkpoint failure"); };
          if (scenario === "restore-concurrent-edit") {
            const capture = h.historyApi.capture.bind(h.historyApi); let changed = false;
            h.historyApi.capture = async request => { const result = await capture(request); if (!changed) { changed = true; a.updateContent(id,"Newer typing during checkpoint"); } return result; };
          }
          if (scenario === "restore-parked") { a.newDoc("Other tab"); await until(() => b.viewDocId !== id); }
          const restoring = a.restoreHistoryVersion(id,1);
          if (scenario === "restore-checkpoint-failure") await answer("cancel");
          const restored = await restoring;
          if (["restore-disk-conflict","restore-checkpoint-failure","restore-concurrent-edit"].includes(scenario)) {
            check(!restored && doc().content === (scenario === "restore-concurrent-edit" ? "Newer typing during checkpoint" : "Current writing"),"Restore safety failure changed buffer");
            check((await p.fsApi.readText(path)).content === (scenario === "restore-disk-conflict" ? "External latest" : "Current writing"),"Restore safety failure changed disk"); return {};
          }
          check(restored,"History restore failed"); check((await p.fsApi.readText(path)).content === original,"Restored file mismatch");
          if (scenario === "restore-parked") { a.activate(id); await until(() => b.viewDocId === id); }
          const commands = await import("/src/commands.ts");
          commands.commandById.get("undo").run();
          check(doc().content === "Current writing","Undo failed to restore previous active/parked writing");
          return {};
        }
        if (scenario === "privacy-remove") {
          const before = await p.fsApi.readText(path);
          const request = { documentId: id, name: "Fixture", currentPath: path, content: "Pinned writing", diskRevision: null, format: before.format, reason: "before-restore", operation: "unfinished" };
          await h.historyApi.capture(request); let refused = false; try { await h.historyApi.removeAll(); } catch { refused = true; }
          check(refused,"Removal ignored unfinished operation"); await h.historyApi.release(id,"unfinished");
          s.getState().setSettings({ historyEnabled: false }); await h.historyApi.removeAll();
          check(!(await h.historyApi.catalogue()).documents.length,"Privacy removal retained manifests");
          check((await p.fsApi.readText(path)).content === before.content,"Privacy removal changed Markdown");
          a.updateContent(id,"Writing with history disabled"); await a.saveDoc(id);
          check(!(await h.historyApi.catalogue()).documents.length,"Disabled history recreated stored copies"); return {};
        }
        if (scenario === "corrupt-retained") {
          const key = "ambertext:history:"+id; localStorage.setItem(key,"{damaged-history"); let refused = false;
          try { await h.historyApi.maintain(); } catch { refused = true; }
          check(!refused && localStorage.getItem(key) === "{damaged-history","One damaged record stopped cleanup or was replaced");
          check(!await h.historyApi.resolve("/nowhere/none.md",null,[]) && localStorage.getItem(key) === "{damaged-history","Damaged record blocked opening");
          a.updateContent(id,"Still editable"); check(await a.saveDoc(id),"Corrupt history blocked ordinary save"); return {};
        }
        if (scenario === "offline-preview") {
          await h.historyApi.capture({ documentId: id, name: "Fixture", currentPath: path, content: "# Offline preview\n![tracker](https://example.invalid/tracker.png)\n<video src='https://example.invalid/video'></video><svg><image href='https://example.invalid/svg.png'/></svg><form action='https://example.invalid/send'><input value='Do not edit'/><button>Send</button></form><div contenteditable>Read only</div>", diskRevision: null, format: doc().format, reason: "manual-save", operation: null });
        } else if (scenario === "large-fallback") {
          await h.historyApi.capture({ documentId: id, name: "Fixture", currentPath: path, content: "Large history\n"+"x".repeat(210000), diskRevision: null, format: doc().format, reason: "manual-save", operation: null });
        } else if (scenario === "diff-fallback") {
          a.updateContent(id,Array.from({length:3000},(_,i) => "current"+i).join(" "));
          await h.historyApi.capture({ documentId: id, name: "Fixture", currentPath: path, content: Array.from({length:3000},(_,i) => "earlier"+i).join(" "), diskRevision: null, format: doc().format, reason: "manual-save", operation: null });
        } else if (scenario === "new-draft") { a.updateContent(id,"Historical candidate"); await a.captureHistoryDoc(doc(),"manual-save"); a.updateContent(id,"Current unsaved"); }
        s.setState({ historyOpen: id }); return { id, path, original };
      },scenario);
      if (scenario === "five-minute-capture") {
        await page.clock.fastForward(5*60*1000+100);
        await until(() => page.evaluate(async id => { const h = await import("/src/lib/history.ts"); return (await h.historyApi.versions(id)).entries.some(e => e.reason === "interval"); },result.id));
        assert.equal(await page.evaluate(async id => (await (await import("/src/lib/history.ts")).historyApi.versions(id)).entries.length,result.id),2);
      }
      if (["new-draft","offline-preview","large-fallback","diff-fallback","keyboard-preview","privacy-controls"].includes(scenario)) {
        const panel = page.getByRole("dialog",{ name: "Version history" }); await panel.waitFor();
        await panel.getByRole("button",{ name: "Open as new document", exact: true }).waitFor({ state: "visible" });
        await page.waitForFunction(() => !document.querySelector(".history-panel footer button").disabled);
        if (scenario === "new-draft") {
          await panel.getByRole("button",{ name: "Open as new document", exact: true }).click();
          const state = await page.evaluate(id => import("/src/state/store.ts").then(s => ({ current: s.getState().docs.find(d => d.id === id).content, draft: s.getState().docs.find(d => d.id === s.getState().activeId) })),result.id);
          assert.equal(state.current,"Current unsaved"); assert.equal(state.draft.content,"Historical candidate"); assert.equal(state.draft.path,null); assert.notEqual(state.draft.id,result.id);
        } else if (scenario === "offline-preview") {
          await panel.getByRole("button",{ name: "Formatted", exact: true }).click();
          await panel.locator("article").waitFor(); assert.equal(await panel.locator("article img,article video,article audio,article iframe,article svg,article form,article input,article button,article [contenteditable]").count(),0); assert.equal(network.length,0);
        } else if (scenario === "privacy-controls") {
          await panel.getByRole("button",{ name: "Turn off and delete history…" }).click();
          await panel.getByRole("button",{ name: "Delete history", exact: true }).click();
          await panel.getByText("No versions yet.").waitFor();
          assert.equal(await panel.getByRole("checkbox",{ name: "Keep version history" }).isChecked(),false);
          assert.equal(await page.evaluate(async path => (await (await import("/src/lib/platform.ts")).fsApi.readText(path)).content,result.path),result.original);
        } else if (scenario === "large-fallback" || scenario === "diff-fallback") {
          await panel.getByRole("button",{ name: "Compare with now" }).click();
          if (scenario === "large-fallback") { assert.match(await panel.locator(".history-preview").innerText(),/This version is long/); assert.equal((await panel.locator(".history-preview pre").innerText()).length,200000); }
          else assert.match(await panel.locator(".history-preview").innerText(),/too long to compare word by word/);
        } else {
          await panel.getByRole("button",{ name: "Close", exact: true }).focus();
          await page.keyboard.press("Shift+Tab"); assert.equal(await page.evaluate(() => !!document.activeElement.closest(".history-panel")),true);
          await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.hasAttribute("data-history-close")),true);
          await page.keyboard.press("Escape"); await panel.waitFor({ state: "detached" });
        }
      }
      assert.deepEqual(errors,[],scenario+" page errors"); console.log("PASS "+scenario);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
