import { useLayoutEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Link, X } from "lucide-react";
import { setState, useStore } from "../state/store";
import { basename } from "../lib/paths";
import { scanAssetDiagnostics, stopAssetDiagnostics, useAssetDiagnostics } from "../lib/assetDiagnostics";

const STATUS: Record<string, string> = { present: "Found", missing: "Missing", unknown: "Couldn’t check", remote: "Web address (not checked)", embedded: "Embedded in the document", fragment: "Link within the document", unresolved: "Couldn’t tell where this points" };

export function AssetDiagnosticsPanel() {
  const state = useAssetDiagnostics(), root = useStore(s => s.workspace?.root);
  const [shown, setShown] = useState(100);
  const dialog = useRef<HTMLDivElement>(null);
  const close = () => setState({ assetsOpen: false });
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("[data-assets-start]:not(:disabled), [data-assets-close]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "Tab") {
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>("button:not([disabled]), summary, [tabindex=\"0\"]") ?? [])];
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      e.preventDefault(); nodes[(index + (e.shiftKey ? nodes.length - 1 : 1)) % nodes.length]?.focus();
    }
    e.stopPropagation();
  };
  const missing = state.records.filter(r => r.status === "missing").length;
  const shared = new Set(state.records.filter(r => r.documents > 1).map(r => r.canonicalPath)).size;
  return <div className="scrim dim" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div ref={dialog} className="tool-dialog popover" role="dialog" aria-modal="true" aria-labelledby="assets-title" aria-describedby="assets-description" onKeyDown={onKey}>
      <header className="tool-dialog-head">
        <h2 id="assets-title">Images and links</h2>
        <button type="button" className="icon-btn" aria-label="Close" data-tip="Close" data-kbd="Esc" data-assets-close onClick={close}><X size={16} /></button>
      </header>
      <div className="tool-dialog-body">
        <p id="assets-description" className="muted">Finds images and links{root ? <> in <strong>{basename(root)}</strong></> : ""} that point to missing files. Nothing is changed, and web addresses aren’t visited.</p>
        <div className="tool-dialog-bar">
          <p role="status" aria-live="polite" aria-atomic="true">{state.stale ? "Your writing has changed. Check again to update." : state.busy ? `Checking… ${state.coverage.scanned} documents so far.`
            : state.root ? `Checked ${state.coverage.scanned} ${state.coverage.scanned === 1 ? "document" : "documents"}: ${missing === 0 ? "nothing missing" : `${missing} missing`}${shared ? `, ${shared} ${shared === 1 ? "file" : "files"} used in more than one document` : ""}.` : root ? "" : "Open a folder to check local images and links."}
            {state.coverage.partial && " Not every document could be checked."}{state.coverage.cancelled && " Check stopped."}</p>
          {state.busy && <button type="button" className="btn" onClick={stopAssetDiagnostics}>Stop</button>}
          <button type="button" className="btn primary" data-assets-start disabled={!root || state.busy} onClick={() => { setShown(100); void scanAssetDiagnostics(); }}>{state.root ? "Check again" : "Check images and links"}</button>
        </div>
        {state.error && <p role="alert" className="tool-dialog-error">{state.error}</p>}
        {!!state.coverage.warnings.length && <details className="sb-disclosure"><summary>Documents that couldn’t be fully checked</summary><ul>{state.coverage.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        {!!state.records.length && <div className="asset-list">
          {state.records.slice(0, shown).map((record, i) => <section key={record.sourcePath + ":" + record.sourceSpan[0] + ":" + i} className="asset-row" aria-label={record.relativePath}>
            {record.kind === "image" ? <ImageIcon size={15} className="asset-icon" /> : <Link size={15} className="asset-icon" />}
            <div className="asset-main">
              <div className="asset-target">{record.target ?? `No address given for “${record.label}”`}</div>
              <div className="asset-meta"><FileText size={12} />{record.relativePath}{record.source === "buffer" ? " · Unsaved changes" : ""}{record.outside && " · outside this folder"}{record.uses > 1 && ` · used ${record.uses} times in ${record.documents} ${record.documents === 1 ? "document" : "documents"}`}</div>
              {record.message && <div className="asset-meta">{record.message}</div>}
              {record.path && <div className="asset-meta">{record.path}</div>}
            </div>
            <span className={`asset-status is-${record.status}`}>{STATUS[record.status] ?? record.status}</span>
          </section>)}
        </div>}
        {state.records.length > shown && <button type="button" className="btn" onClick={() => setShown(n => n + 100)}>Show next {Math.min(100, state.records.length - shown)} more</button>}
        <p className="muted tool-dialog-note">Only images and links written in Markdown are checked, so this can’t tell you which files are safe to delete.</p>
      </div>
    </div>
  </div>;
}
