import { create } from "zustand";
import { bridge } from "../editor/bridge";
import { getState } from "../state/store";
import { updateContent, flushRecovery, recoverHistoryVersion } from "../state/actions";
import { fsApi, ioMessage, isIoFailure, sameRevision, type IoFailure, type SavedFile, type TextFile } from "./platform";
import { basename, samePath } from "./paths";
import { historyApi } from "./history";
import { searchHash } from "./workspaceSearch";
import { useWorkspaceReplacement, type ReplacementProposal } from "./workspaceReplacement";
import { replacementReceiptApi, type ReceiptRecord, type ReplacementReceipt, type ReplacementFileReceipt } from "./replacementReceipts";

interface State { busy: boolean; records: ReceiptRecord[]; error: string | null; warnings: string[]; truncated: boolean }
export const useWorkspaceBatch = create<State>(() => ({ busy: false, records: [], error: null, warnings: [], truncated: false }));
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
let stop = false;
export function stopWorkspaceBatch() { stop = true; }
function display(record: ReceiptRecord) {
  useWorkspaceBatch.setState(s => ({ records: [structuredClone(record), ...s.records.filter(r => r.receipt.id !== record.receipt.id)] }));
}
export async function loadReplacementReceipts() {
  try { const catalogue = await replacementReceiptApi.catalogue(); useWorkspaceBatch.setState({ ...catalogue, error: null }); }
  catch (error) { useWorkspaceBatch.setState({ error: ioMessage(error) }); }
}
async function persist(record: ReceiptRecord | null, receipt: ReplacementReceipt) {
  receipt.updatedAt = Date.now();
  const saved = await replacementReceiptApi.write(structuredClone(receipt), record?.revision ?? null);
  display(saved); return saved;
}
function tabs(path: string, canonical: string) {
  return getState().docs.filter(d => samePath(d.path, path) || d.revision?.canonicalPath === canonical);
}
async function preflight(p: ReplacementProposal): Promise<TextFile> {
  const disk = await fsApi.readText(p.path);
  if (!sameRevision(p.revision, disk.revision)) throw new Error("The file changed after the preview, so it was skipped.");
  const open = tabs(p.path, disk.revision.canonicalPath);
  if (p.open) {
    const doc = open[0];
    if (open.length !== 1 || doc.id !== p.documentId || doc.saving || doc.conflict || doc.content !== p.before
      || !sameRevision(doc.revision, disk.revision) || JSON.stringify(doc.format) !== JSON.stringify(p.format)) {
      throw new Error("The open document changed while preparing. Preview again.");
    }
    const state = bridge.viewDocId === doc.id ? bridge.view?.state : bridge.states.get(doc.id)?.state;
    if (!state || state.doc.toString() !== p.before) throw new Error("Open this document first, so the change can be undone.");
  } else {
    if (open.length) throw new Error("This file has just been opened. Preview again before replacing.");
    if (normalize(disk.content) !== p.before || !p.format.confirmed || p.format.eol === "mixed") {
      throw new Error("Open and save this file once yourself before replacing in it.");
    }
  }
  if (await searchHash(p.before) !== p.contentHash || await searchHash(p.after) !== p.afterHash) throw new Error("The text changed since the preview. Preview again.");
  return disk;
}
async function checkpoint(file: ReplacementFileReceipt, p: ReplacementProposal, disk: TextFile, operation: string) {
  const capture = async (content: string | null, raw: boolean, reason: string) => {
    const manifest = await historyApi.capture({ documentId: file.documentId, name: basename(p.path), currentPath: p.path,
      content, diskRevision: raw ? disk.revision : null, format: raw ? disk.format : p.format, reason, operation });
    const entry = manifest.entries.at(-1);
    if (!entry || entry.operation !== operation) throw new Error("AmberText couldn’t keep a copy first, so nothing was changed.");
    return entry.sequence;
  };
  file.diskSequence = await capture(null, true, "before-bulk");
  file.beforeSequence = await capture(p.before, false, "before-bulk");
  // Store the reviewed result before editing as well: interrupted unsaved tabs
  // remain recoverable even if ordinary session recovery fails immediately.
  file.afterSequence = await capture(p.after, false, "before-bulk");
}
/** Apply a frozen review one file at a time; never re-search after review. */
export async function applyWorkspaceReplacement(): Promise<boolean> {
  if (useWorkspaceBatch.getState().busy) return false;
  const review = useWorkspaceReplacement.getState().review;
  if (!review || review.stale || !review.proposals.some(p => p.selected)) return false;
  if (!getState().settings.historyEnabled) { useWorkspaceBatch.setState({ error: "Turn on local history before applying replacements, so originals can be protected." }); return false; }
  const selected = structuredClone(review.proposals.filter(p => p.selected));
  const root = review.root;
  stop = false; useWorkspaceBatch.setState({ busy: true, error: null });
  let record: ReceiptRecord | null = null;
  let receipt: ReplacementReceipt | null = null;
  try {
    // Files with several earlier identities are merged to the most recent one.
    const ids: string[] = [];
    for (const p of selected) ids.push(p.documentId ?? await historyApi.resolve(p.path, p.revision.canonicalPath, []) ?? crypto.randomUUID());
    receipt = { version: 1, id: crypto.randomUUID(), root, createdAt: Date.now(), updatedAt: Date.now(), state: "running",
      files: selected.map((p, i) => {
        return { documentId: ids[i], path: p.path, relativePath: p.relativePath,
          mode: p.open ? "buffer" : "disk", beforeHash: p.contentHash, afterHash: p.afterHash, beforeRevision: p.revision,
          afterRevision: null, beforeSequence: null, afterSequence: null, diskSequence: null, state: "pending", message: "" };
      }) };
    if (useWorkspaceReplacement.getState().review?.id !== review.id || useWorkspaceReplacement.getState().review?.stale) throw new Error("The preview changed before replacing started. Preview again.");
    record = await persist(null, receipt);
    for (let i = 0; i < selected.length; i++) {
      const file = receipt.files[i], p = selected[i];
      if (stop || getState().workspace?.root !== root) {
        stop = true; file.state = "skipped"; file.message = "Not changed, because replacing was stopped."; continue;
      }
      let attempted = false;
      try {
        if (!getState().settings.historyEnabled) throw new Error("Version history was turned off, so this file wasn’t changed.");
        const disk = await preflight(p);
        await checkpoint(file, p, disk, receipt.id);
        file.state = "prepared"; record = await persist(record, receipt);
        await preflight(p);
        file.state = "applying"; record = await persist(record, receipt);
        await preflight(p);
        if (getState().workspace?.root !== root || !getState().settings.historyEnabled) throw new Error("The folder or version history setting changed, so nothing was replaced.");
        if (p.open) {
          // This synchronous final guard follows all asynchronous checkpoints.
          const doc = getState().docs.find(d => d.id === p.documentId);
          const open = tabs(p.path, p.revision.canonicalPath);
          if (!doc || open.length !== 1 || open[0].id !== doc.id || doc.content !== p.before || doc.saving || doc.conflict
            || !sameRevision(doc.revision, p.revision) || JSON.stringify(doc.format) !== JSON.stringify(p.format)) throw new Error("The writing changed just before replacing. Preview again.");
          let applied = false;
          try { applied = bridge.applyReviewedChanges(doc.id, p.before, p.ranges.map(([from, to]) => ({ from, to, insert: review.replacement })), p.after); }
          catch (error) { attempted = true; throw error; }
          if (!applied) throw new Error("The document changed just before replacing, so it was left alone. Preview again.");
          attempted = true;
          updateContent(doc.id, p.after);
          file.message = getState().settings.autosave ? "Replaced in the open document. You can undo, and it saves as usual." : "Open tab edited with Undo; left unsaved.";
        } else {
          if (tabs(p.path, p.revision.canonicalPath).length) throw new Error("This file has just been opened. Preview again before replacing.");
          attempted = true;
          let saved: SavedFile;
          try { saved = await fsApi.writeText(p.path, p.after, p.revision, p.format); }
          catch (error) {
            // These refusals happen before anything is replaced; only other failures may follow a write.
            if (["conflict", "missing", "permission", "unsupported", "confirmation", "invalid"].some(kind => isIoFailure(error, kind as IoFailure["kind"]))) attempted = false;
            throw error;
          }
          file.afterRevision = saved.revision; file.message = "Saved.";
        }
        file.state = "applied";
      } catch (error) {
        // An error after a write attempt may follow a successful replacement.
        // Keep uncertainty explicit; never call it an automatic rollback.
        file.state = attempted ? "applying" : "skipped";
        if (attempted) stop = true;
        file.message = (attempted ? "Needs checking. " : "Not changed. ") + ioMessage(error).slice(0, 3500);
      }
      // A receipt failure stops the batch before another file can change.
      record = await persist(record, receipt);
    }
    receipt.state = stop ? "stopped" : "complete";
    record = await persist(record, receipt);
    if (!await flushRecovery()) useWorkspaceBatch.setState({ error: "Session recovery could not be updated. Checkpointed originals and reviewed results remain in this receipt; keep unsaved tabs open." });
    return receipt.files.every(f => f.state === "applied");
  } catch (error) {
    if (record && receipt) display({ ...record, receipt });
    useWorkspaceBatch.setState({ error: "Replacement stopped: " + ioMessage(error) + " Completed changes are retained; inspect the receipt before retrying." });
    return false;
  } finally { useWorkspaceBatch.setState({ busy: false }); }
}
/** Revert is a new conditional edit, never a batch-wide rollback. */
export async function revertReplacementFile(id: string, index: number): Promise<boolean> {
  if (useWorkspaceBatch.getState().busy || !getState().settings.historyEnabled) return false;
  useWorkspaceBatch.setState({ busy: true, error: null });
  try {
    const catalogue = await replacementReceiptApi.catalogue();
    let record = catalogue.records.find(r => r.receipt.id === id);
    if (!record || ["released", "releasing"].includes(record.receipt.state)) throw new Error("This past replacement can’t be found.");
    const receipt = structuredClone(record.receipt), file = receipt.files[index];
    if (!file || !["applied", "applying", "reverting", "conflict"].includes(file.state) || !file.beforeSequence) throw new Error("There’s no earlier version of this file to go back to.");
    const before = await historyApi.read(file.documentId, file.beforeSequence);
    const text = normalize(before.content);
    if (await searchHash(text) !== file.beforeHash) throw new Error("The saved earlier version doesn’t match. Nothing has been deleted.");
    const verify = async () => {
      const disk = await fsApi.readText(file.path), open = tabs(file.path, disk.revision.canonicalPath), doc = open[0];
      if (open.length > 1) throw new Error("This file is open in more than one tab, so it wasn’t undone. Close the extra tab and try again.");
      if (doc) {
        if (doc.saving || doc.conflict || !sameRevision(doc.revision, disk.revision) || await searchHash(doc.content) !== file.afterHash
          || JSON.stringify(doc.format) !== JSON.stringify(before.entry.format)) throw new Error("The file has changed since, so it wasn’t undone.");
        const state = bridge.viewDocId === doc.id ? bridge.view?.state : bridge.states.get(doc.id)?.state;
        if (!state || state.doc.toString() !== doc.content) throw new Error("Open this document first, so the change can be undone.");
      } else {
        if (file.mode === "buffer") throw new Error("That document has been closed, so it wasn’t undone. You can still open the version from before.");
        if (!file.afterRevision || !sameRevision(file.afterRevision, disk.revision) || await searchHash(normalize(disk.content)) !== file.afterHash) throw new Error("The file has changed since, so it wasn’t undone.");
      }
      return { disk, doc };
    };
    await verify();
    file.state = "reverting"; record = await persist(record, receipt);
    const checked = await verify();
    if (checked.doc) {
      const current = getState().docs.find(d => d.id === checked.doc!.id);
      const open = tabs(file.path, checked.disk.revision.canonicalPath);
      if (!current || open.length !== 1 || open[0].id !== current.id || current.content !== checked.doc.content || current.saving || current.conflict
        || JSON.stringify(current.format) !== JSON.stringify(before.entry.format) || !sameRevision(current.revision, checked.disk.revision)) throw new Error("You’ve edited this since, so it wasn’t undone.");
      if (!bridge.applyReviewedChanges(current.id, current.content, [{ from: 0, to: current.content.length, insert: text }], text)) throw new Error("The document changed just before undoing, so nothing was undone. Try again.");
      updateContent(current.id, text); file.message = "Undone in the open document.";
    } else {
      if (tabs(file.path, checked.disk.revision.canonicalPath).length) throw new Error("The file was just opened. Check it, then try undoing again.");
      const saved = await fsApi.writeText(file.path, text, checked.disk.revision, before.entry.format);
      file.afterRevision = saved.revision; file.message = "Undone and saved.";
    }
    file.state = "reverted"; await persist(record, receipt);
    if (!await flushRecovery()) useWorkspaceBatch.setState({ error: "Revert changed the writing but session recovery needs attention. Keep the tab open; its protected copies remain." });
    return true;
  } catch (error) {
    useWorkspaceBatch.setState({ error: "Revert not completed: " + ioMessage(error) + " Inspect the file or recover the original as a draft." });
    return false;
  } finally { useWorkspaceBatch.setState({ busy: false }); }
}
export async function recoverReplacementOriginal(file: ReplacementFileReceipt) {
  if (file.beforeSequence) return recoverHistoryVersion(file.documentId, file.beforeSequence);
  return null;
}
export async function recoverReplacementResult(file: ReplacementFileReceipt) {
  if (file.afterSequence) return recoverHistoryVersion(file.documentId, file.afterSequence);
  return null;
}
/** Read current sources to resolve interrupted receipt states, without editing. */
export async function inspectReplacementReceipt(id: string): Promise<boolean> {
  if (useWorkspaceBatch.getState().busy) return false;
  useWorkspaceBatch.setState({ busy: true, error: null });
  try {
    const catalogue = await replacementReceiptApi.catalogue();
    let record = catalogue.records.find(r => r.receipt.id === id);
    if (!record || ["released", "releasing"].includes(record.receipt.state)) throw new Error("This past replacement can’t be found.");
    const receipt = structuredClone(record.receipt);
    const history = await historyApi.catalogue();
    if (history.truncated || history.warnings.length) throw new Error("Version history needs attention before this can be checked. Nothing has been deleted.");
    for (const file of receipt.files) {
      if (!["pending", "prepared", "applying", "reverting"].includes(file.state)) continue;
      // A process can stop after a checkpoint commits but before its returned
      // sequence reaches the receipt. Recover links from the operation's pins.
      try {
        const manifest = history.documents.some(d => d.documentId === file.documentId) ? await historyApi.versions(file.documentId) : null;
        if (!manifest && (file.beforeSequence || file.afterSequence || file.diskSequence)) throw new Error("The saved copies for this file are missing.");
        for (const entry of manifest?.entries.filter(e => e.operation === receipt.id) ?? []) {
          if (entry.representation === "raw-disk") file.diskSequence ??= entry.sequence;
          else {
            const version = await historyApi.read(file.documentId, entry.sequence);
            const fingerprint = await searchHash(normalize(version.content));
            if (fingerprint === file.beforeHash) file.beforeSequence ??= entry.sequence;
            if (fingerprint === file.afterHash) file.afterSequence ??= entry.sequence;
          }
        }
      } catch (error) {
        file.message = "Check this file. " + ioMessage(error).slice(0, 3500);
        continue;
      }
      if (["pending", "prepared"].includes(file.state)) {
        file.state = "skipped"; file.message = "Stopped before this file was changed."; continue;
      }
      try {
        const disk = await fsApi.readText(file.path);
        const open = tabs(file.path, disk.revision.canonicalPath);
        if (open.length > 1) throw new Error("This file is open in more than one tab. Close the extra tab and try again.");
        const source = file.mode === "buffer" ? open[0]?.content : open[0]?.content ?? normalize(disk.content);
        if (source === undefined) throw new Error("That document has been closed. You can still open the version from before or after.");
        const fingerprint = await searchHash(source);
        if (fingerprint === file.beforeHash) {
          file.state = file.state === "reverting" ? "reverted" : "skipped";
          file.message = "The file is back to how it was before.";
        } else if (fingerprint === file.afterHash) {
          if (file.mode === "disk" && !open.length) {
            if (!file.afterSequence) throw new Error("The copy from after the replacement is missing, so this can’t be undone here.");
            const result = await historyApi.read(file.documentId, file.afterSequence);
            if (JSON.stringify(disk.format) !== JSON.stringify(result.entry.format)) throw new Error("The file’s text format has changed since, so it wasn’t undone. You can still open the before and after versions.");
          }
          file.state = "applied";
          if (file.mode === "disk" && !open.length) file.afterRevision = disk.revision;
          file.message = "The replacement went through.";
        } else { file.state = "conflict"; file.message = "The file has been edited since. Your edits are kept, and you can still open the before and after versions."; }
      } catch (error) { file.message = "Needs checking. " + ioMessage(error).slice(0, 3500); }
    }
    receipt.state = receipt.files.some(f => ["applying", "reverting"].includes(f.state)) ? "running" : "stopped";
    record = await persist(record, receipt); return true;
  } catch (error) { useWorkspaceBatch.setState({ error: ioMessage(error) }); return false; }
  finally { useWorkspaceBatch.setState({ busy: false }); }
}
export async function releaseReplacementReceipt(id: string): Promise<boolean> {
  if (useWorkspaceBatch.getState().busy) return false;
  useWorkspaceBatch.setState({ busy: true, error: null });
  try {
    const catalogue = await replacementReceiptApi.catalogue();
    let record = catalogue.records.find(r => r.receipt.id === id);
    if (!record) throw new Error("This past replacement can’t be found.");
    if (record.receipt.state === "running" || record.receipt.files.some(f => ["applying", "reverting"].includes(f.state))) throw new Error("Check what happened to the unfinished files before clearing these copies.");
    // Commit intent before releasing any pin. If interrupted, never advertise
    // the copies as protected or offer revert. Releases are idempotent on retry.
    const receipt = structuredClone(record.receipt);
    if (receipt.state !== "released" && receipt.state !== "releasing") {
      receipt.state = "releasing"; record = await persist(record, receipt);
    }
    for (const file of record.receipt.files) await historyApi.release(file.documentId, id);
    if (receipt.state !== "released") { receipt.state = "released"; await persist(record, receipt); }
    return true;
  } catch (error) { useWorkspaceBatch.setState({ error: ioMessage(error) }); return false; }
  finally { useWorkspaceBatch.setState({ busy: false }); }
}
