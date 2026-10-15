// Windows WebView2 integration in an explicitly isolated invisible test app.
// Requires a separately built executable with the supplied TAURI_CONFIG compiled in.
// Never launches or terminates an installed editor; only the process spawned here is killed.
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
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

// Independent fixture oracle: known UTF-16 positions, never production matching.
const corpora=[], measurements=[];
const powershell = source => new Promise((resolve,reject) => execFile("powershell.exe",["-NoProfile","-NonInteractive","-Command",source],{windowsHide:true,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(JSON.parse(stdout))));
const hardware=await powershell("$taskOs=Get-CimInstance Win32_OperatingSystem; $taskCpu=Get-CimInstance Win32_Processor; $taskComputer=Get-CimInstance Win32_ComputerSystem; @{os=$taskOs.Caption;build=$taskOs.BuildNumber;cpu=@($taskCpu.Name);logicalProcessors=$taskComputer.NumberOfLogicalProcessors;ramBytes=$taskComputer.TotalPhysicalMemory;node=$env:NODE_VERSION} | ConvertTo-Json -Compress");
hardware.node=process.version;
async function footprint() {
  // Native process counters are cumulative; WebView renderer JS heap is a
  // separate surface. These do not establish whole-app worst-case memory.
  const native=await powershell("$taskProcess=Get-Process -Id "+Number(child.pid)+"; @{pid=$taskProcess.Id;workingSetBytes=$taskProcess.WorkingSet64;privateBytes=$taskProcess.PrivateMemorySize64;cumulativePeakWorkingSetBytes=$taskProcess.PeakWorkingSet64} | ConvertTo-Json -Compress");
  const session=await browser.contexts()[0].newCDPSession(page);
  try {await session.send("Performance.enable");const m=await session.send("Performance.getMetrics");return {native,rendererMetrics:Object.fromEntries(m.metrics.filter(x=>["JSHeapUsedSize","JSHeapTotalSize","Nodes","Documents"].includes(x.name)).map(x=>[x.name,x.value]))};}
  finally {await session.detach();}
}
async function generate(documents,fileBytes,stride) {
  const root=path.join(files,"corpus-"+documents);await mkdir(root);
  const oracle=[];let bytes=0;
  for(let n=0;n<documents;n++) {
    const relative=`group-${n%20}-α/item-${Math.floor(n/20)}/Writing.md`;
    const destination=path.join(root,...relative.split("/"));await mkdir(path.dirname(destination),{recursive:true});
    const prefix=`🙂 e\u0301 שלום writing ${n}\n`;
    let text=prefix+(n%stride===0?"unique-needle":"");
    if(n%stride===0)oracle.push([relative,prefix.length,prefix.length+13]);
    if(n%3===0)text=text.replaceAll("\n","\r\n");
    if(n%5===0)text="\ufeff"+text;
    const remaining=fileBytes-Buffer.byteLength(text);assert(remaining>=0);text+="x".repeat(remaining);
    const content=Buffer.from(text);assert.equal(content.length,fileBytes);await writeFile(destination,content);bytes+=content.length;
    if((n+1)%1000===0)console.log(JSON.stringify({fixtureGeneration:documents,completed:n+1}));
  }
  const corpus={root,documents,fileBytes,stride,bytes,oracle};corpora.push(corpus);return corpus;
}
function verifyOracle(corpus,result) {
  assert(result.coverage && !result.coverage.partial && !result.coverage.cancelled && !result.resultLimited,"Search must report complete coverage");
  assert.equal(result.coverage.scanned,corpus.documents);assert.equal(result.coverage.bytesRead,corpus.bytes);
  const expected=new Map(corpus.oracle.map(([name,from,to])=>[name,[from,to]]));
  assert.equal(result.hits.length,expected.size);assert.equal(new Set(result.hits.map(h=>h.relativePath)).size,expected.size);
  for(const hit of result.hits){assert.deepEqual([hit.from,hit.to],expected.get(hit.relativePath),"Exact independent UTF16 oracle "+hit.relativePath);assert.equal(hit.line,2);assert.equal(hit.source,"disk");}
}
async function measureNative(corpus,caseSensitive,cancel=false) {
  return page.evaluate(async ({root,caseSensitive,cancel})=>{
    const {invoke}=await import("/node_modules/@tauri-apps/api/core.js");
    const {listen}=await import("/node_modules/@tauri-apps/api/event.js");
    const queryId=crypto.randomUUID();let started,firstMs=null,coverage,resultLimited,completeEventMs,cancelAt=null,cancelAckMs=null,cancelPromise;
    let profileResolve;const profile=new Promise(resolve=>profileResolve=resolve);
    const unlistenProfile=await listen("ambertext:hidden-search-profile",({payload:p})=>{if(p.queryId===queryId)profileResolve(p);});
    let completeResolve;const complete=new Promise(resolve=>completeResolve=resolve);const hits=[];
    const unlisten=await listen("ambertext:workspace-search",({payload:e})=>{
      if(e.queryId!==queryId || e.root!==root)return;
      if(e.hits.length&&firstMs===null){firstMs=performance.now()-started;if(cancel){cancelAt=performance.now();cancelPromise=invoke("workspace_search_cancel").then(()=>cancelAckMs=performance.now()-cancelAt);}}
      hits.push(...e.hits);coverage=e.coverage;resultLimited=e.resultLimited;
      if(e.complete){completeEventMs=performance.now()-started;completeResolve();}
    });
    started=performance.now();
    try {await invoke("workspace_search",{request:{root,queryId,query:"unique-needle",caseSensitive,wholeWord:false,overlays:[]}});
      const commandCompleteMs=performance.now()-started;
      // Capture command settlement before awaiting the diagnostic event delivery.
      const workerSettledAfterCancelMs=cancelAt===null?null:performance.now()-cancelAt;
      let profileTimer,phases;
      try {phases=await Promise.race([profile,new Promise((_,reject)=>profileTimer=setTimeout(()=>reject(Error("Native phase event missing after command settlement")),5000))]);}
      finally {clearTimeout(profileTimer);}
      const {read_details,...stageTimes}=phases.measurements;
      for(const value of [...Object.values(stageTimes),...Object.values(read_details??{}),phases.workerWaitMs,phases.workerRunMs,phases.emitMs])assertFinite(value);
      if(cancel){if(cancelPromise)await cancelPromise;return {firstMs,commandCompleteMs,cancelAckMs,workerSettledAfterCancelMs,hitsReceived:hits.length,phases};}
      await complete;return {firstMs,commandCompleteMs,completeEventMs,coverage,resultLimited,hits,phases};
    } finally {unlisten();unlistenProfile();}
    function assertFinite(value){if(!Number.isFinite(value)||value<0)throw Error("Invalid native phase duration");}
  },{root:corpus.root,caseSensitive,cancel});
}
async function until(predicate,description,timeout=120000) {const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await predicate())return;await pause(25);}throw Error("Timed out waiting for "+description);}
try {
  await launch();await pause(3500);await assertInvisible();passed("invisible-native-search-startup");
  await page.evaluate(async ()=> (await import("/src/state/store.ts")).getState().setSettings({historyEnabled:false,autosave:false}));
  for(const dimensions of [[1000,26214,1],[10000,220,10]]) {
    const corpus=await generate(...dimensions);
    for(let pass=0;pass<4;pass++) {
      const before=await footprint(), result=await measureNative(corpus,pass<2),after=await footprint();
      verifyOracle(corpus,result);
      const {hits,...metrics}=result;measurements.push({documents:corpus.documents,corpusBytes:corpus.bytes,pass,caseSensitive:pass<2,cache:pass===0?"First query of newly generated copied files; OS cache uncontrolled":"Repeated query; OS cache uncontrolled; no app index",...metrics,before,after});
      passed("native-ipc-oracle-"+corpus.documents+"-pass-"+pass,{firstMs:result.firstMs,completeMs:result.completeEventMs,hits:hits.length,scanned:result.coverage.scanned});
      await writeFile(path.join(fixtureRoot,"measurements.partial.json"),JSON.stringify(measurements,null,2)+"\n");
    }
    const cancellation=await measureNative(corpus,true,true);assert.notEqual(cancellation.cancelAckMs,null);assert(cancellation.hitsReceived<corpus.oracle.length,"Cancellation must stop before full corpus results");
    measurements.push({documents:corpus.documents,cancellation});passed("native-ipc-cancellation-"+corpus.documents,cancellation);
  }
  const corpus=corpora[0];
  await page.evaluate(async root=>{const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts");await a.openFolder(root);s.getState().setSettings({sidebarOpen:true,sidebarTab:"search"});},corpus.root);
  const input=page.getByLabel("Find in folder");await input.waitFor();await page.getByRole("checkbox",{name:"Match case",exact:true}).check();
  await page.evaluate(async ()=>{
    const w=await import("/src/lib/workspaceSearch.ts");window.nativeUiSearch={started:null,firstEventMs:null,firstDomMs:null,completeMs:null};
    document.querySelector("#workspace-query").addEventListener("input",()=>window.nativeUiSearch.started=performance.now(),{once:true});
    window.nativeUiSearchUnlisten=w.useWorkspaceSearch.subscribe(s=>{const p=window.nativeUiSearch;if(p.started===null)return;if(s.hits.length&&p.firstEventMs===null)p.firstEventMs=performance.now()-p.started;if(s.queryId&&!s.busy&&!s.stale)p.completeMs=performance.now()-p.started;});
    window.nativeUiSearchObserver=new MutationObserver(()=>{const p=window.nativeUiSearch;if(p.started!==null&&p.firstDomMs===null&&document.querySelector("[data-search-result]"))requestAnimationFrame(()=>p.firstDomMs??=performance.now()-p.started);});
    window.nativeUiSearchObserver.observe(document.querySelector(".workspace-search"),{childList:true,subtree:true});
  });
  await input.fill("unique-needle");
  await until(()=>page.evaluate(async()=>{const s=(await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState();return !!s.queryId&&!s.busy&&!s.stale&&s.hits.length===1000;}),"mounted native search completion");
  const mounted=await page.evaluate(async()=>{const s=(await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState();window.nativeUiSearchUnlisten();window.nativeUiSearchObserver.disconnect();return {...window.nativeUiSearch,coverage:s.coverage,hits:s.hits,resultLimited:s.resultLimited};});
  verifyOracle(corpus,mounted);assert.notEqual(mounted.firstDomMs,null);measurements.push({surface:"Mounted native panel; includes200ms query debounce and next-frame DOM observation",...mounted,hits:mounted.hits.length});passed("mounted-native-panel-oracle-and-first-dom-result",{firstEventMs:mounted.firstEventMs,firstDomMs:mounted.firstDomMs,completeMs:mounted.completeMs});
  await page.locator("[data-search-result]").first().click();
  await until(()=>page.evaluate(async()=>{const b=(await import("/src/editor/bridge.ts")).bridge;return b.view&&b.view.state.sliceDoc(b.view.state.selection.main.from,b.view.state.selection.main.to)==="unique-needle";}),"exact native result navigation");
  passed("native-result-navigation-exact-unicode-position");
  const typing=await page.evaluate(async()=>{const s=await import("/src/state/store.ts"),b=(await import("/src/editor/bridge.ts")).bridge;const doc=s.activeDoc();b.view.dispatch({selection:{anchor:0}});return {id:doc.id,path:doc.path,before:doc.content,saved:doc.savedContent};});
  const original=await readFile(typing.path);
  await page.getByRole("button",{name:"Search again",exact:true}).click();
  await until(()=>page.evaluate(async()=> (await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState().busy),"native scan before actual fixture typing");
  await page.locator(".cm-content").focus();const typingStart=performance.now();await page.keyboard.type("Actual typing ");const typingMs=performance.now()-typingStart;
  const afterTyping=await page.evaluate(async id=>{const s=(await import("/src/state/store.ts")).getState(),w=(await import("/src/lib/workspaceSearch.ts")).useWorkspaceSearch.getState();const d=s.docs.find(d=>d.id===id);return {text:d.content,saved:d.savedContent,stale:w.stale,busy:w.busy};},typing.id);
  assert.equal(afterTyping.text,"Actual typing "+typing.before);assert.equal(afterTyping.saved,typing.saved);assert(afterTyping.stale&&!afterTyping.busy,"Editing the searched buffer must fence old results");assert.deepEqual(await readFile(typing.path),original,"Typing fixture must not silently save");
  measurements.push({surface:"Scoped native WebView CDP keyboard typing during native scan; expected source edit invalidates/cancels scan",typingMs,characters:14});passed("native-typing-continuity-and-query-invalidation-without-autosave",{typingMs});
  await assertInvisible();await page.screenshot({path:path.join(fixtureRoot,"native-search.png")});
} catch(error) {if(page&&!page.isClosed())await page.screenshot({path:path.join(fixtureRoot,"failure.png")}).catch(()=>{});results.push({passed:false,error:String(error)});throw error;}
finally {await killOwned();await writeFile(path.join(fixtureRoot,"results.json"),JSON.stringify({surface:"Debug Windows native Tauri/WebView2 IPC and copied NTFS corpora",hardware,userAgent,executableSha256:createHash("sha256").update(executableBytes).digest("hex"),results,measurements,windowChecks,pageErrors,corpora:corpora.map(({oracle,...rest})=>({...rest,expectedHits:oracle.length})),limitations:["Debug native app, not optimized packaged performance", "Freshly generated and repeated queries; OS cache not controlled, no proven cold disk", "Native process cumulative peak and before/after snapshots plus renderer JS heap; not whole-app peak or worst-case bound", "Mounted DOM timing includes200ms debounce; not physical screen paint", "Scoped CDP keyboard input, not physical keyboard or IME", "Candidate300ms/2s/200ms targets remain proposals", "Regex policy, full coverage/provider/platform/assistive gates remain open"]},null,2)+"\n");}
