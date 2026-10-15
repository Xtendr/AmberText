import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useStore } from "../state/store";
import { useWorkspaceSearch } from "../lib/workspaceSearch";
import { useWorkspaceReplacement, setReplacement, previewWorkspaceReplacement, selectReplacement, clearReplacementReview } from "../lib/workspaceReplacement";
import { useWorkspaceBatch, applyWorkspaceReplacement, stopWorkspaceBatch, loadReplacementReceipts, revertReplacementFile, recoverReplacementOriginal, recoverReplacementResult, inspectReplacementReceipt, releaseReplacementReceipt } from "../lib/workspaceBatch";
import { ask } from "../state/actions";

const RECEIPT_STATES = { running: "Didn’t finish — check what happened", stopped: "Stopped", complete: "Done", releasing: "Clearing copies didn’t finish", released: "Copies cleared" } as const;
const FILE_STATES = { pending: "Not started", prepared: "Not started", applying: "Needs checking", applied: "Replaced", skipped: "Skipped", failed: "Not changed", reverting: "Needs checking", reverted: "Undone", conflict: "Edited since — not undone" } as const;

export function WorkspaceReplacementPanel() {
  const state = useWorkspaceReplacement();
  const search = useWorkspaceSearch();
  const autosave = useStore(s => s.settings.autosave);
  const historyEnabled = useStore(s => s.settings.historyEnabled);
  const batch = useWorkspaceBatch();
  const [expanded, setExpanded] = useState<string | null>(null);
  const review = state.review;
  const selected = review?.proposals.filter(p => p.selected) ?? [];
  const count = selected.reduce((sum, p) => sum + p.ranges.length, 0);
  const apply = async () => {
    const reviewedId = review?.id;
    const answer = await ask({ title: `Replace in ${selected.length} ${selected.length === 1 ? "file" : "files"}?`, message: `This makes ${count} ${count === 1 ? "change" : "changes"}. Changes in open documents can be undone as usual; closed files are saved straight away. AmberText keeps a copy of each file first. Any file that changed since the preview is skipped, and the others still go ahead.`,
      actions: [{ id: "cancel", label: "Cancel" }, { id: "apply", label: "Replace", kind: "primary" }] });
    if (answer?.action === "apply" && reviewedId === useWorkspaceReplacement.getState().review?.id) await applyWorkspaceReplacement();
  };
  return <section className="workspace-replacement" aria-label="Replace">
    <div className="ws-field">
      <label htmlFor="workspace-replacement" className="sr-only">Replace with</label>
      <textarea id="workspace-replacement" rows={1} disabled={batch.busy} spellCheck={false} placeholder="Replace with" value={state.replacement} onChange={e => setReplacement(e.target.value)} />
    </div>
    {(!!search.hits.length || state.busy) && !review && <div className="ws-actions">
      <span className="muted">Nothing changes until you confirm.</span>
      <button type="button" className="btn sm" disabled={batch.busy || state.busy || search.busy || search.stale || !search.hits.length}
        onClick={() => { setExpanded(null); void previewWorkspaceReplacement(); }}>{state.busy ? "Preparing…" : "Preview changes"}</button>
    </div>}
    {state.error && <p role="alert" className="ws-alert">{state.error}</p>}
    {review && <div className="ws-review">
      <p role="status" aria-live="polite" aria-atomic="true">{selected.length} {selected.length === 1 ? "file" : "files"} selected, {count} {count === 1 ? "change" : "changes"}.
        {review.stale && " Your writing has changed since this preview. Search and preview again."}
        {review.partial && " Only the listed matches are included."}</p>
      <p className="muted">Open documents can be undone as usual{autosave ? "" : " and stay unsaved until you save them"}. Closed files are saved straight away. AmberText keeps a copy of each file first.</p>
      {!!review.warnings.length && <details className="sb-disclosure"><summary><ChevronRight size={12} strokeWidth={2.2} />Files left out</summary><ul>{review.warnings.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}
      {review.proposals.map(p => <section key={review.id + p.path} aria-label={p.relativePath} className="ws-proposal">
        <label className="ws-check"><input type="checkbox" checked={p.selected} disabled={review.stale || batch.busy} onChange={e => selectReplacement(p.path, e.target.checked)} />
          <span>{p.relativePath} — {p.ranges.length} {p.ranges.length === 1 ? "change" : "changes"}</span></label>
        <div className="ws-proposal-meta">
          <span className="muted">{p.open ? p.dirty ? "Open · unsaved changes" : "Open" : "Not open"}</span>
          <button type="button" className="ws-link" aria-expanded={expanded === p.path} onClick={() => setExpanded(expanded === p.path ? null : p.path)}>
            {expanded === p.path ? "Hide before and after" : "Show before and after"}
          </button>
        </div>
        {expanded === p.path && <div className="workspace-replacement-comparison">
          <h5>Before</h5><pre tabIndex={0} aria-label={"Before " + p.relativePath}>{p.before}</pre>
          <h5>After</h5><pre tabIndex={0} aria-label={"After " + p.relativePath}>{p.after}</pre>
        </div>}
      </section>)}
      {!historyEnabled && <p className="ws-alert">Turn on version history in Settings first, so AmberText can keep a copy of each file before changing it.</p>}
      <div className="ws-actions">
        <button type="button" className="btn sm ghost" disabled={batch.busy} onClick={clearReplacementReview}>Close preview</button>
        <button type="button" className="btn sm primary" disabled={batch.busy || review.stale || !selected.length || !historyEnabled} onClick={() => void apply()}>Replace in selected files…</button>
      </div>
    </div>}
    {batch.busy && <div className="ws-actions"><p role="status">Replacing…</p><button type="button" className="btn sm" onClick={stopWorkspaceBatch}>Stop after this file</button></div>}
    {batch.error && <p role="alert" className="ws-alert">{batch.error}</p>}
  </section>;
}

/** Past replacements, each with copies of the files from before and after. */
export function ReplacementReceipts() {
  const batch = useWorkspaceBatch();
  const historyEnabled = useStore(s => s.settings.historyEnabled);
  const [receiptsShown, setReceiptsShown] = useState(5);
  useEffect(() => { void loadReplacementReceipts(); }, []);
  return <details className="sb-disclosure workspace-replacement-receipts">
    <summary><ChevronRight size={12} strokeWidth={2.2} />Past replacements ({batch.records.length})</summary>
    <div className="ws-actions">
      <span className="muted">{batch.records.length ? "Undo a replacement, or open a file as it was." : "Replacements across files are listed here."}</span>
      <button type="button" className="ws-link" disabled={batch.busy} onClick={() => void loadReplacementReceipts()}>Refresh</button>
    </div>
    {batch.truncated && <p className="muted">Only some past replacements could be loaded.</p>}
    {batch.warnings.map((warning, i) => <p key={i} role="alert" className="ws-alert">{warning}</p>)}
    {batch.records.slice(0, receiptsShown).map(record => <details key={record.receipt.id} className="ws-receipt">
      <summary><ChevronRight size={12} strokeWidth={2.2} />{new Date(record.receipt.createdAt).toLocaleString()} · {record.receipt.files.length} {record.receipt.files.length === 1 ? "file" : "files"} · {RECEIPT_STATES[record.receipt.state]}</summary>
      <p className="muted">AmberText kept a copy of each file before and after this replacement. You can open either copy as a new document, or undo the change in a file you haven’t edited since.</p>
      {record.receipt.state === "releasing" && <p role="status">Clearing these copies was interrupted, and some may already be gone. Try again to finish.</p>}
      {!["released", "releasing"].includes(record.receipt.state) && <button type="button" className="btn sm" disabled={batch.busy} onClick={() => void inspectReplacementReceipt(record.receipt.id)}>Check what happened</button>}
      {record.receipt.files.map((file, i) => <section key={file.documentId} aria-label={"Replacement result " + file.relativePath} className="ws-receipt-file">
        <h5>{file.relativePath} · {FILE_STATES[file.state]}</h5>
        <p className="muted">{file.message}</p>
        <div className="ws-actions start">
          {file.beforeSequence && !["released", "releasing"].includes(record.receipt.state) && <button type="button" className="btn sm" disabled={batch.busy} onClick={() => void recoverReplacementOriginal(file)}>Open the version before</button>}
          {file.afterSequence && !["released", "releasing"].includes(record.receipt.state) && <button type="button" className="btn sm" disabled={batch.busy} onClick={() => void recoverReplacementResult(file)}>Open the version after</button>}
          {["applied", "applying", "reverting", "conflict"].includes(file.state) && !["released", "releasing"].includes(record.receipt.state) && <button type="button" className="btn sm" disabled={batch.busy || !historyEnabled} onClick={() => void revertReplacementFile(record.receipt.id, i)}>Undo in this file</button>}
        </div>
      </section>)}
      {record.receipt.state !== "released" && <button type="button" className="btn sm ghost" disabled={batch.busy} onClick={async () => {
        const answer = await ask({ title: "Stop keeping these copies?", message: "The before and after copies from this replacement will be removed over time like other old versions, and you won’t be able to undo it from here. Your files don’t change.",
          actions: [{ id: "cancel", label: "Cancel" }, { id: "release", label: "Stop keeping copies", kind: "primary" }] });
        if (answer?.action === "release") await releaseReplacementReceipt(record.receipt.id);
      }}>{record.receipt.state === "releasing" ? "Try again…" : "Stop keeping copies…"}</button>}
    </details>)}
    {batch.records.length > receiptsShown && <button type="button" className="btn sm" onClick={() => setReceiptsShown(n => n + 5)}>Show more results</button>}
  </details>;
}
