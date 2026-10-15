import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { diffWords } from "../ai/diff";
import { historyApi, type HistoryCatalogue, type HistoryManifest, type HistoryVersion } from "../lib/history";
import { renderMarkdown } from "../lib/markdown";
import { fsApi, ioMessage } from "../lib/platform";
import { samePath } from "../lib/paths";
import { activeDoc, getState, setState, useStore } from "../state/store";
import { recoverHistoryVersion, relinkHistory, restoreHistoryVersion, saveDocAs, toast } from "../state/actions";

const PREVIEW_LIMIT = 200_000;
const REASONS: Record<string, string> = {
  "interval": "While writing", "manual-save": "Saved", "close": "Closed", "opening": "Opened", "copy": "Saved as a copy",
  "before-save": "Before saving", "before-overwrite": "Before saving over a changed file", "before-reload": "Before reloading from disk",
  "before-restore": "Before restoring an older version", "before-replacement": "Before replace in files", "before-bulk": "Before replace in files",
  "earlier-recovery": "Recovered after a crash", "relink": "Linked to this document",
};
const reasonLabel = (reason: string) => REASONS[reason] ?? reason.replaceAll("-", " ");
function offlinePreview(text: string) {
  return DOMPurify.sanitize(renderMarkdown(text), {
    FORBID_TAGS: ["img","video","audio","source","iframe","object","embed","link","style","svg","image","use","foreignObject","form","input","button","select","textarea"],
    FORBID_ATTR: ["src","srcset","poster","style","background","autoplay","href","xlink:href","contenteditable","tabindex","id"],
  });
}
export function HistoryPanel() {
  const selectedId = useStore(s => s.historyOpen);
  const [catalogue, setCatalogue] = useState<HistoryCatalogue>({ documents: [], warnings: [], truncated: false });
  const [documentId, setDocumentId] = useState("");
  const [manifest, setManifest] = useState<HistoryManifest | null>(null);
  const [sequence, setSequence] = useState<number | null>(null);
  const [version, setVersion] = useState<HistoryVersion | null>(null);
  const [mode, setMode] = useState<"source" | "rendered" | "changes">("source");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const enabled = useStore(s => s.settings.historyEnabled);
  const [byteUsage,setByteUsage] = useState(0);
  const [confirmRemove,setConfirmRemove] = useState(false);
  const [confirmRelease,setConfirmRelease] = useState(false);
  const [confirmRestore,setConfirmRestore] = useState(false);
  const [missing,setMissing] = useState(false);
  const currentFile = useStore(s => activeDoc(s));
  const [confirmRelink,setConfirmRelink] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const close = () => setState({ historyOpen: null });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('[data-history-close]')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void historyApi.catalogue().then(result => {
      if (cancelled) return;
      setCatalogue(result);
      void historyApi.usage().then(setByteUsage).catch(e => setError(ioMessage(e)));
      setDocumentId(result.documents.some(d => d.documentId === selectedId) ? selectedId! : result.documents[0]?.documentId ?? "");
      setBusy(false);
    }).catch(e => { if (!cancelled) { setError(ioMessage(e)); setBusy(false); } });
    return () => { cancelled = true; };
  }, [selectedId]);
  useEffect(() => {
    const selected = catalogue.documents.find(d => d.documentId === documentId) ?? null;
    setManifest(selected); setSequence(selected?.entries.at(-1)?.sequence ?? null); setVersion(null);
    setMissing(false);
    let cancelled = false;
    if (selected?.currentPath) void fsApi.exists(selected.currentPath).then(exists => { if (!cancelled) setMissing(!exists); }).catch(e => { if (!cancelled) setError(ioMessage(e)); });
    return () => { cancelled = true; };
  }, [catalogue, documentId]);
  useEffect(() => {
    if (!documentId || sequence === null) return;
    let cancelled = false; setBusy(true); setError(""); setVersion(null);
    void historyApi.read(documentId,sequence).then(result => {
      if (!cancelled) { setVersion(result); setBusy(false); }
    }).catch(e => { if (!cancelled) { setError(ioMessage(e)); setBusy(false); } });
    return () => { cancelled = true; };
  }, [documentId, sequence]);
  const current = useStore(s => s.docs.find(d => d.id === documentId)?.content ?? null);
  const changes = useMemo(() => {
    if (!version || current === null || Math.max(version.content.length,current.length) > 100_000) return null;
    return diffWords(version.content.replace(/\r\n?/g,"\n"),current);
  }, [version,current]);
  const rendered = useMemo(() => version && mode === "rendered" && version.content.length <= PREVIEW_LIMIT ? offlinePreview(version.content) : "", [version,mode]);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {
      const nodes = [...(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])];
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      e.preventDefault(); nodes[(index + (e.shiftKey ? nodes.length-1 : 1)) % nodes.length]?.focus();
    }
    e.stopPropagation();
  };
  const recover = async (recreate = false) => {
    if (!version || !manifest) return;
    setBusy(true);
    const id = await recoverHistoryVersion(documentId,version.entry.sequence);
    if (!id) { setBusy(false); return; }
    close();
    if (recreate) await saveDocAs(id);
    else toast("Opened as a new document. Use Save As to choose where to keep it.");
  };
  const restore = async () => {
    if (!version) return;
    setBusy(true); setConfirmRestore(false);
    if (await restoreHistoryVersion(documentId,version.entry.sequence)) close();
    else setBusy(false);
  };
  const relink = async () => {
    if (!currentFile) return;
    setBusy(true); setConfirmRelink(false);
    if (await relinkHistory(documentId,currentFile.id)) close(); else setBusy(false);
  };
  const removeCopies = async () => {
    // Turn history off first so no new version lands mid-removal; turn it back on if removal fails.
    const wasEnabled = getState().settings.historyEnabled;
    getState().setSettings({ historyEnabled: false }); setBusy(true); setError("");
    try {
      await historyApi.removeAll(); setCatalogue({ documents: [], warnings: [], truncated: false });
      setDocumentId(""); setSequence(null); setVersion(null); setByteUsage(await historyApi.usage());
      setState({ historyWarning: null }); setConfirmRemove(false);
    } catch (error) { getState().setSettings({ historyEnabled: wasEnabled }); setError(ioMessage(error)); } finally { setBusy(false); }
  };
  const releaseCheckpoint = async () => {
    if (!version?.entry.operation) return;
    setBusy(true); setError("");
    try {
      await historyApi.release(documentId,version.entry.operation);
      const result = await historyApi.catalogue(); setCatalogue(result);
      setConfirmRelease(false);
    } catch (error) { setError(ioMessage(error)); } finally { setBusy(false); }
  };
  return <div className="scrim dim" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={root} className="history-panel popover" role="dialog" aria-modal="true" aria-labelledby="history-title" aria-describedby="history-description" onKeyDown={onKey}>
      <header><h2 id="history-title">Version history</h2><button className="btn" type="button" data-history-close onClick={close}>Close</button></header>
      <p id="history-description">Earlier versions of your documents, kept on this computer. Looking at or opening an old version never changes your file.</p>
      <label className="history-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={e => getState().setSettings({ historyEnabled: e.target.checked })}/>Keep version history</label>
      <p className="muted">AmberText keeps a version about every five minutes while you write, and each time you save: every version from the past week, then one a day for 90 days. Using {(byteUsage/1024/1024).toFixed(1)} MB of 250 MB. If space runs low, older versions are removed first from the documents that take up the most room. The latest version of every document is always kept. Old versions can still contain text you’ve since deleted.</p>
      <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(true)}>Turn off and delete history…</button>
      {confirmRemove && <section role="alert" className="history-confirm"><p>Delete all saved versions and turn version history off? Your documents and crash recovery aren’t affected.</p><button type="button" className="btn" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</button><button type="button" className="btn danger" disabled={busy} onClick={() => void removeCopies()}>Delete history</button></section>}
      {error && <p role="alert">{error}</p>}
      {catalogue.warnings.map((message,i) => <p key={i} role="status">{message}</p>)}
      {catalogue.truncated && <p role="status">Not every document could be listed.</p>}
      {!catalogue.documents.length && !busy && <p>No versions yet.</p>}
      {!!catalogue.documents.length && <div className="history-controls">
        <label>Document<select aria-label="Document" value={documentId} onChange={e => setDocumentId(e.target.value)}>
          {catalogue.documents.map(d => <option key={d.documentId} value={d.documentId}>{d.name} — {d.currentPath ?? "Not saved to a file"}</option>)}
        </select></label>
        <label>Version<select aria-label="Version" value={sequence ?? ""} onChange={e => setSequence(Number(e.target.value))}>
          {[...(manifest?.entries ?? [])].reverse().map(entry => <option key={entry.sequence} value={entry.sequence}>{new Date(entry.capturedAt).toLocaleString()} — {reasonLabel(entry.reason)}{entry.representation === "raw-disk" ? " (as it was on disk)" : ""}</option>)}
        </select></label>
        <div className="history-modes" role="group" aria-label="Show version as">
          {(["source","rendered","changes"] as const).map(value => <button className="btn" type="button" key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>{value === "changes" ? "Compare with now" : value === "rendered" ? "Formatted" : "Plain text"}</button>)}
        </div>
      </div>}
      {busy && <p role="status">Loading…</p>}
      {version && <div className="history-preview" tabIndex={0} aria-label="Preview of this version" onClick={e => { if ((e.target as HTMLElement).closest("a")) e.preventDefault(); }}>
        {version.content.length > PREVIEW_LIMIT && <p>This version is long, so only the first {PREVIEW_LIMIT.toLocaleString()} characters are shown. Opening or restoring it brings back all of it.</p>}
        {mode === "source" || version.content.length > PREVIEW_LIMIT ? <pre>{version.content.slice(0,PREVIEW_LIMIT)}</pre>
          : mode === "rendered" ? <><p className="muted">Images aren’t shown in this preview.</p><article className="prose" dangerouslySetInnerHTML={{ __html: rendered }}/></>
          : changes ? <pre className="history-diff">{changes.map((part,i) => part.type === "del" ? <del key={i}>{part.text}</del> : part.type === "add" ? <ins key={i}>{part.text}</ins> : <span key={i}>{part.text}</span>)}</pre>
          : <><p>{current === null ? "Open this document to compare it with what you have now." : "This version is too long to compare word by word, so here is its text."}</p><pre>{version.content.slice(0,PREVIEW_LIMIT)}</pre></>}
      </div>}
      <footer><button className="btn primary" type="button" disabled={!version || busy} onClick={() => void recover()}>Open as new document</button>{missing && <button type="button" className="btn" disabled={!version || busy} onClick={() => void recover(true)}>Save as a file…</button>}{current !== null && manifest?.currentPath && !missing && <button type="button" className="btn" disabled={!version || busy || !enabled} onClick={() => setConfirmRestore(true)}>Restore this version…</button>}{version?.entry.operation && <button type="button" className="btn" disabled={busy} onClick={() => setConfirmRelease(true)}>Stop keeping this version…</button>}</footer>
      {confirmRestore && <section role="alert" className="history-confirm"><p>Replace what’s in the document now with this version? AmberText keeps a copy of the current text first, and you can undo.</p><button type="button" className="btn" disabled={busy} onClick={() => setConfirmRestore(false)}>Cancel</button><button type="button" className="btn danger" disabled={busy} onClick={() => void restore()}>Restore</button></section>}
      {currentFile?.path && currentFile.id !== documentId && (missing || samePath(manifest?.currentPath, currentFile.path)) && <button type="button" className="btn" disabled={busy || !enabled} onClick={() => setConfirmRelink(true)}>Link to the open document…</button>}
      {confirmRelink && <section role="alert" className="history-confirm"><p>Show these versions as the history of the open document? Nothing in the document changes, and any versions it already has stay available.</p><button type="button" className="btn" disabled={busy} onClick={() => setConfirmRelink(false)}>Cancel</button><button type="button" className="btn" disabled={busy} onClick={() => void relink()}>Link versions</button></section>}
      {confirmRelease && <section role="alert" className="history-confirm"><p>This version was kept safe because of a replace across files. Let AmberText remove it like any other old version? Open it as a new document first if you want a copy. Your file doesn’t change.</p><button type="button" className="btn" disabled={busy} onClick={() => setConfirmRelease(false)}>Cancel</button><button type="button" className="btn" disabled={busy} onClick={() => void releaseCheckpoint()}>Stop keeping it</button></section>}
    </div>
  </div>;
}
