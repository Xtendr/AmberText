import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { fsApi, isTauri, ioMessage, sameRevision, MARKDOWN_EXTENSIONS, type FileRevision } from "./platform";
import { isInside, plainPath, samePath } from "./paths";
import { getState, isDirty } from "../state/store";
import { activate, openPath, toast } from "../state/actions";
import { bridge } from "../editor/bridge";
export interface SearchCoverage { visited: number; eligible: number; scanned: number; bytesRead: number; excluded: number; skipped: number; partial: boolean; cancelled: boolean; warnings: string[] }
export interface SearchHit { path: string; relativePath: string; documentId: string | null; source: "disk" | "buffer"; revision: FileRevision | null; contentHash: string; from: number; to: number; line: number; snippet: string; truncated?: boolean }
export interface SearchEvent { queryId: string; root: string; hits: SearchHit[]; coverage: SearchCoverage; complete: boolean; resultLimited: boolean }
export interface SearchOptions { caseSensitive: boolean; wholeWord: boolean }
interface SearchRequest extends SearchOptions { root: string; queryId: string; query: string; overlays: {documentId:string; path:string;content:string;revision:FileRevision|null;excluded:boolean}[] }
const emptyCoverage = ():SearchCoverage => ({visited:0,eligible:0,scanned:0,bytesRead:0,excluded:0,skipped:0,partial:false,cancelled:false,warnings:[]});
export async function searchHash(text: string) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,"0")).join("");
}
function normalize(text: string) {return text.replace(/\r\n?/g,"\n");}
const word=(c:string)=>/[\p{Alphabetic}\p{Number}_]/u.test(c);
const segmenter=typeof Intl!=="undefined"&&"Segmenter" in Intl?new Intl.Segmenter(undefined,{granularity:"grapheme"}):null;
/** Dotted capital I folds to plain "i" so every character folds to whole characters. */
const fold=(c:string)=>c==="\u0130"?"i":c.toLowerCase();
const cpLength=(s:string,at:number)=>(s.codePointAt(at)??0)>0xffff?2:1;
const graphemeBoundary=(text:string,at:number)=>at<=0||at>=text.length||(segmenter?segmenter.segment(text).containing(at)?.index===at:!/[\uDC00-\uDFFF]/.test(text[at]));
/** The first character of the user-perceived character ending at `at` (before) or starting at `at` (after). */
const firstOfGrapheme=(text:string,at:number,before:boolean)=>{
  if(before?at<=0:at>=text.length)return "";
  const index=before?at-1:at,seg=segmenter?.segment(text).containing(index);
  return seg?String.fromCodePoint(seg.segment.codePointAt(0)!):before?([...text.slice(0,at)].at(-1)??""):String.fromCodePoint(text.codePointAt(at)!);
};
/** Must match search.rs `literal_ranges`: a match never covers part of a case expansion or part of a user-perceived character. */
export function literalRanges(text:string,query:string,caseSensitive:boolean,wholeWord:boolean):Array<[number,number]> {
  const needle=caseSensitive?query:[...query].map(fold).join("");
  if(!needle)return [];
  let hay="",map:Array<[number,number]>=[];
  if(caseSensitive)hay=text;
  else {
    let at=0,remapped=false;
    for(const c of text){const folded=fold(c);const before=hay.length;hay+=folded;if(!remapped&&folded.length!==c.length){map=Array.from({length:before},(_,n)=>[n,n+1]);remapped=true;}if(remapped)for(let n=0;n<folded.length;n++)map.push([at,at+c.length]);at+=c.length;}
  }
  const ranges:Array<[number,number]>=[];
  let cursor=0;
  while(cursor<=hay.length&&ranges.length<=200){
    const start=hay.indexOf(needle,cursor);if(start<0)break;const end=start+needle.length;
    const [from,to]=!map.length?[start,end]:[map[start][0],map[end-1][1]];
    const wholeFold=!map.length||((start===0||map[start-1][0]!==map[start][0])&&(end===hay.length||map[end][0]!==map[end-1][0]));
    const accepted=wholeFold&&graphemeBoundary(text,from)&&graphemeBoundary(text,to)
      &&(!wholeWord||(!word(firstOfGrapheme(text,from,true))&&!word(firstOfGrapheme(text,to,false))));
    if(accepted){
      if(ranges.at(-1)?.[0]!==from||ranges.at(-1)?.[1]!==to)ranges.push([from,to]);
      cursor=end;
    }else cursor=start+cpLength(hay,start); // a rejected candidate may overlap a valid one
  }return ranges;
}
// Native cancel is only sent while a native search is actually running.
let nativeRunning=0;
/** Browser fixture enumeration reads the memory filesystem independently of the sidebar tree. */
export const searchApi = {
  async cancel():Promise<void> {if(isTauri&&nativeRunning>0)await invoke("workspace_search_cancel");},
  async start(request:SearchRequest,onEvent:(event:SearchEvent)=>void,cancelled:()=>boolean):Promise<void> {
    if(isTauri){
      const unlisten=await listen<SearchEvent>("ambertext:workspace-search",event=>{
        if(!cancelled()&&event.payload.queryId===request.queryId&&event.payload.root===request.root)onEvent(event.payload);
      });
      nativeRunning++;
      try {if(!cancelled())await invoke("workspace_search",{request});}finally{nativeRunning--;unlisten();}
      return;
    }
    const catalogue=fsApi.browserSearchCatalogue(request.root);
    const coverage={...emptyCoverage(),...catalogue.coverage};let total=0,resultLimited=false;
    const paths=[...catalogue.paths];
    for(const overlay of request.overlays){
      const parts=overlay.path.slice(request.root.length+1).split(/[\\/]/);
      if(isInside(overlay.path,request.root)&&MARKDOWN_EXTENSIONS.includes(overlay.path.split(".").at(-1)?.toLowerCase()??"")&&!parts.some(p=>p.startsWith(".")||p.startsWith("~")||["node_modules","target","__pycache__","$RECYCLE.BIN"].includes(p))&&!paths.includes(overlay.path))paths.push(overlay.path);
    }
    for(const path of paths) {
      if(cancelled())return;
      const overlay=request.overlays.find(d=>d.path===path);
      if(overlay?.excluded||request.overlays.filter(d=>d.path===path).length>1){coverage.skipped++;coverage.partial=true;if(coverage.warnings.length<50)coverage.warnings.push(path+": unsaved buffer exceeds limits or has competing identities");continue;}
      try {
        const file=overlay?null:await fsApi.readText(path);
        const text=normalize(overlay?.content??file!.content);
        const bytes=new TextEncoder().encode(text).length;
        if(bytes>2*1024*1024||coverage.bytesRead+bytes>256*1024*1024){coverage.skipped++;coverage.partial=true;coverage.warnings.push(path+": search byte limit");continue;}
        coverage.bytesRead+=bytes;coverage.scanned++;
        const contentHash=await searchHash(text), ranges=literalRanges(text,request.query,request.caseSensitive,request.wholeWord);
        const hits=ranges.slice(0,200).map(([from,to]):SearchHit=>({path,relativePath:path.slice(request.root.length+1),documentId:overlay?.documentId??null,source:overlay?"buffer":"disk",revision:overlay?.revision??file?.revision??null,contentHash,from,to,line:text.slice(0,from).split("\n").length,truncated:ranges.length>200,snippet:[...text.slice(0,from)].slice(-60).join("")+[...text.slice(from,to)].slice(0,120).join("")+[...text.slice(to)].slice(0,60).join("")}));
        if(ranges.length>200){coverage.partial=true;coverage.skipped++;resultLimited=true;coverage.warnings.push(path+": per-file result limit (200)");}
        const remaining=2000-total;if(hits.length>remaining){hits.length=remaining;hits.forEach(h=>h.truncated=true);coverage.partial=true;resultLimited=true;}
        total+=hits.length;
        onEvent({queryId:request.queryId,root:request.root,hits,coverage:{...coverage,warnings:coverage.warnings.slice(0,50)},complete:false,resultLimited});
        if(total>=2000){coverage.partial=true;resultLimited=true;break;}
      }catch(error){coverage.skipped++;coverage.partial=true;if(coverage.warnings.length<50)coverage.warnings.push(path+": "+ioMessage(error));}
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(!cancelled())onEvent({queryId:request.queryId,root:request.root,hits:[],coverage,complete:true,resultLimited});
  },
};
interface SearchState { query:string;options:SearchOptions;queryId:string|null;root:string|null;hits:SearchHit[];coverage:SearchCoverage;busy:boolean;error:string|null;stale:boolean;resultLimited:boolean;
  /** Identity of the search that produced the current results, so a remounted panel does not search again. */
  searchKey:string|null;
  /** Files (or folders) that may have changed since the results were found; the results stay visible. */
  outdated:string[];outdatedAll:boolean;changes:number }
export const useWorkspaceSearch=create<SearchState>(()=>({query:"",options:{caseSensitive:false,wholeWord:false},queryId:null,root:null,hits:[],coverage:emptyCoverage(),busy:false,error:null,stale:false,resultLimited:false,searchKey:null,outdated:[],outdatedAll:false,changes:0}));
export const searchKeyFor=(root:string|null|undefined,query:string,options:SearchOptions)=>root&&query?JSON.stringify([root,query,options.caseSensitive,options.wholeWord]):null;
let generation=0;
const noResults=()=>({queryId:null,busy:false,hits:[],coverage:emptyCoverage(),error:null,resultLimited:false,searchKey:null,outdated:[],outdatedAll:false,changes:0});
/** Quietly drop the results (new query, other folder, nothing to search for). Not an error state. */
export function clearWorkspaceSearch() {
  generation++;void searchApi.cancel().catch(()=>undefined);
  useWorkspaceSearch.setState({...noResults(),stale:false});
}
export function invalidateWorkspaceSearch() {
  generation++;void searchApi.cancel().catch(()=>undefined);
  useWorkspaceSearch.setState({...noResults(),stale:true});
}
export function stopWorkspaceSearch() {
  generation++;void searchApi.cancel().catch(()=>undefined);
  const current=useWorkspaceSearch.getState();
  useWorkspaceSearch.setState({busy:false,coverage:{...current.coverage,cancelled:true,partial:true}});
}
/** Writing or files changed after the search: keep the results, flag what may be out of date. */
export function markSearchOutdated(paths:string[],all=false) {
  const s=useWorkspaceSearch.getState();
  if(!s.queryId||(!all&&!paths.length))return;
  const merged=[...new Set([...s.outdated,...paths.map(plainPath)])];
  useWorkspaceSearch.setState({outdated:merged.slice(0,500),outdatedAll:s.outdatedAll||all||merged.length>500,changes:s.changes+1});
}
export function isPathOutdated(state:Pick<SearchState,"outdated"|"outdatedAll">,path:string) {
  return state.outdatedAll||state.outdated.some(p=>samePath(p,path)||isInside(path,p));
}
export async function runWorkspaceSearch() {
  const mine=++generation,s=getState(),search=useWorkspaceSearch.getState(),root=s.workspace?.root;
  useWorkspaceSearch.setState({...noResults(),root:root??null,busy:!!root&&!!search.query,stale:false,searchKey:searchKeyFor(root,search.query,search.options)});
  try {
    await searchApi.cancel();
    if(mine!==generation||!root||!search.query)return;
    const queryId=crypto.randomUUID();
    let overlayBytes=0;
    const overlays=s.docs.filter(d=>d.path&&isDirty(d)&&isInside(d.path,root)).map(d=>{
      const bytes=d.content.length>2*1024*1024?2*1024*1024+1:new TextEncoder().encode(d.content).length;
      const excluded=bytes>2*1024*1024||overlayBytes+bytes>32*1024*1024;
      if(!excluded)overlayBytes+=bytes;
      return {documentId:d.id,path:d.path!,content:excluded?"":d.content,revision:d.revision,excluded};
    });
    if(overlays.length>200)throw new Error("More than 200 documents have unsaved changes. Save or close some, then search again.");
    const request={root,queryId,query:search.query,...search.options,overlays};
    useWorkspaceSearch.setState({queryId});
    await searchApi.start(request,event=>{
      const latest=useWorkspaceSearch.getState();
      if(mine!==generation||event.queryId!==latest.queryId||event.root!==getState().workspace?.root||latest.query!==request.query||latest.options.caseSensitive!==request.caseSensitive||latest.options.wholeWord!==request.wholeWord)return;
      useWorkspaceSearch.setState({hits:[...latest.hits,...event.hits.map(h=>({...h,path:plainPath(h.path)}))].slice(0,2000),coverage:event.coverage,busy:!event.complete,resultLimited:event.resultLimited});
    },()=>mine!==generation);
    if(mine===generation&&useWorkspaceSearch.getState().busy)useWorkspaceSearch.setState({busy:false,error:"Search ended before complete progress was received. Run it again.",stale:true});
  }catch(error){if(mine===generation)useWorkspaceSearch.setState({busy:false,error:ioMessage(error),stale:true});}
}
/** Every jump verifies the current text fingerprint; stale hits never select another phrase. */
export async function navigateSearchHit(hit:SearchHit):Promise<boolean> {
  const search=useWorkspaceSearch.getState();
  if(search.stale||search.root!==getState().workspace?.root){toast("Search changed. Run it again before choosing a result.");return false;}
  try{
    const path=plainPath(hit.path);
    let doc=hit.documentId?getState().docs.find(d=>d.id===hit.documentId):undefined;
    if(hit.source==="buffer"&&!doc){toast("This unsaved tab is no longer open. Run search again.");return false;}
    if(!doc){
      const disk=await fsApi.readText(path);
      if(!hit.revision||!sameRevision(hit.revision,disk.revision))throw new Error("The file changed since this result");
      const id=await openPath(path);doc=getState().docs.find(d=>d.id===id);
    }
    if(!doc||await searchHash(doc.content)!==hit.contentHash)throw new Error("The writing changed since this result");
    const id=doc.id;activate(id);
    for(let n=0;n<60&&bridge.viewDocId!==id;n++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const current=getState().docs.find(d=>d.id===id);
    if(search.root!==getState().workspace?.root||search.query!==useWorkspaceSearch.getState().query||!current||current.content!==doc.content||bridge.viewDocId!==id||!bridge.view||hit.to>bridge.view.state.doc.length)throw new Error("The current editor no longer matches this result");
    bridge.view.dispatch({selection:{anchor:hit.from,head:hit.to},scrollIntoView:true});
    bridge.view.focus();return true;
  }catch(error){toast(ioMessage(error)+". Run search again.","error");return false;}
}
/** Paths of open files whose writing, saved copy or location changed. A file merely opened clean (or closed clean) matches disk and is not listed. */
export function changedDocPaths(before:ReturnType<typeof getState>["docs"],after:typeof before):string[] {
  const out=new Set<string>(),old=new Map(before.map(d=>[d.id,d])),kept=new Set<string>();
  for(const d of after){
    const b=old.get(d.id);kept.add(d.id);
    if(!b){if(d.path&&d.content!==d.savedContent)out.add(d.path);continue;}
    if(b.path!==d.path){if(b.path)out.add(b.path);if(d.path)out.add(d.path);}
    else if(d.path&&(d.content!==b.content||d.savedContent!==b.savedContent||d.revision?.sha256!==b.revision?.sha256))out.add(d.path);
  }
  for(const b of before)if(!kept.has(b.id)&&b.path&&b.content!==b.savedContent)out.add(b.path);
  return [...out];
}
// This existing-owner subscription fences late results even while the panel is hidden.
let observedRoot=getState().workspace?.root;
let observedDocs=getState().docs;
import { useStore } from "../state/store";
useStore.subscribe(state=>{
  const before=observedDocs;observedDocs=state.docs;
  if(state.workspace?.root!==observedRoot){observedRoot=state.workspace?.root;clearWorkspaceSearch();return;}
  if(state.docs!==before){const changed=changedDocPaths(before,state.docs);if(changed.length)markSearchOutdated(changed);}
});
window.addEventListener("ambertext:filesystem-changed",event=>{
  const root=getState().workspace?.root;
  if(!root)return;
  const inside=(event as CustomEvent<string[]>).detail.filter(path=>path===root||isInside(path,root));
  if(inside.length)markSearchOutdated(inside.filter(path=>path!==root),inside.includes(root));
});
