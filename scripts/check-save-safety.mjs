// Frontend regression checks against a fresh task-owned Vite server.
// Native filesystem failure coverage lives in safe_io.rs, not this browser test.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1425";
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  const scenarios = ["failed-replacement", "cancel-selection", "cancel-overwrite", "successful-copy", "changed-destination", "deleted-destination", "simultaneous-saves", "rename-then-save", "legacy-unknown-baseline", "edits-during-save", "case-distinct-files", "case-distinct-folder-rename", "case-distinct-folder-trash", "case-distinct-existing-rename", "case-distinct-links"];
  for (const scenario of scenarios.filter(s => !process.env.AMBERTEXT_TEST_SCENARIO || s === process.env.AMBERTEXT_TEST_SCENARIO)) {
    const context = await browser.newContext();
    try {
      await context.route("**/*", route => {
        const target = new URL(route.request().url());
        return target.origin === new URL(url).origin || !/^https?:$/.test(target.protocol) ? route.continue() : route.abort();
      });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      if (scenario === "legacy-unknown-baseline") await page.addInitScript(() => {
        localStorage.setItem("margin:session", JSON.stringify({ docs: [{ id: "legacy-fixture", path: "/Users/you/Notes/Reading list.md", name: "Legacy", content: "Recovered unsaved writing" }], activeId: "legacy-fixture", root: null }));
      });
      await page.goto(url);
      await page.waitForSelector(".cm-content");
      const result = await page.evaluate(async scenario => {
        const a = await import("/src/state/actions.ts");
        const s = await import("/src/state/store.ts");
        const p = await import("/src/lib/platform.ts");
        const { bridge } = await import("/src/editor/bridge.ts");
        const { commandById } = await import("/src/commands.ts");
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const dialog = async () => {
          const until = Date.now() + 5000;
          while (!s.getState().dialog && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
          check(s.getState().dialog, "Expected explicit overwrite dialog");
        };
        s.getState().setSettings({ autosave: false });
        const path = "/Users/you/Notes/Reading list.md";
        if (scenario === "case-distinct-links") {
          const paths = await import("/src/lib/paths.ts");
          const from = "/Users/you/Notes/Images";
          const to = "/Users/you/Notes/images/cover.png";
          check(!paths.isInside(to, from), "Case-distinct sibling misclassified as a child");
          check(paths.relativeLink(from, to) === "../images/cover.png", "Link dropped case-distinct parent segment");
          check(paths.resolvePath(from, paths.relativeLink(from, to)) === to, "Generated link resolves to a different asset");
          return { scenario, passed: true };
        }
        if (scenario === "case-distinct-existing-rename") {
          const upper = "/Users/you/Notes/Case.md", lower = "/Users/you/Notes/case.md";
          await p.fsApi.createFile(upper, "Upper bytes"); await p.fsApi.createFile(lower, "Lower bytes");
          const id = await a.openPath(upper);
          await a.renameEntry(upper, "case.md");
          check((await p.fsApi.readText(lower)).content === "Lower bytes", "Rename clobbered an existing case-distinct file");
          check((await p.fsApi.readText(upper)).content === "Upper bytes", "Rejected rename removed source");
          check(s.getState().docs.find(d => d.id === id)?.path === upper, "Rejected rename rebound source tab");
          return { scenario, passed: true };
        }
        if (scenario === "case-distinct-folder-rename" || scenario === "case-distinct-folder-trash") {
          const upperDir = "/Users/you/Notes/Case", lowerDir = "/Users/you/Notes/case";
          const upper = upperDir + "/draft.md", lower = lowerDir + "/draft.md";
          await p.fsApi.createDir(upperDir); await p.fsApi.createDir(lowerDir);
          await p.fsApi.createFile(upper, "Upper disk"); await p.fsApi.createFile(lower, "Lower disk");
          const upperId = await a.openPath(upper), lowerId = await a.openPath(lower);
          a.updateContent(lowerId, "Other folder unsaved writing");
          s.setState({ goals: { [upper]: 123, [lower]: 456 }, expanded: [] });
          a.toggleExpanded(upperDir, true); a.toggleExpanded(lowerDir, true);
          check(s.getState().expanded.length === 2, "Case-distinct folder expansion collapsed");
          check(s.getState().recentFiles.includes(upper) && s.getState().recentFiles.includes(lower), "Case-distinct recent files collapsed");
          if (scenario.endsWith("rename")) {
            await a.renameEntry(upperDir, "Renamed");
            const to = "/Users/you/Notes/Renamed/draft.md";
            check(s.getState().docs.find(d => d.id === upperId)?.path === to, "Renamed child not rebound");
            check(s.getState().goals[to] === 123 && s.getState().goals[lower] === 456, "Rename moved another folder's goal");
            check((await p.fsApi.readText(to)).content === "Upper disk", "Renamed source bytes lost");
          } else {
            const pending = a.trashEntry({ name: "Case", path: upperDir, isDir: true });
            await dialog(); a.resolveDialog("trash"); await pending;
            check(!s.getState().docs.some(d => d.id === upperId), "Trashed source tab retained");
            check(!await p.fsApi.exists(upper), "Trashed source bytes retained");
          }
          check(s.getState().docs.find(d => d.id === lowerId)?.path === lower, "Sibling tab was moved or closed");
          check(s.getState().docs.find(d => d.id === lowerId)?.content === "Other folder unsaved writing", "Sibling unsaved writing lost");
          check((await p.fsApi.readText(lower)).content === "Lower disk", "Sibling disk bytes changed or deleted");
          check(s.getState().recentFiles.includes(lower), "Sibling recent file removed");
          return { scenario, passed: true };
        }
        if (scenario === "case-distinct-files") {
          const upper = "/Users/you/Notes/Case.md";
          const lower = "/Users/you/Notes/case.md";
          await p.fsApi.createFile(upper, "Upper file");
          await p.fsApi.createFile(lower, "Lower file");
          const upperId = await a.openPath(upper);
          const lowerId = await a.openPath(lower);
          check(upperId !== lowerId, "Case-sensitive files collapsed into one tab");
          a.updateContent(upperId, "Edited upper file");
          check(await a.saveDoc(upperId), "Case-sensitive save failed");
          check((await p.fsApi.readText(lower)).content === "Lower file", "Saving one case-distinct file changed the other");
          return { scenario, passed: true };
        }
        if (scenario === "legacy-unknown-baseline") {
          const restored = s.getState().docs.find(d => d.id === "legacy-fixture");
          check(restored?.conflict && restored.revision === null, "Unknown legacy baseline silently accepted current disk revision");
          check(restored.content === "Recovered unsaved writing", "Legacy buffer lost");
          const disk = (await p.fsApi.readText(path)).content;
          check(!await a.saveDoc(restored.id, { auto: true }), "Unknown baseline autosaved");
          check((await p.fsApi.readText(path)).content === disk, "Unknown baseline overwrote disk");
          return { scenario, passed: true };
        }
        const destination = await a.openPath(path);
        a.updateContent(destination, "Destination unsaved writing");
        const originalBytes = (await p.fsApi.readText(path)).content;
        const source = a.newDoc("Source unsaved writing", "Source");
        await frames();
        s.setState({ goals: { ["draft:" + source]: 1234 } });
        p.dialogs.saveFile = async () => scenario === "cancel-selection" ? null : path;
        const write = p.fsApi.writeText.bind(p.fsApi);
        let release;
        if (scenario === "edits-during-save") p.fsApi.writeText = async (...args) => {
          await new Promise(resolve => { release = resolve; });
          return write(...args);
        };
        if (scenario === "rename-then-save") {
          const newPath = "/Users/you/Notes/renamed fixture.md";
          await a.renameEntry(path, "renamed fixture.md");
          check(s.getState().docs.find(d => d.id === destination).revision.canonicalPath === newPath, "Rename left stale save destination");
          check(await a.saveDoc(destination), "Saving an app-renamed document failed");
          check((await p.fsApi.readText(newPath)).content === "Destination unsaved writing", "Renamed file did not save buffer");
          return { scenario, passed: true };
        }
        if (scenario === "failed-replacement") p.fsApi.writeText = async () => { throw { kind: "permission", message: "Injected replacement failure" }; };
        if (scenario === "changed-destination") p.fsApi.writeText = async (path, content, expected) => {
          const disk = await p.fsApi.readText(path);
          await write(path, "External writing", disk.revision);
          return write(path, content, expected);
        };
        if (scenario === "deleted-destination") {
          const existing = await a.openPath(path);
          a.updateContent(existing, "Our edits");
          await p.fsApi.trash(path);
          check(!(await a.saveDoc(existing)), "Save silently recreated a deleted file");
          check(!await p.fsApi.exists(path), "Deleted file reappeared");
          check(s.getState().docs.find(d => d.id === existing).content === "Our edits", "Deleted destination lost buffer");
          return { scenario, passed: true };
        }
        if (scenario === "simultaneous-saves") {
          const revision = (await p.fsApi.readText(path)).revision;
          const writes = await Promise.allSettled([write(path, "first", revision), write(path, "second", revision)]);
          check(writes.filter(r => r.status === "fulfilled").length === 1, "Two writes using the same revision succeeded");
          check(writes.some(r => r.status === "rejected" && r.reason.kind === "conflict"), "Losing write did not report conflict");
          return { scenario, passed: true };
        }
        const pending = a.saveDocAs(source);
        if (scenario !== "cancel-selection") {
          await dialog();
          check(s.getState().docs.find(d => d.id === source).path === null, "Path changed before confirmation");
          check(s.getState().docs.some(d => d.id === destination), "Destination tab removed before confirmation");
          a.resolveDialog(scenario === "cancel-overwrite" ? "cancel" : "replace");
        }
        if (scenario === "edits-during-save") {
          const until = Date.now() + 5000;
          while (!release && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
          check(release, "Save did not reach IO");
          a.updateContent(source, "Source writing edited during save"); release();
        }
        const ok = await pending;
        await frames();
        const other = s.getState().docs.find(d => d.id === destination);
        check(other?.content === "Destination unsaved writing", "Destination's unsaved buffer was lost");
        if (scenario !== "successful-copy" && scenario !== "edits-during-save") {
          check(!ok, "Failed/cancelled save reported success");
          const draft = s.getState().docs.find(d => d.id === source);
          check(draft?.path === null && draft.content === "Source unsaved writing", "Failure changed source association or text");
          check(s.getState().goals["draft:" + source] === 1234 && !s.getState().goals[path], "Failure moved goal");
          const disk = (await p.fsApi.readText(path)).content;
          check(disk === (scenario === "changed-destination" ? "External writing" : originalBytes), "Failed/cancelled operation changed disk");
        } else {
          check(ok, "Successful copy reported failure");
          const copy = s.getState().docs.find(d => d.id === s.getState().activeId);
          check(copy?.id !== source && copy.path === path, "Distinct copy did not commit a new identity");
          check(copy.savedContent === "Source unsaved writing" && other.conflict, "Saved baseline or destination conflict incorrect");
          if (scenario === "edits-during-save") {
            check(copy.content === "Source writing edited during save" && s.isDirty(copy), "Concurrent edits were marked saved or lost");
            check((await p.fsApi.readText(path)).content === "Source unsaved writing", "Save committed different bytes from captured snapshot");
          }
          check(s.getState().goals[path] === 1234 && !s.getState().goals["draft:" + source], "Success failed to move goal");
          const view = bridge.view;
          const prior = view.state.doc.toString();
          view.dispatch({ changes: { from: view.state.doc.length, insert: " after Save As" }, userEvent: "input.type" });
          check(s.getState().docs.find(d => d.id === copy.id).content === prior + " after Save As", "Editor continued updating retired identity");
          view.focus();
          commandById.get("undo").run();
          check(s.getState().docs.find(d => d.id === copy.id).content === prior, "Undo did not update new identity");
        }
        return { scenario, passed: true };
      }, scenario);
      assert.deepEqual(errors, [], "Browser runtime errors");
      console.log(JSON.stringify({ surface: "isolated browser/frontend", ...result }));
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
