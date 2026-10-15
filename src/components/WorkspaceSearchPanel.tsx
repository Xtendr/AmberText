import { useEffect, useRef, useState } from "react";
import { CaseSensitive, ChevronRight, FileText, FolderOpen, RotateCw, WholeWord } from "lucide-react";
import { useStore } from "../state/store";
import { openFolderDialog } from "../state/actions";
import { useWorkspaceSearch, runWorkspaceSearch, clearWorkspaceSearch, stopWorkspaceSearch, navigateSearchHit, searchKeyFor, isPathOutdated, type SearchHit } from "../lib/workspaceSearch";
import { basename, dirname } from "../lib/paths";
import { ReplacementReceipts, WorkspaceReplacementPanel } from "./WorkspaceReplacementPanel";
export function WorkspaceSearchPanel() {
  const search=useWorkspaceSearch(),root=useStore(s=>s.workspace?.root);
  const [shown,setShown]=useState(100),[jumpMessage,setJumpMessage]=useState("");
  const container=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const state=useWorkspaceSearch.getState();
    if(!root||!search.query){if(state.queryId||state.busy)clearWorkspaceSearch();return;}
    // Remounting the panel (switching sidebar tabs) keeps the results it already has.
    if(searchKeyFor(root,search.query,search.options)===state.searchKey)return;
    const timer=window.setTimeout(()=>{if(searchKeyFor(root,search.query,search.options)!==useWorkspaceSearch.getState().searchKey)void runWorkspaceSearch();},200);
    return ()=>window.clearTimeout(timer);
  },[root,search.query,search.options.caseSensitive,search.options.wholeWord]);
  useEffect(()=>{setShown(100);},[search.queryId]);
  const jump=async(hit:SearchHit)=>{
    setJumpMessage(await navigateSearchHit(hit)?`Line ${hit.line} in ${basename(hit.path)}.`:"That match has changed. Search again to update it.");
  };
  const groups=new Map<string,SearchHit[]>();
  for(const hit of search.hits.slice(0,shown)){const hits=groups.get(hit.path)??[];hits.push(hit);groups.set(hit.path,hits);}
  const resultKeys=(e:React.KeyboardEvent)=>{
    if(!["ArrowDown","ArrowUp","Home","End"].includes(e.key))return;
    const buttons=[...(container.current?.querySelectorAll<HTMLButtonElement>("[data-search-result]")??[])];
    const at=buttons.indexOf(document.activeElement as HTMLButtonElement);if(at<0)return;
    e.preventDefault();e.stopPropagation();
    const next=e.key==="Home"?0:e.key==="End"?buttons.length-1:Math.min(buttons.length-1,Math.max(0,at+(e.key==="ArrowDown"?1:-1)));
    buttons[next]?.focus();
  };
  if(!root)return <section className="sb-scroll workspace-search" aria-label="Search folder">
    <div className="sb-empty">
      <div className="sb-empty-icon"><FolderOpen size={17} strokeWidth={1.8} /></div>
      <strong>No folder open</strong>
      Open a folder to search your writing.
      <div><button className="btn" onClick={()=>void openFolderDialog()}>Open folder…</button></div>
    </div>
  </section>;
  const setOption=(patch:Partial<typeof search.options>)=>{clearWorkspaceSearch();useWorkspaceSearch.setState({options:{...search.options,...patch}});};
  const status=search.coverage.cancelled?"Search stopped.":search.stale?"Your writing has changed. Search again to update the results.":search.busy?`Searching… ${search.coverage.scanned} files so far, ${search.hits.length} ${search.hits.length===1?"match":"matches"}.`:search.queryId?`${search.hits.length} ${search.hits.length===1?"match":"matches"} in ${search.coverage.scanned} ${search.coverage.scanned===1?"file":"files"}.`:"";
  return <section className="sb-scroll workspace-search" aria-label="Search folder" ref={container} onKeyDown={resultKeys}>
    <div className="ws-field">
      <label htmlFor="workspace-query" className="sr-only">Find in folder</label>
      <textarea id="workspace-query" rows={1} spellCheck={false} value={search.query} onChange={e=>{clearWorkspaceSearch();useWorkspaceSearch.setState({query:e.target.value});}} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing&&search.query){e.preventDefault();void runWorkspaceSearch();}}} placeholder={`Search ${basename(root)}`}/>
      <label className="find-opt" data-tip="Match case"><input type="checkbox" aria-label="Match case" checked={search.options.caseSensitive} onChange={e=>setOption({caseSensitive:e.target.checked})}/><CaseSensitive size={15} /></label>
      <label className="find-opt" data-tip="Whole word"><input type="checkbox" aria-label="Whole word" checked={search.options.wholeWord} onChange={e=>setOption({wholeWord:e.target.checked})}/><WholeWord size={15} /></label>
    </div>
    <WorkspaceReplacementPanel />
    {(status||search.query)&&<div className="ws-status">
      <p role="status" aria-live="polite" aria-atomic="true">{status}
        {!search.busy&&!search.stale&&(search.outdatedAll||search.outdated.length>0)&&" Some files have changed since, so a few results may be out of date."}
        {search.coverage.partial&&" Not every file could be searched."}{search.resultLimited&&" Only the first 2,000 matches are listed."}</p>
      {search.busy?<button type="button" className="ws-link" onClick={stopWorkspaceSearch}>Stop</button>
        :<button type="button" className="icon-btn sm" aria-label="Search again" data-tip="Search again" disabled={!search.query} onClick={()=>void runWorkspaceSearch()}><RotateCw size={13} /></button>}
    </div>}
    {search.error&&<p role="alert" className="ws-alert">{search.error}</p>}
    {search.queryId&&search.coverage.skipped>0&&<p className="muted ws-note">{search.coverage.skipped} {search.coverage.skipped===1?"file was":"files were"} too large or couldn’t be read.</p>}
    {!!search.coverage.warnings.length&&<details className="sb-disclosure"><summary><ChevronRight size={12} strokeWidth={2.2} />Files that couldn’t be fully searched</summary><ul>{search.coverage.warnings.map((message,i)=><li key={i}>{message}</li>)}</ul></details>}
    <div className="ws-results">{[...groups].map(([path,hits])=>{const rel=hits[0].relativePath||basename(path),folder=dirname(rel.replace(/\\/g,"/"));return <section key={path} aria-label={path} className="ws-group">
      <h4 className="ws-file" title={path}><FileText size={14} className="tree-icon" strokeWidth={1.8} /><span className="ws-file-name">{basename(path)}</span>{folder&&folder!=="."&&folder!==rel&&<span className="ws-file-dir">{folder}</span>}<span className="ws-count">{hits.length}</span></h4>
      {isPathOutdated(search,path)&&<p className="muted ws-note">Changed since this search</p>}
      {hits.some(h=>h.truncated)&&<p className="muted ws-note">This file has more matches than can be listed, so Replace leaves it alone.</p>}
      {hits.map((hit,i)=><button type="button" key={hit.from+":"+i} data-search-result className="workspace-search-result" onClick={()=>void jump(hit)} aria-label={`${basename(path)}, line ${hit.line}, ${hit.source==="buffer"?"unsaved changes":"saved"}: ${hit.snippet}`}><span className={`ws-line${hit.source==="buffer"?" is-unsaved":""}`}>{hit.line}</span><span className="ws-snippet">{hit.snippet}</span></button>)}
    </section>;})}</div>
    {search.hits.length>shown&&<button type="button" className="btn ws-more" onClick={()=>setShown(n=>n+100)}>Show next {Math.min(100,search.hits.length-shown)} matches</button>}
    <span role="status" aria-live="polite" className="sr-only">{jumpMessage}</span>
    <ReplacementReceipts />
    <details className="sb-disclosure">
      <summary><ChevronRight size={12} strokeWidth={2.2} />What gets searched</summary>
      <p>Markdown and text files in this folder and its subfolders. Hidden files, system folders such as node_modules, and files over 2 MB are skipped. Open documents are searched as they are now, including unsaved changes.</p>
      <p>With Match case off, capital and small letters match, but accents still count. Searching never changes your files.</p>
    </details>
  </section>;
}
