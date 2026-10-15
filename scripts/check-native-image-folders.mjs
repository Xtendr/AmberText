// Windows WebView2 integration in an explicitly isolated invisible test app.
// Requires a separately built executable with the supplied TAURI_CONFIG compiled in.
// Never launches or terminates an installed editor; only the process spawned here is killed.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
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
await assert.rejects(stat(profile), { code: "ENOENT" });
const documentPath = path.join(files, "copied-writing.md");
const deletedPath = path.join(files, "deleted-fixture.md");
await writeFile(documentPath, Buffer.from("\ufeffFirst saved line\r\nSecond æ line", "utf8"));
await writeFile(deletedPath, "Saved missing-file baseline");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, page;
const results = [];
const windowChecks = [], pageErrors = [];
const imageDecodes = [];
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
  const writingPath=path.join(files,"Chapter æ #% [draft].md"),oldImage=path.join(files,"assets","old.png"),source=path.join(fixtureRoot,"imports","image # (æ).png");
  const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=","base64");
  const original=Buffer.from("\ufeffWriting æ\r\n\r\n![existing](assets/old.png)","utf8");
  const consumerPath=path.join(files,"Consumer.md"),consumerBytes=Buffer.from("\ufeff---\r\nexample: assets/never.png\r\n---\r\n![shared][pic] and [linked][pic]\r\n\r\n[pic]: assets/old.png?view=x#crop\r\n\r\n![missing](assets/absent.png)\r\n![outside](../imports/image%20%23%20%28%C3%A6%29.png)\r\n`![code](assets/never.png)`","utf8");
  await mkdir(path.dirname(oldImage),{recursive:true});await mkdir(path.dirname(source),{recursive:true});
  await writeFile(writingPath,original);await writeFile(oldImage,image);await writeFile(source,image);await writeFile(consumerPath,consumerBytes);
  await launch();await pause(3500);await assertInvisible();
  assert.equal(await page.evaluate(async()=>(await import("/src/state/store.ts")).getState().settings.imageFolder),"shared");
  await page.evaluate(async file=>{const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts");s.getState().setSettings({historyEnabled:false,autosave:false,livePreview:false});await a.openPath(file);},writingPath);
  async function until(predicate,description){const deadline=Date.now()+10000;while(Date.now()<deadline){if(await predicate())return;await pause(25);}throw Error("Timed out: "+description);}
  await until(()=>page.evaluate(async file=>{const s=await import("/src/state/store.ts"),{bridge}=await import("/src/editor/bridge.ts");return s.activeDoc()?.path===file&&bridge.viewDocId===s.activeDoc()?.id;},writingPath),"native copied document binding");
  const initial=await page.evaluate(async()=>(await import("/src/state/store.ts")).activeDoc().content);
  const created=[];
  async function references(){return page.evaluate(async()=>{const s=await import("/src/state/store.ts"),r=await import("/src/lib/markdownReferences.ts");const d=s.activeDoc();return{path:d.path,text:d.content,references:r.parseMarkdownReferences(d.content).references.map(ref=>({target:ref.target,path:r.resolveReferenceTarget(ref.target,d.path).path}))};});}
  async function paste(){await page.evaluate(async data=>{const a=await import("/src/state/actions.ts"),{bridge}=await import("/src/editor/bridge.ts");bridge.view.dispatch({selection:{anchor:bridge.view.state.doc.length}});const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));await a.pasteImage(bridge.view,[new File([bytes],"copied.png",{type:"image/png"})]);},image.toString("base64"));}
  async function importSource(from){await page.evaluate(async from=>{const a=await import("/src/state/actions.ts"),{bridge}=await import("/src/editor/bridge.ts");bridge.view.dispatch({selection:{anchor:bridge.view.state.doc.length}});await a.insertImageFiles(bridge.view,[from]);},from);}
  async function lastImage(expectedDir){const info=await references(),last=info.references.at(-1);assert.equal(path.dirname(last.path),expectedDir);assert.deepEqual(await readFile(last.path),image);assert.equal(info.references[0].target,"assets/old.png");created.push(last.path);return last.path;}
  async function choose(value){await page.evaluate(async()=> (await import("/src/state/store.ts")).setState({settingsOpen:true,settingsSection:"editor"}));const select=page.getByRole("combobox",{name:"New image folders"});await select.selectOption(value);assert.equal(await select.inputValue(),value);await page.keyboard.press("Escape");}
  await paste();await lastImage(path.join(files,"assets"));passed("native-shared-default-exact-pasted-image-and-reference");
  const moduleUrl=await page.evaluate(()=>performance.getEntriesByType("resource").map(e=>e.name).find(name=>new URL(name).pathname.endsWith("/@codemirror_commands.js")));
  assert(moduleUrl);assert.equal(await page.evaluate(async url=>{const{bridge}=await import("/src/editor/bridge.ts");return(await import(url)).undo(bridge.view);},moduleUrl),true);assert.equal((await references()).text,initial);passed("native-image-insertion-undo-preserves-writing-and-created-file");
  await choose("document");const documentDir=path.join(files,"Chapter æ #% [draft].assets");await paste();await lastImage(documentDir);await importSource(source);const firstCopy=await lastImage(documentDir);assert.equal(path.basename(firstCopy),path.basename(source));passed("native-document-folder-paste-import-unicode-encoded-paths");
  await importSource(source);const collisionCopy=await lastImage(documentDir);assert.notEqual(collisionCopy,firstCopy);assert.deepEqual(await readFile(firstCopy),image);passed("native-existing-image-collision-keeps-both-exact-files");
  const beforeNames=await readdir(documentDir);await importSource(oldImage);const reused=(await references()).references.at(-1);assert.equal(path.resolve(reused.path),oldImage);assert.deepEqual(await readdir(documentDir),beforeNames);passed("native-existing-inside-folder-image-stays-in-place");
  const batch=await page.evaluate(async from=>{
    const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts"),p=await import("/src/lib/platform.ts"),{bridge}=await import("/src/editor/bridge.ts");
    const actual=p.fsApi.copyFile,committed=[],attempts=[];
    // Timing hook delegates to real native IO; no receipt or binary success mocked.
    p.fsApi.copyFile=async(source,target)=>{attempts.push(target);const revision=await actual(source,target);committed.push(target);if(committed.length===1)s.getState().setSettings({imageFolder:"shared"});return revision;};
    try{bridge.view.dispatch({selection:{anchor:bridge.view.state.doc.length}});await a.insertImageFiles(bridge.view,[from,from]);return{committed,attempts,toasts:s.getState().toasts.map(t=>t.message)};}finally{p.fsApi.copyFile=actual;}
  },source);
  assert.equal(batch.committed.length,2,JSON.stringify(batch));for(const file of batch.committed){assert.equal(path.dirname(file),documentDir);assert.deepEqual(await readFile(file),image);created.push(file);}passed("native-batch-captures-one-folder-through-setting-change-and-collisions");
  const doc=await page.evaluate(async()=>{const s=await import("/src/state/store.ts");return{id:s.activeDoc().id,text:s.activeDoc().content};});
  await choose("document");await page.evaluate(async()=>{if(!await(await import("/src/state/actions.ts")).flushRecovery())throw Error("Fixture recovery flush failed");});await assertInvisible();await killOwned();await launch();await pause(3500);
  await until(()=>page.evaluate(async id=>(await import("/src/state/store.ts")).activeDoc()?.id===id,doc.id),"recovered image fixture after owned restart");
  assert.deepEqual(await page.evaluate(async()=>{const s=await import("/src/state/store.ts");return[s.getState().settings.imageFolder,s.activeDoc().content];}),["document",doc.text]);passed("native-owned-process-restart-keeps-folder-choice-and-unsaved-image-links");
  await page.evaluate(async file=>{const a=await import("/src/state/actions.ts");await a.renameEntry(file,"Renamed.md");},writingPath);
  const renamed=path.join(files,"Renamed.md");assert.equal((await references()).path,renamed);assert.deepEqual(await readFile(renamed),original);await paste();await lastImage(path.join(files,"Renamed.assets"));
  const renamedRefs=await references();for(const ref of renamedRefs.references)assert.deepEqual(await readFile(ref.path),image);passed("native-rename-uses-new-folder-for-future-images-keeps-prior-references");
  const draft=await page.evaluate(async()=>{const a=await import("/src/state/actions.ts");return a.newDoc("Unsaved image draft");});
  await until(()=>page.evaluate(async id=>(await import("/src/editor/bridge.ts")).bridge.viewDocId===id,draft),"native unsaved draft editor");
  await paste();assert.deepEqual(await page.evaluate(async()=>{const s=await import("/src/state/store.ts");return[s.activeDoc().content,s.getState().toasts.some(t=>/Save this document first/.test(t.message))];}),["Unsaved image draft",true]);passed("native-document-folder-draft-retains-save-first-guidance");
  assert.deepEqual(await readFile(renamed),original);assert.deepEqual(await readFile(oldImage),image);assert.deepEqual(await readFile(source),image);for(const file of created)assert.deepEqual(await readFile(file),image);passed("native-canonical-writing-existing-images-and-sources-unchanged");
  await page.evaluate(async()=> (await import("/src/state/store.ts")).setState({settingsOpen:true,settingsSection:"editor"}));
  await page.getByRole("combobox",{name:"New image folders"}).waitFor();
  const geometry=await page.getByRole("combobox",{name:"New image folders"}).evaluate(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e};});
  assert(geometry.x>=0&&geometry.y>=0&&geometry.right<=geometry.viewport[0]&&geometry.bottom<=geometry.viewport[1]&&geometry.hit);passed("native-folder-select-within-settings-and-hittable",geometry);
  await assertInvisible();await page.screenshot({path:path.join(fixtureRoot,"native-image-folders.png")});
  await page.keyboard.press("Escape");
  await page.evaluate(async({root,renamed})=>{const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts");await a.openPath(renamed);await a.openFolder(root);s.getState().setSettings({sidebarOpen:true,sidebarTab:"files"});}, {root:files,renamed});
  await page.evaluate(async()=>(await import("/src/state/store.ts")).setState({assetsOpen:true}));const panel=page.getByRole("dialog",{name:"Images and links",exact:true});await panel.waitFor();
  const checkFolder=panel.getByRole("button",{name:"Check images and links",exact:true});await checkFolder.focus();await page.keyboard.press("Space");
  await until(()=>page.evaluate(async()=>{const d=(await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState();return!d.busy&&!d.stale&&d.coverage.scanned===4;}),"mounted native reference catalogue/reads/targets");
  const diagnostics=await page.evaluate(async()=> (await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState());
  assert.equal(diagnostics.error,null);assert.equal(diagnostics.coverage.partial,false);assert.equal(diagnostics.coverage.cancelled,false);
  assert.equal(diagnostics.records.filter(r=>r.status==="missing").length,1);assert(!diagnostics.records.some(r=>r.target.includes("never.png")));
  const shared=diagnostics.records.filter(r=>r.target.startsWith("assets/old.png"));assert.equal(shared.length,4);assert(shared.every(r=>r.status==="present"&&r.uses===4&&r.documents===2&&r.canonicalPath===shared[0].canonicalPath));
  assert(diagnostics.records.some(r=>r.sourcePath===renamed&&r.source==="buffer"&&r.target.startsWith("Renamed.assets/")));assert(diagnostics.records.some(r=>r.outside&&r.status==="present"));
  passed("mounted-native-image-diagnostics-shared-missing-outside-unsaved-and-code-exclusions",{scanned:diagnostics.coverage.scanned,records:diagnostics.records.length});
  assert.deepEqual(await readFile(consumerPath),consumerBytes);assert.deepEqual(await readFile(renamed),original);assert.deepEqual(await readFile(oldImage),image);assert.deepEqual(await readFile(firstCopy),image);
  await page.locator(".cm-content").focus();await page.keyboard.type("Later writing ");
  const stale=await page.evaluate(async()=>{const d=(await import("/src/lib/assetDiagnostics.ts")).useAssetDiagnostics.getState(),s=await import("/src/state/store.ts");return{diagnostics:d.stale,text:s.activeDoc().content};});assert(stale.diagnostics&&stale.text.includes("Later writing "));
  assert.deepEqual(await readFile(renamed),original);assert.deepEqual(await readFile(consumerPath),consumerBytes);for(const file of created)assert.deepEqual(await readFile(file),image);
  passed("native-read-only-scan-invalidated-by-later-edit-with-all-originals-retained");
  await assertInvisible();await page.screenshot({path:path.join(fixtureRoot,"native-asset-diagnostics.png")});
  await page.evaluate(async()=> (await import("/src/state/store.ts")).getState().setSettings({viewMode:"read"}));
  await until(()=>page.locator(".prose img").count().then(n=>n===renamedRefs.references.length),"native rendered image references");
  const rendered=await page.locator(".prose img").evaluateAll(async images=>Promise.all(images.map(async image=>{image.loading="eager";let error=null;try{await image.decode();}catch(e){error=String(e);}return{src:image.src,width:image.naturalWidth,height:image.naturalHeight,error};})));
  imageDecodes.push({surface:"Native Preview",images:rendered});
  assert(rendered.every(image=>image.width===1&&image.height===1&&!image.error),JSON.stringify(rendered));passed("native-preview-decodes-every-copied-and-existing-png",{images:rendered.length});
  await page.evaluate(async()=>{const s=await import("/src/state/store.ts");s.getState().setSettings({viewMode:"write",livePreview:true});});
  // CodeMirror also uses empty IMG caret buffers; those are not writing images.
  await until(()=>page.locator(".cm-image img").count().then(n=>n===renamedRefs.references.length),"every native live image widget");
  const widgets=await page.locator(".cm-image img").evaluateAll(async images=>Promise.all(images.map(async image=>{let error=null;try{await image.decode();}catch(e){error=String(e);}return{src:image.src,width:image.naturalWidth,height:image.naturalHeight,error};})));
  imageDecodes.push({surface:"Native live editor image widgets",images:widgets});
  assert(widgets.every(image=>image.width===1&&image.height===1&&!image.error),JSON.stringify(widgets));passed("native-live-editor-image-widgets-decode-copied-pngs",{images:widgets.length});
} catch(error){if(page&&!page.isClosed())await page.screenshot({path:path.join(fixtureRoot,"failure.png")}).catch(()=>{});results.push({passed:false,error:String(error)});throw error;}
finally{await killOwned();await writeFile(path.join(fixtureRoot,"results.json"),JSON.stringify({surface:"Invisible debug Windows Tauri/WebView2 + copied NTFS PNG and Markdown fixtures",userAgent,executableSha256:createHash("sha256").update(executableBytes).digest("hex"),results,windowChecks,pageErrors,imageDecodes,limitations:["Scoped native DOM input, not physical keyboard/IME or assistive technology","Owned disposable profile, not installed profile migration or macOS","Batch timing hook delegates to actual native copy; no binary success mocked","Save As/relocation portability and shared-asset mutation are separate unfinished tickets"]},null,2)+"\n");}
