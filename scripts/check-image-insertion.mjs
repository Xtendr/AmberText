// Hidden real editor/controller checks. Binary writes are simulated only in
// successful browser cases; exact native binary bytes have Rust fixtures.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url = process.env.AMBERTEXT_TEST_URL || "http://127.0.0.1:1430";
const scenarios = ["paste", "import", "inside-existing", "collision", "collision-limit", "partial-batch", "tab-switch", "typing", "path-change", "collision-switch", "missing-inside", "empty-receipt", "draft", "browser-refusal", "invalid-position", "wrong-view", "focus-change", "focus-change-paste"];
const selected = process.env.AMBERTEXT_SCENARIO ? scenarios.filter(s => s === process.env.AMBERTEXT_SCENARIO) : scenarios;
assert.ok(selected.length, "Unknown image insertion scenario");
const browser = await chromium.launch({ channel: "msedge", headless: true });
try { for (const scenario of selected) {
  const context = await browser.newContext(), errors = [], network = [];
  try {
    await context.route("**/*", route => { const target = new URL(route.request().url()); if (/^https?:$/.test(target.protocol) && target.origin !== new URL(url).origin) { network.push(target.href); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
    await page.goto(url); await page.waitForSelector(".cm-content");
    const evidence = await page.evaluate(async scenario => {
      const a = await import("/src/state/actions.ts"), s = await import("/src/state/store.ts"), p = await import("/src/lib/platform.ts"), refs = await import("/src/lib/markdownReferences.ts"), lp = await import("/src/editor/livePreview.ts");
      const bridge = (await import("/src/editor/bridge.ts")).bridge;
      const check = (value, message) => { if (!value) throw new Error(message); }, wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const focusing = scenario.startsWith("focus-change");
      s.getState().setSettings({ autosave:false, historyEnabled:false, livePreview:focusing, viewMode:"write" });
      const root = "/Users/you/Notes/images-" + scenario, path = root + "/Writing.md", second = root + "/Second.md";
      const original = "Writing\n\n![existing](assets/old.png)", source = "/Users/you/Imports/a] #? (æ).png", old = root + "/assets/old.png";
      await p.fsApi.createFile(path, original); await p.fsApi.createFile(second, "Second writing"); await p.fsApi.createFile(source, "Simulated copied bytes"); await p.fsApi.createFile(old, "Original image fixture");
      const id = await a.openPath(path); for (let n = 0; n < 100 && bridge.viewDocId !== id; n++) await wait(10);
      check(bridge.viewDocId === id, "Editor fixture unavailable"); const view = bridge.view;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      if (focusing) { view.focus(); await wait(30); }
      // Focus leaving and returning (file picker, sidebar, Alt-Tab) replaces the editor state without changing writing or selection.
      let realFocusChange = null;
      const focusShift = async () => {
        const prior = view.state, text = prior.doc.toString(), selection = prior.selection;
        view.contentDOM.blur(); await wait(30); view.focus(); await wait(30);
        realFocusChange = view.state !== prior;
        if (!realFocusChange) view.dispatch({ effects: lp.syncFocus(view) });
        check(view.state !== prior && view.state.doc.toString() === text && view.state.selection.eq(selection), "Focus fixture did not isolate a state-only change");
      };
      const attempts = [], created = [], realCreate = p.fsApi.createFile, realRead = p.fsApi.readText;
      const receipt = async target => (await realRead(target)).revision;
      const write = async (target, data) => { attempts.push(target); if (await p.fsApi.exists(target)) throw { kind:"conflict", message:"Owned collision fixture" }; await realCreate(target, data); created.push(target); if (focusing) await focusShift(); return receipt(target); };
      let copies = 0;
      const copy = async (from, target) => {
        copies++;
        if (scenario === "collision-limit") { attempts.push(target); throw {kind:"conflict",message:"Injected repeated collision"}; }
        if (scenario === "partial-batch" && copies === 2) { attempts.push(target); throw {kind:"permission",message:"Injected permission denial"}; }
        if (scenario === "collision-switch" && copies === 1) { attempts.push(target); await a.openPath(second); throw {kind:"conflict",message:"Injected delayed collision"}; }
        const result = await write(target, (await realRead(from)).content);
        if (scenario === "tab-switch") { await a.openPath(second); for (let n = 0; n < 100 && bridge.viewDocId === id; n++) await wait(10); }
        if (scenario === "typing") view.dispatch({ changes:{ from:view.state.doc.length, insert:" Later writing" } });
        if (scenario === "path-change") s.setState(state => ({ docs:state.docs.map(doc => doc.id === id ? {...doc,path:root+"/Renamed.md"} : doc) }));
        return scenario === "empty-receipt" ? undefined : result;
      };
      if (scenario !== "browser-refusal") { p.fsApi.writeBase64 = write; p.fsApi.copyFile = copy; }
      const file = new File([new Uint8Array([0,1,255])], "copied.png", {type:"image/png"});
      if (scenario === "collision") await realCreate(root + "/assets/a] #? (æ).png", "Existing collision stays");
      if (scenario === "draft") { const draft = a.newDoc("Draft writing"); for (let n = 0; n < 100 && bridge.viewDocId !== draft; n++) await wait(10); await a.pasteImage(bridge.view, [file]); check(s.getState().docs.find(d => d.id === draft).content === "Draft writing" && !attempts.length && s.getState().toasts.some(t => /Save this document first/.test(t.message)), "Source-less draft wrote or lost save guidance"); return; }
      if (scenario === "wrong-view") { await a.pasteImage({}, [file]); check(!attempts.length, "Wrong editor view created assets"); return; }
      if (scenario === "paste" || scenario === "focus-change-paste") await a.pasteImage(view, scenario === "paste" ? [file, file] : [file]);
      else if (scenario === "browser-refusal") { await a.pasteImage(view,[file]); await a.insertImageFiles(view,[source]); }
      else await a.insertImageFiles(view, scenario === "partial-batch" ? [source,source] : [scenario === "inside-existing" ? old : scenario === "missing-inside" ? root+"/missing.png" : source], scenario === "invalid-position" ? -1 : undefined);
      const doc = s.getState().docs.find(d => d.id === id), parsed = refs.parseMarkdownReferences(doc.content);
      if (["tab-switch","typing","path-change","collision-switch","missing-inside","empty-receipt","browser-refusal","invalid-position","collision-limit"].includes(scenario)) {
        check(doc.content === original + (scenario === "typing" ? " Later writing" : ""), "Failed/stale import changed writing");
        if (["tab-switch","typing","path-change"].includes(scenario)) check(created.length === 1 && s.getState().toasts.some(t => /saved images remain/.test(t.message)), "Interrupted successful copy was deleted or unreported");
        if (["tab-switch","typing","path-change","collision-switch"].includes(scenario)) check(s.getState().toasts.length === 1, "Interrupted insert showed more than one message: " + JSON.stringify(s.getState().toasts.map(t => t.message)));
        if (scenario === "tab-switch" || scenario === "collision-switch") check(s.getState().docs.find(d => d.path === second).content === "Second writing", "Slow image entered wrong tab");
        if (scenario === "collision-switch") check(attempts.length === 1 && created.length === 0, "Ownership changed but collision retry still wrote");
        if (scenario === "collision-limit") check(attempts.length === 10 && created.length === 0 && s.getState().toasts.some(t => /kept colliding/.test(t.message)), "Collision retries were unbounded or hidden");
        if (scenario === "browser-refusal") { check(created.length === 0 && s.getState().toasts.some(t => /desktop app/.test(t.message)), "Browser no-op falsely reported image success"); for (const operation of [() => p.fsApi.writeBase64(root+"/never.png","AA=="), () => p.fsApi.copyFile(source,root+"/never.png")]) { let refused=false; try { await operation(); } catch(e) { refused=e.kind === "unsupported"; } check(refused, "Browser binary API silently succeeded"); } }
      } else {
        const expected = scenario === "paste" ? 3 : 2;
        if (focusing) check(created.length === 1 && !s.getState().toasts.length, "Focus change cancelled the image insert: " + JSON.stringify(s.getState().toasts.map(t => t.message)));
        check(parsed.references.length === expected && parsed.references.every(r => r.kind === "image"), "Image insertion corrupted Markdown reference syntax");
        const added = parsed.references.slice(1);
        for (const reference of added) { const resolved = refs.resolveReferenceTarget(reference.target,path); check(resolved.path === (scenario === "inside-existing" ? old : created[added.indexOf(reference)]), "Inserted path does not point at created/selected image"); }
        if (scenario === "collision") check(attempts.length === 2 && (await realRead(root+"/assets/a] #? (æ).png")).content === "Existing collision stays", "Collision clobbered prior image");
        if (scenario === "inside-existing") check(!attempts.length, "Existing image was automatically relocated");
        if (scenario === "paste") { check(created.length === 2 && new Set(created).size === 2, "Pasted image names collided"); const commandsUrl = performance.getEntriesByType("resource").map(e=>e.name).find(name=>new URL(name).pathname.endsWith("/@codemirror_commands.js")); check(commandsUrl,"Loaded editor command module unavailable"); const {undo}=await import(commandsUrl); check(undo(view) && view.state.doc.toString() === original, "Image batch is not one Undo step"); }
      }
      check((await realRead(path)).content === original && (await realRead(old)).content === "Original image fixture" && (await realRead(source)).content === "Simulated copied bytes", "Image insertion changed saved writing or existing sources");
      return focusing ? { realFocusChange } : null;
    }, scenario);
    assert.deepEqual(errors, []); assert.deepEqual(network, []); console.log("PASS " + scenario + (evidence ? " " + JSON.stringify(evidence) : ""));
  } finally { await context.close(); }
} } finally { await browser.close(); }
