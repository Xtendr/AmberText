// Real mounted browser/editor flow; successful binary IO is explicitly simulated.
// Native files/profile/restart evidence requires the separate native fixture.
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright-core");
const url=process.env.AMBERTEXT_TEST_URL||"http://127.0.0.1:1430";
const browser=await chromium.launch({channel:"msedge",headless:true});
const scenarios=["shared-default","document-paste","document-import","document-existing","document-collision","captured-batch","document-draft","unicode-name","new-name"];
try {
  for(const scenario of scenarios) {
    const context=await browser.newContext(),errors=[],network=[];
    try {
      await context.route("**/*",route=>{const target=new URL(route.request().url());if(/^https?:$/.test(target.protocol)&&target.origin!==new URL(url).origin){network.push(target.href);return route.abort();}return route.continue();});
      const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));await page.goto(url);await page.waitForSelector(".cm-content");
      await page.evaluate(async scenario=>{
        const a=await import("/src/state/actions.ts"),s=await import("/src/state/store.ts"),p=await import("/src/lib/platform.ts"),refs=await import("/src/lib/markdownReferences.ts"),paths=await import("/src/lib/paths.ts");
        const {bridge}=await import("/src/editor/bridge.ts");
        const check=(ok,message)=>{if(!ok)throw Error(message);};
        check(s.getState().settings.imageFolder==="shared","Fresh profiles must keep the current shared default");
        s.getState().setSettings({autosave:false,historyEnabled:false,livePreview:false,viewMode:"write"});
        const root="/Users/you/Notes/folders-"+scenario,filename=scenario==="unicode-name"?"Chapter æ #% [draft].md":"Chapter.md",docPath=root+"/"+filename;
        const original="Writing\n\n![existing](assets/old.png)",old=root+"/assets/old.png",source="/Users/you/Imports/source #?.png";
        await p.fsApi.createFile(docPath,original);await p.fsApi.createFile(old,"Existing image");await p.fsApi.createFile(source,"Copied image placeholder");
        const id=await a.openPath(docPath);
        const deadline=Date.now()+5000;while(bridge.viewDocId!==id&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));check(bridge.viewDocId===id,"Fixture editor not mounted");
        let effectivePath=docPath;
        if(scenario==="new-name") {
          // This models an already successful renamed document, not rename IO proof.
          effectivePath=root+"/Renamed.md";
          s.setState(state=>({docs:state.docs.map(d=>d.id===id?{...d,path:effectivePath}:d)}));
        }
        const writes=[],created=[],realCreate=p.fsApi.createFile,realRead=p.fsApi.readText;
        const create=async(target,data)=>{writes.push(target);if(await p.fsApi.exists(target))throw{kind:"conflict",message:"Owned existing destination"};await realCreate(target,data);created.push(target);return(await realRead(target)).revision;};
        p.fsApi.writeBase64=create;
        p.fsApi.copyFile=async(from,target)=>{const receipt=await create(target,(await realRead(from)).content);if(scenario==="captured-batch"&&created.length===1)s.getState().setSettings({imageFolder:"shared"});return receipt;};
        if(scenario!=="shared-default")s.getState().setSettings({imageFolder:"document"});
        check(!writes.length&&(await realRead(old)).content==="Existing image"&&(await realRead(docPath)).content===original,"Changing folder choice moved existing files or writing");
        if(scenario==="document-draft") {
          const draft=a.newDoc("Draft writing");while(bridge.viewDocId!==draft&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
          await a.pasteImage(bridge.view,[new File(["placeholder"],"paste.png",{type:"image/png"})]);
          check(!writes.length&&s.getState().docs.find(d=>d.id===draft).content==="Draft writing"&&s.getState().toasts.some(t=>/Save this document first/.test(t.message)),"Document-folder draft lost Save-first protection");return;
        }
        const folder=root+"/"+(scenario==="shared-default"?"assets":paths.stripExt(paths.basename(effectivePath))+".assets");
        if(scenario==="document-collision")await realCreate(folder+"/source #?.png","Occupied image");
        bridge.view.dispatch({selection:{anchor:bridge.view.state.doc.length}});
        if(scenario==="document-paste"||scenario==="shared-default")await a.pasteImage(bridge.view,[new File(["placeholder"],"paste.png",{type:"image/png"})]);
        else await a.insertImageFiles(bridge.view,scenario==="captured-batch"?[source,source]:[scenario==="document-existing"?old:source]);
        const text=s.getState().docs.find(d=>d.id===id).content,parsed=refs.parseMarkdownReferences(text);
        check(parsed.references[0].target==="assets/old.png","Existing reference was rewritten");
        const added=parsed.references.slice(1);check(added.length===(scenario==="captured-batch"?2:1),"Expected image links missing");
        if(scenario==="document-existing")check(!writes.length&&refs.resolveReferenceTarget(added[0].target,effectivePath).path===old,"Existing inside-folder image was relocated");
        else for(let n=0;n<added.length;n++){check(paths.dirname(created[n])===folder,"Wrong or mixed destination folder");check(refs.resolveReferenceTarget(added[n].target,effectivePath).path===created[n],"Encoded image reference points at the wrong file");check(paths.resolvePath(paths.dirname(effectivePath),added[n].target)===created[n],"Preview/editor resolver points at a different image file");}
        if(scenario==="document-collision")check(writes.length===2&&(await realRead(folder+"/source #?.png")).content==="Occupied image","Document folder collision overwrote existing image");
        if(scenario==="document-paste") {
          const commands=performance.getEntriesByType("resource").map(e=>e.name).find(name=>new URL(name).pathname.endsWith("/@codemirror_commands.js"));
          check((await import(commands)).undo(bridge.view)&&bridge.view.state.doc.toString()===original,"New folder insertion lost existing editor Undo");
        }
        check((await realRead(old)).content==="Existing image"&&(await realRead(docPath)).content===original&&(await realRead(source)).content==="Copied image placeholder","Folder change damaged canonical writing/images/sources");
      },scenario);
      assert.deepEqual(errors,[]);assert.deepEqual(network,[]);console.log("PASS "+scenario);
    } finally {await context.close();}
  }
  const context=await browser.newContext();
  try {
    const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));await page.goto(url);await page.waitForSelector(".cm-content");
    await page.evaluate(async()=>{const s=await import("/src/state/store.ts");s.setState({settingsOpen:true,settingsSection:"editor"});});
    const chooser=page.getByRole("combobox",{name:"New image folders"});await chooser.waitFor();assert.equal(await chooser.inputValue(),"shared");
    await chooser.focus();await chooser.press("ArrowDown");assert.equal(await chooser.inputValue(),"document");
    const chosen=await page.evaluate(async()=>{const s=await import("/src/state/store.ts");return{setting:s.getState().settings.imageFolder,saved:JSON.parse(localStorage.getItem("margin:prefs")).state.settings.imageFolder};});assert.deepEqual(chosen,{setting:"document",saved:"document"});console.log("PASS keyboard-setting-and-persisted-choice");
    await page.reload();await page.waitForSelector(".cm-content");assert.equal(await page.evaluate(async()=>(await import("/src/state/store.ts")).getState().settings.imageFolder),"document");console.log("PASS browser-profile-reload");
    // Seed older preferences before module startup. Mutating storage under a
    // running app can be overwritten by its legitimate state persistence.
    await context.addInitScript(()=>{const legacy=JSON.parse(localStorage.getItem("margin:prefs"));delete legacy.state.settings.imageFolder;legacy.state.settings.fontSize=21;localStorage.setItem("margin:prefs",JSON.stringify(legacy));});
    await page.reload();await page.waitForSelector(".cm-content");assert.deepEqual(await page.evaluate(async()=>{const s=(await import("/src/state/store.ts")).getState().settings;return[s.imageFolder,s.fontSize];}),["shared",21]);console.log("PASS existing-preferences-default-with-other-settings-preserved");
    const resolved=await page.evaluate(async()=>{const p=await import("/src/lib/paths.ts");return[
      p.resolvePath("/Notes","assets/a%23b%3Fc%2520.png?view=x#crop"),
      p.resolvePath("C:\\Notes","assets/a%23b%2520.png?view=x#crop"),
      p.resolvePath("/Notes","../Other/plain.png#heading"),
      p.resolvePath("/Notes","assets/bad%zz.png?view=x#crop")
    ];});assert.deepEqual(resolved,["/Notes/assets/a#b?c%20.png","C:\\Notes\\assets\\a#b%20.png","/Other/plain.png","/Notes/assets/bad%zz.png"]);console.log("PASS local-rendering-and-link-url-suffix-decoding-once");
    assert.deepEqual(errors,[]);
  } finally {await context.close();}
} finally {await browser.close();}
