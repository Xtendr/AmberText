// Headless actual search/controller/editor fixtures; native IO has Rust proof.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const {chromium}=createRequire(import.meta.url)("playwright-core");
const url=process.env.AMBERTEXT_TEST_URL||"http://127.0.0.1:1428";
const scenarios=["literal-oracle","case-expansion","dirty-overlay","oversized-overlay","unicode-active","unicode-parked","stale-disk","stale-buffer","late-query","workspace-switch","cancel","stopped-partial","closed-mutation","result-keeps-results","typing","deep-catalogue","coverage","keyboard-panel","existing-find"];
const browser=await chromium.launch({channel:"msedge",headless:true});
try {for(const scenario of scenarios){
 const context=await browser.newContext();
 try {
  await context.route("**/*",r=>new URL(r.request().url()).origin!==new URL(url).origin&&/^https?:/.test(r.request().url())?r.abort():r.continue());
  const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(url);await page.waitForSelector(".cm-content");
  const result=await page.evaluate(async scenario=>{
   const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts"),p=await import("/src/lib/platform.ts"),w=await import("/src/lib/workspaceSearch.ts"),b=(await import("/src/editor/bridge.ts")).bridge;
   const check=(value,msg)=>{if(!value)throw new Error(msg);},wait=ms=>new Promise(r=>setTimeout(r,ms));
   const until=async fn=>{for(let i=0;i<200&&!fn();i++)await wait(10);check(fn(),"Expected current editor state");};
   const root="/Users/you/Notes/search-fixture-"+scenario,path=root+"/A/writing.md";
   const text="🙂 e\u0301 first\nneedle alpha\nlast NEEDLE";
   s.getState().setSettings({autosave:false,historyEnabled:false});await p.fsApi.createFile(path,text);await a.openFolder(root);
   const run=async(query,options={caseSensitive:true,wholeWord:false})=>{w.useWorkspaceSearch.setState({query,options});await w.runWorkspaceSearch();return w.useWorkspaceSearch.getState();};
   if(scenario==="case-expansion"){
    check(JSON.stringify(w.literalRanges("İ dotted ΑΛΦΑ café 😀","αλφα",false,true))==="[[9,13]]","Expansion at start shifted a later Unicode match");
    check(JSON.stringify(w.literalRanges("start İ next","i",false,false))==="[[6,7]]","Expansion later in text selected the wrong original character");
    check(JSON.stringify(w.literalRanges("İSTANBUL","istanbul",false,false))==="[[0,8]]","istanbul did not find İSTANBUL");
    check(JSON.stringify(w.literalRanges("i\u0307 dot","i",false,false))==="[]","A match covered part of a dotted i");
    check(JSON.stringify(w.literalRanges("e\u0301 e","e",false,true))==="[[3,4]]","Whole word matched inside a decomposed é");
    check(JSON.stringify(w.literalRanges("aa a a","a a",true,true))==="[[3,6]]","A rejected whole-word candidate hid an overlapping one");
    check(JSON.stringify(w.literalRanges("👍🏽 👍","👍",true,false))==="[[5,7]]","A match covered part of an emoji with a modifier");
    check(JSON.stringify(w.literalRanges("İ dot","i",false,false))==="[[0,1]]","Expansion at start did not select the original character");
    return {};
   }
   if(scenario==="closed-mutation"){await run("needle");await p.fsApi.createFile(root+"/new.md","new needle");/* Changed from the old "wipe on change": results now stay and are marked possibly out of date. */await until(()=>w.useWorkspaceSearch.getState().changes>0);check(!w.useWorkspaceSearch.getState().stale&&w.useWorkspaceSearch.getState().hits.length===1,"Closed-file creation wiped the results");const found=await run("needle");check(found.hits.length===2,"Rebuilt search missed new closed file");return {};}
   if(scenario==="result-keeps-results"){
    const found=await run("needle"),key=found.searchKey,count=found.hits.length,docs=s.getState().docs.length;
    check(count>0&&key,"Search found nothing");
    check(await w.navigateSearchHit(found.hits[0]),"Opening a result in an unopened file failed");
    check(s.getState().docs.length===docs+1,"The result file was not opened");
    let now=w.useWorkspaceSearch.getState();
    check(now.hits.length===count&&!now.stale&&!now.outdated.length&&!now.outdatedAll&&now.searchKey===key,"Opening a result file changed the results");
    const id=s.getState().activeId;a.updateContent(id,"typed "+s.getState().docs.find(d=>d.id===id).content);
    now=w.useWorkspaceSearch.getState();
    check(now.hits.length===count&&!now.stale&&now.queryId===found.queryId,"Typing wiped the results");
    check(w.isPathOutdated(now,found.hits[0].path),"The edited file was not marked possibly out of date");
    check(!await w.navigateSearchHit(found.hits[0]),"A result in changed writing was still selected");
    check(w.useWorkspaceSearch.getState().hits.length===count,"A failed jump wiped the results");
    return {};
   }
   if(scenario==="stopped-partial"){
    const found=await run("needle");w.stopWorkspaceSearch();const stopped=w.useWorkspaceSearch.getState();
    check(stopped.coverage.cancelled&&stopped.coverage.partial&&!stopped.busy&&stopped.hits.length===found.hits.length,"Stop hid partial-results state");return {};
   }
   if(scenario==="literal-oracle"){
    await p.fsApi.createFile(root+"/B/writing.md","needle needles café ΑΛΦΑ\nneedle");
    for(const [query,caseSensitive,wholeWord]of [["needle",true,false],["needle",false,true],["αλφα",false,true],["café",true,true],["alpha\nlast",true,false]]){
     const actual=await run(query,{caseSensitive,wholeWord});
     const other=root+"/B/writing.md";
     const expected=query==="needle"?(wholeWord?[path+":12:18",path+":30:36",other+":0:6",other+":25:31"]:[path+":12:18",other+":0:6",other+":7:13",other+":25:31"]):query==="αλφα"?[other+":20:24"]:query==="café"?[other+":15:19"]:[path+":19:29"];
     check(actual.hits.map(h=>h.path+":"+h.from+":"+h.to).sort().join("|")===expected.sort().join("|"),"Literal corpus oracle mismatch");
     check(!actual.coverage.partial&&!actual.busy,"Expected complete coverage");
    }return {};
   }
   if(scenario==="deep-catalogue"){await p.fsApi.createFile(root+"/"+("deep/".repeat(15))+"deep.md","needle");const found=await run("needle");check(found.hits.length===2,"Deep writing omitted");return {};}
   if(scenario==="coverage"){
    await p.fsApi.createFile(root+"/.hidden.md","needle");await p.fsApi.createFile(root+"/node_modules/generated.md","needle");await p.fsApi.createFile(root+"/large.md","x".repeat(2*1024*1024+1));
    const found=await run("needle");check(found.hits.length===1&&found.coverage.partial&&found.coverage.excluded===2&&found.coverage.skipped===1,"Coverage omissions hidden");return {};
   }
   if(scenario==="late-query"||scenario==="workspace-switch"||scenario==="cancel"){
    const start=w.searchApi.start.bind(w.searchApi);let resolve;const entered=new Promise(r=>resolve=r);let release;const hold=new Promise(r=>release=r);
    w.searchApi.start=async(req,emit)=>{resolve();await hold;emit({queryId:req.queryId,root:req.root,hits:[{path,from:0,to:3,source:"disk",contentHash:"wrong"}],coverage:{visited:1,eligible:1,scanned:1,bytesRead:3,excluded:0,skipped:0,partial:false,cancelled:false,warnings:[]},complete:true,resultLimited:false});};
    w.useWorkspaceSearch.setState({query:"older"});const running=w.runWorkspaceSearch();await entered;
    if(scenario==="workspace-switch"){await p.fsApi.createFile(root+"-other/writing.md","other");await a.openFolder(root+"-other");}
    else if(scenario==="cancel")w.invalidateWorkspaceSearch();
    else {w.useWorkspaceSearch.setState({query:"newer"});}
    release();await running;check(w.useWorkspaceSearch.getState().hits.length===0,"Late results replaced current query");w.searchApi.start=start;return {};
   }
   const id=await a.openPath(path);await until(()=>b.viewDocId===id);
   if(scenario==="oversized-overlay"){
    const start=w.searchApi.start.bind(w.searchApi);let inspected=null;
    w.searchApi.start=async(req,...rest)=>{inspected=req;return start(req,...rest);};
    a.updateContent(id,"x".repeat(2*1024*1024+1));const found=await run("needle");
    check(inspected.overlays[0].excluded&&inspected.overlays[0].content==="","Huge unsaved text was sent to native IPC");
    check(found.hits.length===0&&found.coverage.partial&&found.coverage.skipped===1,"Oversized buffer silently used the old disk copy");
    check((await p.fsApi.readText(path)).content===text,"Oversized search changed canonical writing");return {};
   }
   if(scenario==="typing"){
    for(let i=0;i<200;i++)await p.fsApi.createFile(root+"/many-"+i+".md","large text ".repeat(2000)+"needle");
    w.useWorkspaceSearch.setState({query:"needle"});void w.runWorkspaceSearch();await until(()=>w.useWorkspaceSearch.getState().busy);return {id};
   }
   if(scenario==="dirty-overlay"){b.view.dispatch({changes:{from:0,to:b.view.state.doc.length,insert:"🙂 unsaved needle"}});const found=await run("needle");check(found.hits.length===1&&found.hits[0].source==="buffer"&&found.hits[0].from===11,"Dirty buffer lost to disk");check((await p.fsApi.readText(path)).content===text,"Search modified canonical writing");return {};}
   if(scenario==="stale-buffer"){const found=await run("needle");b.view.dispatch({changes:{from:0,insert:"new writing "}});check(!await w.navigateSearchHit(found.hits[0]),"Stale buffer hit selected text");return {};}
   if(scenario==="stale-disk"){const found=await run("needle");const disk=await p.fsApi.readText(path);await p.fsApi.writeText(path,"External different",disk.revision);check(!await w.navigateSearchHit(found.hits[0]),"Stale disk hit selected text");check(s.getState().docs.find(d=>d.id===id).content===text,"Stale navigation mutated open writing");return {};}
   if(scenario==="unicode-active"||scenario==="unicode-parked"){
    const found=await run("needle");check(found.hits[0].from===12&&found.hits[0].to===18,"Unicode UTF16 offset wrong");
    if(scenario==="unicode-parked"){a.newDoc("Other text");await until(()=>b.viewDocId!==id);await run("needle");}
    const hit=w.useWorkspaceSearch.getState().hits[0];check(await w.navigateSearchHit(hit),"Exact navigation refused");
    check(b.view.state.sliceDoc(b.view.state.selection.main.from,b.view.state.selection.main.to)==="needle","Actual editor selection missed match");check(s.getState().docs.find(d=>d.id===id).content===text,"Navigation changed content");return {};
   }
   if(scenario==="existing-find"){(await import("/src/commands.ts")).commandById.get("find").run();return {};}
   s.getState().setSettings({sidebarOpen:true,sidebarTab:"search"});return {root,path};
  },scenario);
  if(scenario==="typing"){
   await page.locator(".cm-content").focus();await page.keyboard.press("Home");const start=performance.now();await page.keyboard.type("Actual typing ");const elapsed=performance.now()-start;
   assert.equal(await page.evaluate(async id=>(await import("/src/state/store.ts")).getState().docs.find(d=>d.id===id).content.includes("Actual typing "),result.id),true);
   console.log("BROWSER_TYPING_MS "+elapsed.toFixed(2)+" (headless fallback; native worker UI not proved)");
  } else if(scenario==="keyboard-panel"){
   const panel=page.getByRole("region",{name:"Search folder"});await panel.waitFor();await panel.getByLabel("Find in folder").fill("needle");
   await page.waitForFunction(()=>document.querySelectorAll("[data-search-result]").length===2);
   const resultButtons=panel.locator("[data-search-result]");await resultButtons.first().focus();await page.keyboard.press("ArrowDown");assert.equal(await resultButtons.nth(1).evaluate(el=>el===document.activeElement),true);
   await page.keyboard.press("Enter");await page.waitForFunction(()=>document.activeElement?.classList.contains("cm-content"));
   assert.equal(await page.evaluate(async()=>{const b=(await import("/src/editor/bridge.ts")).bridge;return b.view.state.sliceDoc(b.view.state.selection.main.from,b.view.state.selection.main.to);}),"NEEDLE");
   assert.match(await panel.innerText(),/matches? in 1 file./);
  } else if(scenario==="existing-find"){
   const find=page.locator(".find");await find.waitFor();
   await find.locator('[data-tip="Regular expression"]').click();
   await find.locator('[data-field="search"]').fill("needle(?= alpha)");
   await find.locator('[data-field="search"]').press("Enter");
   assert.equal(await page.evaluate(async()=>{const b=(await import("/src/editor/bridge.ts")).bridge;return b.view.state.sliceDoc(b.view.state.selection.main.from,b.view.state.selection.main.to);}),"needle");
  }
  assert.deepEqual(errors,[],scenario+" page errors");console.log("PASS "+scenario);
 }finally{await context.close();}
}}finally{await browser.close();}
