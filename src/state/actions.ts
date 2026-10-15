import type { EditorView } from "@codemirror/view";
import { bridge } from "../editor/bridge";
import {
  demoRoot,
  dialogs,
  fsApi,
  isMac,
  isTauri,
  MARKDOWN_EXTENSIONS,
  IMAGE_EXTENSIONS,
  openExternal,
  setMaterial,
  takeLaunchFiles,
  win,
  ioMessage,
  isIoFailure,
  sameRevision,
  type FileEntry,
  type FileRevision,
  type TextFormat,
  defaultTextFormat,
} from "../lib/platform";
import { FALLBACK_KEY, parseRecovery, recoveryApi, type RecoveryDoc, type RecoverySnapshot } from "../lib/recovery";
import { historyApi } from "../lib/history";
import {
  basename,
  dirname,
  extname,
  isExternalUrl,
  isInside,
  join,
  relativeLink,
  resolvePath,
  samePath,
  sanitizeFileName,
  stripExt,
} from "../lib/paths";
import { extractHeadings, inferTitle } from "../lib/text";
import { slugify } from "../lib/markdown";
import { WELCOME_DOC, WELCOME_TITLE } from "../lib/samples";
import {
  activeDoc,
  getState,
  goalKey,
  isDirty,
  setState,
  type DialogState,
  type Doc,
  type MenuItem,
  type Toast,
  type ViewMode,
} from "./store";

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const uid = () => crypto.randomUUID();

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
const detectEol = (text: string): Doc["eol"] => (text.includes("\r\n") ? "\r\n" : "\n");

function makeDoc(p: Partial<Doc> & Pick<Doc, "content">): Doc {
  return {
    id: p.id ?? uid(),
    path: p.path ?? null,
    originalPath: p.originalPath ?? p.path ?? null,
    name: p.name ?? "Untitled",
    content: p.content,
    savedContent: p.savedContent ?? p.content,
    mtime: p.mtime ?? 0,
    revision: p.revision ?? null,
    format: p.format ?? defaultTextFormat(),
    originalText: p.originalText ?? null,
    recoveryReason: p.recoveryReason ?? null,
    eol: p.eol ?? "\n",
    saving: false,
    lastSavedAt: null,
    conflict: false,
  };
}

function patchDoc(id: string, patch: Partial<Doc> | ((d: Doc) => Partial<Doc>)) {
  setState((s) => ({
    docs: s.docs.map((d) => (d.id === id ? { ...d, ...(typeof patch === "function" ? patch(d) : patch) } : d)),
  }));
}

const findDoc = (id: string) => getState().docs.find((d) => d.id === id);

/* Local history is auxiliary. Failed ordinary captures warn; required checkpoints throw. */
export const HISTORY_INTERVAL_MS = 5 * 60 * 1000;
const historyTimers = new Map<string, number>();
const lastHistoryCapture = new Map<string, number>();
let historyFaultGeneration = 0;
let lastCaptureFailure: string | null = null;
export function historyFailure(error: unknown) {
  historyFaultGeneration++;
  setState({ historyWarning: `Local history couldn't be updated — ${ioMessage(error)}. Your writing remains open; ordinary saves still work.` });
}
export async function captureHistoryDoc(doc: Doc, reason: string, raw = false, operation: string | null = null): Promise<boolean> {
  if (!getState().settings.historyEnabled) return true;
  try {
    if (raw && (!doc.path || !doc.revision)) return true;
    await historyApi.capture({ documentId: doc.id, name: displayName(doc), currentPath: doc.path ?? null,
      content: raw ? null : doc.content, diskRevision: raw ? doc.revision : null,
      format: doc.format, reason, operation });
    lastHistoryCapture.set(doc.id,Date.now()); lastCaptureFailure = null; return true;
  } catch (error) { lastCaptureFailure = (error as { kind?: string })?.kind ?? "other"; historyFailure(error); lastHistoryCapture.set(doc.id,Date.now()); return false; }
}
function scheduleHistory(id: string) {
  if (!getState().settings.historyEnabled || historyTimers.has(id)) return;
  const delay = Math.max(0,HISTORY_INTERVAL_MS-(Date.now()-(lastHistoryCapture.get(id) ?? Date.now())));
  historyTimers.set(id,window.setTimeout(() => {
    historyTimers.delete(id);
    const doc = findDoc(id);
    if (!doc || !getState().settings.historyEnabled) return;
    if (Date.now()-(lastHistoryCapture.get(id) ?? 0) < HISTORY_INTERVAL_MS) { scheduleHistory(id); return; }
    void captureHistoryDoc(doc,"interval");
  },delay));
}
export async function maintainHistory(): Promise<boolean> {
  if (!getState().settings.historyEnabled) return false;
  try {
    const result = await historyApi.maintain();
    const names = result.trimmedDocuments;
    if (names.length) toast(`To stay under the 250 MB history limit, AmberText removed some older versions of ${names.length === 1 ? `“${names[0]}”` : `“${names[0]}” and ${names.length - 1} other document${names.length === 2 ? "" : "s"}`}.`);
    return true;
  } catch (error) { historyFailure(error); return false; }
}
export async function retryHistory(): Promise<boolean> {
  if (!getState().settings.historyEnabled) return false;
  const before = historyFaultGeneration;
  let succeeded = getState().docs.length > 0;
  for (const doc of getState().docs) {
    if (doc.path) succeeded = await captureHistoryDoc(doc,"manual-save",true) && succeeded;
    succeeded = await captureHistoryDoc(doc,"manual-save") && succeeded;
  }
  succeeded = await maintainHistory() && succeeded;
  if (succeeded && historyFaultGeneration === before) setState({ historyWarning: null });
  return succeeded && historyFaultGeneration === before;
}
export async function initializeHistory(): Promise<void> {
  if (!getState().settings.historyEnabled) return;
  for (const doc of getState().docs) {
    if (doc.path) await captureHistoryDoc(doc,"opening",true);
    if (isDirty(doc)) await captureHistoryDoc(doc,"opening");
  }
  await maintainHistory();
}
async function historyCheckpoint(doc: Doc, reason: string, disk?: { revision: FileRevision; content: string; format: TextFormat }): Promise<string | null> {
  if (!getState().settings.historyEnabled) return null;
  const operation = uid();
  try {
    if ((disk && !await captureHistoryDoc({ ...doc, revision: disk.revision, format: disk.format },reason,true,operation)) || !await captureHistoryDoc(doc,reason,false,operation)) {
      // A changed file or damaged history still stops. A copy that merely can't be stored warns; the user decides.
      await finishHistoryCheckpoint(doc.id,operation);
      if (lastCaptureFailure === "conflict" || lastCaptureFailure === "invalid") throw new Error("AmberText couldn’t keep a copy first, so nothing was replaced.");
      const choice = await ask({ title: "No safety copy", message: `AmberText couldn’t save an earlier version of “${displayName(doc)}” first. You can continue without it.`,
        actions: [{ id: "cancel", label: "Cancel" }, { id: "continue", label: "Continue anyway", kind: "primary" }] });
      if (choice?.action !== "continue") throw new Error("Nothing has been replaced.");
      return null;
    }
    return operation;
  } catch (error) { await finishHistoryCheckpoint(doc.id,operation); throw error; }
}
async function finishHistoryCheckpoint(id: string, operation: string | null) {
  if (!operation) return;
  try { await historyApi.release(id,operation); } catch (error) { historyFailure(error); }
}

export function displayName(doc: Doc): string {
  if (doc.path) {
    const base = basename(doc.path);
    return extname(base) === "md" ? stripExt(base) : base;
  }
  return inferTitle(doc.content) || doc.name;
}

export const welcomeDoc = () => (isMac ? WELCOME_DOC.replace(/\*\*Ctrl /g, "**⌘ ").replace(/Ctrl Shift/g, "⌘ ⇧") : WELCOME_DOC);

/* ------------------------------------------------------------------ */
/* Toasts & dialogs                                                    */
/* ------------------------------------------------------------------ */

let toastId = 0;
export function toast(message: string, kind: Toast["kind"] = "info", action?: Toast["action"]) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts.slice(-2), { id, message, kind, action }] }));
  window.setTimeout(() => dismissToast(id), action ? 6000 : 3200);
}

export function dismissToast(id: number) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

let dialogResolve: ((v: { action: string; value?: string } | null) => void) | null = null;

export function ask(dialog: DialogState): Promise<{ action: string; value?: string } | null> {
  dialogResolve?.(null);
  setState({ dialog });
  return new Promise((resolve) => {
    dialogResolve = resolve;
  });
}

function moveGoal(from: string, to: string) {
  const goals = getState().goals;
  if (from === to || !(from in goals)) return;
  const next = { ...goals, [to]: goals[from] };
  delete next[from];
  setState({ goals: next });
}

export async function setWordGoal() {
  const doc = activeDoc();
  if (!doc) return;
  const key = goalKey(doc);
  const current = getState().goals[key];
  const res = await ask({
    title: "Word goal",
    message: "Set a target for this document. Progress shows in the status bar.",
    input: { value: current ? String(current) : "1000", placeholder: "e.g. 1500" },
    actions: [
      ...(current ? [{ id: "clear", label: "Remove goal", kind: "danger" as const }] : []),
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Set goal", kind: "primary" as const },
    ],
  });
  if (!res || res.action === "cancel") return;
  const goals = { ...getState().goals };
  if (res.action === "clear") delete goals[key];
  else {
    const n = Math.round(Number((res.value ?? "").replace(/[^\d]/g, "")));
    if (!n) return;
    goals[key] = Math.min(n, 1_000_000);
  }
  setState({ goals });
}

export function resolveDialog(action: string | null, value?: string) {
  const r = dialogResolve;
  dialogResolve = null;
  setState({ dialog: null });
  r?.(action ? { action, value } : null);
}

export function openContextMenu(x: number, y: number, items: MenuItem[]) {
  setState({ contextMenu: { x, y, items } });
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

const SESSION_KEY = "margin:session"; // Legacy source is read/preserved, never overwritten.
let sessionTimer = 0;
let pendingSince = 0;
let legacySourceHash: string | null = null;
let legacyPendingSource: string | null = null;
let pendingRecovery: RecoverySnapshot | null = null;
let recoveryRunning: Promise<boolean> | null = null;
let recoveryClock = 0;
let fallbackWritable = true;
let recoverySourceWarning: string | null = null;
/* Crash recovery is auxiliary: when it fails, saving to files continues and closing offers a way out. */
let recoveryBroken = false;
type FlushedState = { docs: Doc[]; activeId: string | null; root: string | null };
let flushedState: FlushedState | null = null;
const flushKeys = new WeakMap<RecoverySnapshot, FlushedState>();
const RECOVERY_DOWN = "Crash recovery isn't working right now, so unsaved changes might not come back after a crash. Saving to your files still works.";

function recoverySnapshot(): RecoverySnapshot {
  const s = getState(); const updatedAt = recoveryClock = Math.max(Date.now(), recoveryClock + 1);
  return { version: 1, updatedAt, activeId: s.activeId, root: s.workspace?.root ?? null, legacySourceHash,
    docs: s.docs.map(d => ({ id: d.id, name: d.name, currentPath: d.path, originalPath: d.originalPath,
      content: d.content, savedContent: d.savedContent, savedRevision: d.revision, format: d.format,
      originalText: d.originalText, reason: d.recoveryReason, updatedAt })) };
}

function recoveryFailure(error: unknown) {
  console.warn("Crash recovery couldn't be updated:", ioMessage(error));
  setState({ recoveryWarning: RECOVERY_DOWN });
}

export function persistSession(immediate = false) {
  window.clearTimeout(sessionTimer);
  if (immediate) { void flushRecovery(); return; }
  if (!pendingSince) pendingSince = Date.now();
  // Pause debounce with a one-second maximum wait during continuous typing.
  sessionTimer = window.setTimeout(() => void flushRecovery(), Math.max(0, Math.min(400, 1000 - (Date.now() - pendingSince))));
}

export async function flushRecovery(): Promise<boolean> {
  window.clearTimeout(sessionTimer); pendingSince = 0;
  const s = getState(), state = { docs: s.docs, activeId: s.activeId, root: s.workspace?.root ?? null };
  // Nothing changed since the last verified write: skip the redundant serialize and IPC.
  if (!recoveryRunning && legacyPendingSource === null && flushedState && flushedState.docs === state.docs
    && flushedState.activeId === state.activeId && flushedState.root === state.root) return true;
  const snapshot = recoverySnapshot();
  try { if (fallbackWritable) localStorage.setItem(FALLBACK_KEY, JSON.stringify(snapshot)); }
  catch (error) { recoveryFailure(error); }
  pendingRecovery = snapshot; flushKeys.set(snapshot, state);
  if (recoveryRunning) return recoveryRunning;
  const operation = (async () => {
    while (pendingRecovery) {
      const current = pendingRecovery; pendingRecovery = null;
      try {
        if (legacyPendingSource !== null) {
          legacySourceHash = await recoveryApi.preserveLegacy(legacyPendingSource);
          current.legacySourceHash = legacySourceHash;
        }
        const written = await recoveryApi.write(current);
        legacyPendingSource = null; recoveryBroken = false;
        flushedState = flushKeys.get(current) ?? null;
        setState({ recoveryWarning: written?.omitted
          ? "There's too much open writing for crash recovery to keep all of it, so it keeps unsaved changes first. Saving to your files still works."
          : recoverySourceWarning });
      } catch (error) { recoveryBroken = true; flushedState = null; recoveryFailure(error); pendingRecovery = null; return false; }
    }
    return true;
  })();
  recoveryRunning = operation;
  try { return await operation; } finally { if (recoveryRunning === operation) recoveryRunning = null; }
}

function legacySnapshot(raw: string): RecoverySnapshot {
  const old = JSON.parse(raw);
  if (!Array.isArray(old?.docs) || old.docs.length > 256) throw new Error("Legacy session is unreadable; its source is retained");
  const docs: RecoveryDoc[] = old.docs.map((d: { id?: string; path?: string; name?: string; content?: string; savedContent?: string; revision?: FileRevision }) => {
    if ((d.content != null && typeof d.content !== "string") || (d.path != null && typeof d.path !== "string")
      || (d.name != null && typeof d.name !== "string") || (d.id != null && typeof d.id !== "string")
      || (d.savedContent != null && typeof d.savedContent !== "string")) throw new Error("Legacy writing is unreadable; its source is retained");
    return { id: d.id || uid(), name: d.name || (d.path ? basename(d.path) : "Recovered writing"), currentPath: d.path ?? null,
      originalPath: d.path ?? null, content: d.content ?? "", savedContent: d.content != null ? d.savedContent ?? null : "",
      savedRevision: d.revision ?? null, format: null, originalText: null, updatedAt: 0,
      reason: d.content == null && d.path ? "legacy-clean" : "legacy-recovery" };
  });
  return parseRecovery(JSON.stringify({ version: 1, updatedAt: 0, docs, activeId: old.activeId ?? null, root: old.root ?? null, legacySourceHash: null }));
}

function recoveryCopy(name: string, content: string, originalPath: string | null, format: TextFormat, originalText: string | null, reason: string): Doc {
  return makeDoc({ name, content, savedContent: "", originalPath, format, originalText, recoveryReason: reason });
}

export async function boot() {
  await applyAppearance();
  let session: RecoverySnapshot | null = null;
  try {
    const loaded = await recoveryApi.load(); session = loaded.snapshot;
    if (loaded.warnings.length) {
      console.warn("Crash recovery needs attention:", loaded.warnings.join(" "));
      // Damaged recovery files are set aside by the next write, never deleted.
      recoverySourceWarning = "Some crash recovery data couldn't be read. It has been kept in a separate file, and everything that could be read is open.";
      setState({ recoveryWarning: recoverySourceWarning });
    }
  } catch (error) { recoveryFailure(error); }
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    let fallback: RecoverySnapshot | null = null;
    if (raw) try { fallback = parseRecovery(raw); }
    catch { fallbackWritable = false; recoverySourceWarning = "A browser recovery source is unreadable and has been retained. Readable writing remains open; it has not been replaced by an empty session."; setState({ recoveryWarning: recoverySourceWarning }); }
    if (fallback && (!session || fallback.updatedAt > session.updatedAt)) {
      const earlier = session;
      session = fallback;
      // Keep differing native copies rather than guessing which writing to drop.
      if (earlier) for (const doc of earlier.docs) {
        const newer = fallback.docs.find(d => d.id === doc.id);
        if (!newer || newer.content !== doc.content) session.docs.push({ ...doc, id: uid(), name: `Earlier recovery — ${doc.name}`,
          currentPath: null, originalPath: doc.currentPath ?? doc.originalPath, savedContent: "", savedRevision: null, reason: "earlier-recovery" });
      }
    }
    if (!session) {
      const legacy = localStorage.getItem(SESSION_KEY);
      if (legacy) { legacyPendingSource = legacy; session = legacySnapshot(legacy); }
    }
  } catch (error) { recoveryFailure(error); }
  legacySourceHash = session?.legacySourceHash ?? null;
  recoveryClock = session?.updatedAt ?? 0;
  // Retry legacy preservation even when a newer synchronous fallback was restored.
  if (!legacySourceHash) try { legacyPendingSource = localStorage.getItem(SESSION_KEY); } catch (error) { recoveryFailure(error); }
  const docs: Doc[] = [];
  for (const record of session?.docs ?? []) {
    if (!record.currentPath) {
      docs.push(makeDoc({ id: record.id, name: record.name, content: record.content, savedContent: record.savedContent ?? "",
        originalPath: record.originalPath, format: record.format ?? defaultTextFormat(), originalText: record.originalText, recoveryReason: record.reason }));
      continue;
    }
    try {
      const file = await fsApi.readText(record.currentPath); const disk = normalize(file.content);
      const cleanLegacy = record.reason === "legacy-clean";
      const local = cleanLegacy ? disk : record.content;
      const baseline = record.savedContent;
      const format = record.format && sameRevision(record.savedRevision, file.revision) ? record.format : file.format;
      if (cleanLegacy || local === disk || (baseline !== null && local === baseline)) {
        docs.push(makeDoc({ id: record.id, path: record.currentPath, originalPath: record.originalPath, content: disk, savedContent: disk,
          mtime: file.mtime, revision: file.revision, format, originalText: file.content }));
      } else {
        const unchangedDisk = baseline !== null && disk === baseline && sameRevision(record.savedRevision, file.revision);
        const restored = makeDoc({ id: record.id, path: record.currentPath, originalPath: record.originalPath, content: local,
          savedContent: baseline ?? "", revision: record.savedRevision, mtime: file.mtime, format: record.format ?? file.format,
          originalText: record.originalText, recoveryReason: "recovered-unsaved" });
        restored.conflict = !unchangedDisk;
        docs.push(restored);
        if (!unchangedDisk) docs.push(recoveryCopy(`Disk version — ${record.name}`, disk, record.currentPath, file.format, file.content, "disk-version"));
      }
    } catch (error) {
      docs.push(makeDoc({ id: record.id, name: record.name, content: record.content, savedContent: "", originalPath: record.currentPath,
        format: record.format ?? defaultTextFormat(), originalText: record.originalText, recoveryReason: "unavailable-file" }));
      setState({ recoveryWarning: `“${record.name}” couldn't be read. Its recovered writing is open as a draft. Save As chooses a destination explicitly.` });
    }
  }
  if (!session) docs.push(makeDoc({ name: WELCOME_TITLE, content: welcomeDoc() }));
  const activeId = docs.some(d => d.id === session?.activeId) ? session!.activeId : docs[0]?.id ?? null;
  setState({ docs, activeId });
  const root = session?.root ?? (isTauri ? null : demoRoot);
  if (root) await openFolder(root, { quiet: true, keepSidebar: true });
  await openPaths(await takeLaunchFiles());
  persistSession();
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

/** `focusEditor: false` keeps keyboard focus on the tab strip (arrow-key tab switching). */
export function activate(id: string, focusEditor = true) {
  if (getState().activeId !== id) bridge.skipAutofocus = !focusEditor;
  setState({ activeId: id });
  persistSession();
}

export function newDoc(content = "", name = "Untitled") {
  const s = getState();
  const taken = new Set(s.docs.filter((d) => !d.path).map((d) => d.name));
  let n = 1;
  let finalName = name;
  while (taken.has(finalName)) finalName = `${name} ${++n}`;
  const doc = makeDoc({ name: finalName, content, savedContent: "" });
  const idx = s.docs.findIndex((d) => d.id === s.activeId);
  const docs = [...s.docs];
  docs.splice(idx + 1, 0, doc);
  setState({ docs, activeId: doc.id });
  if (s.settings.viewMode === "read") setViewMode("write");
  persistSession();
  return doc.id;
}

export function openWelcome() {
  const existing = getState().docs.find((d) => !d.path && d.name === WELCOME_TITLE);
  if (existing) return activate(existing.id);
  const s = getState();
  const doc = makeDoc({ name: WELCOME_TITLE, content: welcomeDoc() });
  setState({ docs: [...s.docs, doc], activeId: doc.id });
  persistSession();
}

function addRecent(path: string) {
  setState((s) => ({ recentFiles: [path, ...s.recentFiles.filter((p) => !samePath(p, path))].slice(0, 12) }));
}

export function removeRecent(path: string) {
  setState((s) => ({ recentFiles: s.recentFiles.filter((p) => !samePath(p, path)) }));
}

export async function openPath(path: string): Promise<string | null> {
  const existing = getState().docs.find((d) => d.path === path);
  if (existing) {
    activate(existing.id);
    addRecent(path);
    return existing.id;
  }
  let file;
  try {
    file = await fsApi.readText(path);
  } catch (error) {
    toast(`Couldn't open “${basename(path)}” — ${ioMessage(error)}`, "error");
    removeRecent(path);
    return null;
  }
  const alias = getState().docs.find(d => d.revision?.canonicalPath === file.revision.canonicalPath);
  if (alias) {
    activate(alias.id);
    addRecent(path);
    return alias.id;
  }
  const content = normalize(file.content);
  let historyId: string | undefined;
  if (getState().settings.historyEnabled) {
    try {
      // Several records for one file are merged to the most recent; the rest keep their versions.
      historyId = await historyApi.resolve(path, file.revision.canonicalPath, getState().docs.map(d => d.id)) ?? undefined;
    } catch (error) { historyFailure(error); }
  }
  const doc = makeDoc({ id: historyId, path, content, savedContent: content, mtime: file.mtime, revision: file.revision,
    format: file.format, originalText: file.content, eol: detectEol(file.content) });
  setState((s) => {
    let docs = [...s.docs];
    const active = activeDoc(s);
    let idx = docs.findIndex((d) => d.id === s.activeId);
    // A pristine empty draft gets replaced rather than left behind.
    if (active && !active.path && !active.content) {
      docs = docs.filter((d) => d.id !== active.id);
      bridge.forget(active.id);
      idx--;
    }
    docs.splice(idx + 1, 0, doc);
    return { docs, activeId: doc.id };
  });
  addRecent(path);
  await captureHistoryDoc(doc,"opening",true);
  persistSession();
  return doc.id;
}

export async function openPaths(paths: string[]) {
  for (const p of paths) {
    const ext = extname(p);
    if (MARKDOWN_EXTENSIONS.includes(ext) || !ext) await openPath(p);
  }
}

export async function openFileDialog() {
  const paths = await dialogs.openFiles();
  await openPaths(paths);
}

export async function openFolderDialog() {
  const root = await dialogs.openFolder();
  if (root) await openFolder(root);
}

export async function openFolder(root: string, opts: { quiet?: boolean; keepSidebar?: boolean } = {}) {
  try {
    const tree = await fsApi.listTree(root);
    setState((s) => ({
      workspace: { root, tree },
      recentFolders: [root, ...s.recentFolders.filter((p) => !samePath(p, root))].slice(0, 8),
      settings: opts.keepSidebar ? s.settings : { ...s.settings, sidebarOpen: true, sidebarTab: "files" },
    }));
    persistSession();
  } catch {
    if (!opts.quiet) toast(`Couldn't open folder “${basename(root)}”`, "error");
  }
}

export function closeFolder() {
  setState({ workspace: null });
  persistSession();
}

export async function refreshTree() {
  const ws = getState().workspace;
  if (!ws) return;
  try {
    const tree = await fsApi.listTree(ws.root);
    if (getState().workspace?.root === ws.root) setState({ workspace: { root: ws.root, tree } });
  } catch {
    /* folder vanished; keep the last known tree */
  }
}

/* Content & saving */

const saveTimers = new Map<string, number>();

export function updateContent(id: string, content: string) {
  const doc = findDoc(id);
  if (!doc || doc.content === content) return;
  patchDoc(id, { content });
  scheduleHistory(id);
  scheduleAutosave(id);
  persistSession();
}

function scheduleAutosave(id: string) {
  const s = getState();
  const doc = findDoc(id);
  if (!s.settings.autosave || !doc?.path || !isDirty(doc) || doc.conflict) return;
  window.clearTimeout(saveTimers.get(id));
  saveTimers.set(
    id,
    window.setTimeout(() => void saveDoc(id, { auto: true }), 750),
  );
}

const inflight = new Map<string, Promise<boolean>>();

export async function saveDoc(id: string, opts: { auto?: boolean } = {}): Promise<boolean> {
  const doc = findDoc(id);
  if (!doc) return false;
  if (!doc.path) return opts.auto ? false : saveDocAs(id);
  const running = inflight.get(id);
  if (running) {
    if (opts.auto) {
      scheduleAutosave(id);
      return false;
    }
    await running.catch(() => false);
    return saveDoc(replacementIds.get(id) ?? id, opts);
  }
  // Never let a background save overwrite changes made to the file elsewhere.
  if (opts.auto && doc.conflict) return false;
  window.clearTimeout(saveTimers.get(id));
  const p = writeDoc(id, opts);
  inflight.set(id, p);
  try {
    return await p;
  } finally {
    inflight.delete(id);
  }
}

async function reviewedFormat(doc: Doc, auto: boolean): Promise<TextFormat | null> {
  let format = { ...doc.format };
  if (!format.confirmed) {
    if (auto) return null;
    const result = await ask({ title: "Confirm this file's characters",
      message: "This file was interpreted as Windows-1252, an older text format. Check that its characters look right. Keeping this format preserves its original bytes; UTF-8 supports more languages.",
      actions: [{ id: "cancel", label: "Cancel" }, { id: "legacy", label: "Keep Windows-1252" }, { id: "utf8", label: "Use UTF-8", kind: "primary" }] });
    if (!result || result.action === "cancel") return null;
    format = { ...format, confirmed: true, ...(result.action === "utf8" ? { encoding: "utf8" as const, bom: false } : {}) };
  }
  if (format.eol === "mixed") {
    if (auto) return null;
    const result = await ask({ title: "Choose line endings",
      message: "This file mixes different line endings. Saving this edit will make them consistent. Its original version will be kept as a recovery draft before replacement.",
      actions: [{ id: "cancel", label: "Cancel" }, { id: "lf", label: "Use LF" }, { id: "crlf", label: "Use Windows CRLF", kind: "primary" }] });
    if (!result || result.action === "cancel") return null;
    format.eol = result.action === "crlf" ? "\r\n" : "\n";
  }
  return format;
}

function encodedText(content: string, format: TextFormat): string { return normalize(content).replace(/\n/g, format.eol); }

async function formattedWrite(path: string, content: string, expected: FileRevision | null, format: TextFormat, auto: boolean, protect?: () => Promise<boolean>) {
  try { return { saved: await fsApi.writeText(path, content, expected, format), format }; }
  catch (error) {
    if (auto || format.encoding !== "windows1252" || !isIoFailure(error, "unsupported")) throw error;
    const result = await ask({ title: "Save these characters as UTF-8?",
      message: "Windows-1252 cannot save every character in this writing. UTF-8 preserves them. Cancel keeps your writing open and leaves the file unchanged.",
      actions: [{ id: "cancel", label: "Cancel" }, { id: "utf8", label: "Convert to UTF-8", kind: "primary" }] });
    if (result?.action !== "utf8" || (protect && !await protect())) return null;
    const converted: TextFormat = { ...format, encoding: "utf8", bom: false, confirmed: true };
    return { saved: await fsApi.writeText(path, content, expected, converted), format: converted };
  }
}

async function keepRecoveryCopy(name: string, content: string, path: string | null, format: TextFormat, originalText: string | null, reason: string): Promise<boolean> {
  if (!getState().docs.some(d => !d.path && d.recoveryReason === reason && d.originalPath === path && d.content === content && d.originalText === originalText)) {
    const copy = recoveryCopy(name, content, path, format, originalText, reason);
    setState(s => ({ docs: [...s.docs, copy] }));
  }
  return flushRecovery();
}

const heldAutosaves = new Set<string>();
/** The earlier file stays open as a draft; if crash recovery can't protect it, ask (or hold autosave) instead of failing silently. */
async function protectOriginal(doc: Doc, auto: boolean, ...copy: Parameters<typeof keepRecoveryCopy>): Promise<boolean> {
  if (await keepRecoveryCopy(...copy)) return true;
  if (auto) {
    if (!heldAutosaves.has(doc.id)) toast(`“${displayName(doc)}” wasn't saved automatically, because crash recovery isn't working right now. Save it yourself to continue.`, "error");
    heldAutosaves.add(doc.id);
    return false;
  }
  const result = await ask({ title: "Save without crash protection?",
    message: "A copy of the earlier version is open in a new tab. Crash recovery isn’t working right now, so that tab won’t come back if AmberText closes unexpectedly.",
    actions: [{ id: "cancel", label: "Cancel" }, { id: "save", label: "Save anyway", kind: "primary" }] });
  return result?.action === "save";
}

async function writeDoc(id: string, opts: { auto?: boolean }): Promise<boolean> {
  let doc = findDoc(id);
  if (!doc?.path) return false;
  const path = doc.path;
  let expected = doc.revision;
  let historyOperation: string | null = null;
  try {
    const disk = await fsApi.readText(path);
    const changed = doc.conflict || !sameRevision(expected, disk.revision);
    if (changed) {
      if (opts.auto) { patchDoc(id, { conflict: true }); return false; }
      const result = await ask({ title: "This file changed on disk",
        message: `“${displayName(doc)}” changed since you opened it. Save mine keeps the disk version as a recovery draft before replacing it.`,
        actions: [{ id: "reload", label: "Reload from disk" }, { id: "cancel", label: "Cancel" }, { id: "overwrite", label: "Save mine", kind: "primary" }] });
      if (result?.action === "reload") void reloadFromDisk(id);
      if (result?.action !== "overwrite") return false;
      expected = disk.revision;
    } else if (!isDirty(doc)) {
      if (!opts.auto) await captureHistoryDoc(doc,"manual-save");
      return true; // A clean save never normalizes or converts bytes.
    }
    doc = findDoc(id);
    if (!doc) return false;
    const format = await reviewedFormat(doc, !!opts.auto);
    if (!format) {
      if (opts.auto && (!doc.format.confirmed || doc.format.eol === "mixed") && !heldAutosaves.has(id)) {
        heldAutosaves.add(id);
        toast(`Autosave is paused for “${displayName(doc)}” until you save it once yourself. AmberText needs to ask how to store its text.`);
      }
      return false;
    }
    const snapshotDoc = findDoc(id);
    if (!snapshotDoc || snapshotDoc.path !== path) return false;
    const content = snapshotDoc.content;
    if (changed) historyOperation = await historyCheckpoint(snapshotDoc,"before-overwrite",disk);
    // Keep the earlier bytes only when this save replaces changed bytes or converts the format,
    // not on every save of a file whose format was already chosen.
    const reviewed = doc, before = doc.format;
    const protect = () => protectOriginal(reviewed, !!opts.auto, `Before save — ${displayName(reviewed)}`, normalize(disk.content), path, disk.format, disk.content, "before-save");
    if (changed || !before.confirmed || before.eol === "mixed" || format.encoding !== before.encoding || format.bom !== before.bom || format.eol !== before.eol) {
      if (!await protect()) return false;
    } else await flushRecovery();
    const current = findDoc(id);
    if (!current || current.path !== path) return false;
    patchDoc(id, { saving: true });
    const written = await formattedWrite(path, content, expected, format, !!opts.auto, protect);
    if (!written) { patchDoc(id, { saving: false }); return false; }
    heldAutosaves.delete(id);
    patchDoc(id, { savedContent: content, ...written.saved, format: written.format, originalText: encodedText(content, written.format),
      saving: false, lastSavedAt: Date.now(), conflict: false, recoveryReason: null });
    const now = findDoc(id);
    if (now && now.content !== content) scheduleAutosave(id);
    if (!opts.auto) await captureHistoryDoc({ ...snapshotDoc, content, revision: written.saved.revision, format: written.format },"manual-save");
    persistSession();
    return true;
  } catch (error) {
    patchDoc(id, { saving: false, ...((isIoFailure(error, "conflict") || isIoFailure(error, "missing")) ? { conflict: true } : {}) });
    toast(`Couldn't save “${doc ? displayName(doc) : basename(path)}” — ${ioMessage(error)}. Your writing stays open; Save As makes a separate copy.`, "error");
    return false;
  } finally {
    await finishHistoryCheckpoint(id,historyOperation);
  }
}

const replacementIds = new Map<string, string>();

export async function saveDocAs(id: string): Promise<boolean> {
  while (inflight.has(id)) await inflight.get(id)!.catch(() => false);
  // Includes destination selection so two Save As requests cannot interleave.
  const operation = performSaveAs(id);
  inflight.set(id, operation);
  try { return await operation; } finally { if (inflight.get(id) === operation) inflight.delete(id); }
}

async function performSaveAs(id: string): Promise<boolean> {
  const doc = findDoc(id);
  if (!doc) return false;
  const sourcePath = doc.path ?? doc.originalPath;
  const suggested = sanitizeFileName(sourcePath ? stripExt(basename(sourcePath)) : inferTitle(doc.content) || doc.name) || "Untitled";
  const dir = sourcePath ? dirname(sourcePath) : getState().workspace?.root;
  const defaultPath = dir ? join(dir, `${suggested}.md`) : `${suggested}.md`;
  let path = await dialogs.saveFile(defaultPath);
  if (!path) return false;
  if (!extname(path)) path += ".md";
  if (doc.path === path) return writeDoc(id, {});
  let historyOperation: string | null = null;
  let destinationHistoryId: string | null = null;
  try {
    const disk = await fsApi.exists(path) ? await fsApi.readText(path) : null;
    if (disk && doc.revision?.canonicalPath === disk.revision.canonicalPath) return writeDoc(id, {});
    const other = getState().docs.find((d) => d.id !== id && (
      disk ? d.revision?.canonicalPath === disk.revision.canonicalPath : samePath(d.path, path)
    ));
    if (disk) {
      const res = await ask({
        title: `Replace “${basename(path)}”?`,
        message: other && isDirty(other)
          ? "This replaces the file on disk. The other tab's unsaved writing stays open, with a disk conflict."
          : "This replaces an existing file on disk. Cancel to choose a different destination.",
        actions: [
          { id: "cancel", label: "Cancel" },
          { id: "replace", label: "Replace", kind: "danger" },
        ],
      });
      if (res?.action !== "replace") return false;
    }
    const current = findDoc(id);
    if (!current) return false;
    const format = await reviewedFormat(current, false);
    if (!format) return false;
    const snapshotDoc = findDoc(id);
    if (!snapshotDoc) return false;
    const content = snapshotDoc.content;
    await captureHistoryDoc(snapshotDoc,"manual-save");
    if (disk && getState().settings.historyEnabled) {
      const historyId = await historyApi.resolve(path, disk.revision.canonicalPath, getState().docs.map(d => d.id)) ?? undefined;
      const target = other ?? makeDoc({ id: historyId,
        path, name: basename(path), content: normalize(disk.content), savedContent: normalize(disk.content), revision: disk.revision, format: disk.format });
      destinationHistoryId = target.id;
      historyOperation = await historyCheckpoint(target,"before-overwrite",disk);
    }
    if (disk && !(await protectOriginal(snapshotDoc, false, `Before replacement — ${basename(path)}`, normalize(disk.content), path, disk.format, disk.content, "before-replacement"))) return false;
    const latest = findDoc(id);
    if (!latest) return false;
    patchDoc(id, { saving: true });
    const written = await formattedWrite(path, content, disk?.revision ?? null, format, false);
    if (!written) { patchDoc(id, { saving: false }); return false; }
    const saved = written.saved;
    // Commit associations only after native success; every other buffer survives.
    const copyId = uid();
    window.clearTimeout(historyTimers.get(id)); historyTimers.delete(id);
    bridge.reidentify(id, copyId);
    for (const [oldId, currentId] of replacementIds) if (currentId === id) replacementIds.set(oldId, copyId);
    replacementIds.set(id, copyId);
    moveGoal(goalKey(current), path);
    setState((s) => ({
      docs: s.docs.map((d) => d.id === id
        ? { ...d, id: copyId, path, originalPath: path, name: basename(path), ...saved, format: written.format, originalText: encodedText(content, written.format), recoveryReason: null, savedContent: content, saving: false, lastSavedAt: Date.now(), conflict: false }
        : d.id === other?.id ? { ...d, conflict: true } : d),
      activeId: s.activeId === id ? copyId : s.activeId,
    }));
    if (other) window.clearTimeout(saveTimers.get(other.id));
    addRecent(path);
    persistSession();
    void refreshTree();
    const copy = findDoc(copyId);
    if (copy) { await captureHistoryDoc({ ...copy, content },"copy"); await captureHistoryDoc(copy,"copy",true); }
    if (copy && copy.content !== content) scheduleAutosave(copyId);
    if (copy && copy.content !== content) scheduleHistory(copyId);
    return true;
  } catch (e) {
    patchDoc(id, { saving: false });
    toast(`Couldn't save a copy of “${displayName(doc)}” — ${ioMessage(e)}`, "error");
    return false;
  } finally {
    if (destinationHistoryId) await finishHistoryCheckpoint(destinationHistoryId,historyOperation);
  }
}

export async function saveActive() {
  const doc = activeDoc();
  if (doc) await saveDoc(doc.id);
}

export async function saveActiveAs() {
  const doc = activeDoc();
  if (doc) await saveDocAs(doc.id);
}

/** A close may proceed only when the latest open buffers are verified in recovery. */
export async function flushAll(): Promise<boolean> {
  for (const timer of saveTimers.values()) window.clearTimeout(timer);
  await Promise.all([...inflight.values()].map(operation => operation.catch(() => false)));
  const s = getState();
  await Promise.all(s.docs.filter(d => d.path && isDirty(d) && s.settings.autosave && !d.conflict).map(d => saveDoc(d.id, { auto: true })));
  for (const doc of getState().docs) await captureHistoryDoc(doc,"close");
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = JSON.stringify(getState().docs);
    if (!await flushRecovery()) return false;
    if (JSON.stringify(getState().docs) === before) return true;
  }
  setState({ recoveryWarning: "Writing changed while recovery was being saved. Keep this window open and try closing again after typing has stopped." });
  return false;
}

/** Closing the window: like `flushAll`, but asks about changes autosave couldn't write,
 *  and offers to close anyway when crash recovery itself can't be written. */
export async function closeWindow(): Promise<boolean> {
  for (const timer of saveTimers.values()) window.clearTimeout(timer);
  await Promise.all([...inflight.values()].map(operation => operation.catch(() => false)));
  const pending = () => getState().settings.autosave ? getState().docs.filter(d => d.path && isDirty(d) && !d.conflict) : [];
  await Promise.all(pending().map(d => saveDoc(d.id, { auto: true })));
  // Autosave skips files whose format needs a choice (and failed writes); never close past them silently.
  for (const doc of pending()) {
    const res = await ask({
      title: `Save changes to “${displayName(doc)}”?`,
      message: "These changes couldn't be saved automatically. If you don't save now, they'll reopen next time but won't be in the file.",
      actions: [
        { id: "discard", label: "Don't save", kind: "default" },
        { id: "cancel", label: "Cancel" },
        { id: "save", label: "Save", kind: "primary" },
      ],
    });
    if (!res || res.action === "cancel") return false;
    if (res.action === "save" && !(await saveDoc(doc.id))) return false;
  }
  if (await flushAll()) return true;
  if (!recoveryBroken) return false;
  const unsaved = getState().docs.filter(isDirty).map(displayName);
  const names = unsaved.slice(0, 3).map(name => `“${name}”`).join(", ") + (unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : "");
  const res = await ask({
    title: "Close without crash recovery?",
    message: unsaved.length
      ? `Crash recovery isn't working right now. ${names} ${unsaved.length === 1 ? "has" : "have"} changes that aren't saved to a file. If you close now, those changes will be lost.`
      : "Crash recovery isn't working right now. Your writing is saved to files, but your open tabs might not reopen next time.",
    actions: [
      { id: "close", label: "Close without crash recovery", kind: "danger" },
      { id: "cancel", label: "Keep open", kind: "primary" },
    ],
  });
  return res?.action === "close";
}

export async function closeDoc(id: string): Promise<boolean> {
  while (inflight.has(id)) await inflight.get(id)!.catch(() => false);
  id = replacementIds.get(id) ?? id;
  const doc = findDoc(id);
  if (!doc) return false;
  let discard = false;
  if (isDirty(doc)) {
    if (doc.path && getState().settings.autosave && !doc.conflict) {
      if (!(await saveDoc(id))) return false;
    } else {
      const res = await ask({
        title: `Save changes to “${displayName(doc)}”?`,
        message: doc.path ? "Your changes won't be saved to this file. Local history may retain copies if it is enabled." : "This draft hasn't been saved to a file yet.",
        actions: [
          { id: "discard", label: "Don't save", kind: "default" },
          { id: "cancel", label: "Cancel" },
          { id: "save", label: doc.path ? "Save" : "Save as…", kind: "primary" },
        ],
      });
      if (!res || res.action === "cancel") return false;
      discard = res.action === "discard";
      if (res.action === "save" && !(await saveDoc(id))) return false;
    }
  }
  id = replacementIds.get(id) ?? id;
  const latest = findDoc(id);
  if (latest && isDirty(latest) && !discard) { toast("Newer writing is still unsaved. This tab has stayed open."); return false; }
  if (latest) await captureHistoryDoc(latest,"close");
  for (const [oldId, newId] of replacementIds) if (oldId === id || newId === id) replacementIds.delete(oldId);
  setState((s) => {
    const idx = s.docs.findIndex((d) => d.id === id);
    const docs = s.docs.filter((d) => d.id !== id);
    const activeId = s.activeId === id ? (docs[Math.min(idx, docs.length - 1)]?.id ?? null) : s.activeId;
    return { docs, activeId };
  });
  bridge.forget(id);
  window.clearTimeout(historyTimers.get(id)); historyTimers.delete(id);
  window.clearTimeout(saveTimers.get(id));
  persistSession();
  return true;
}

export async function closeActive() {
  const doc = activeDoc();
  if (doc) await closeDoc(doc.id);
}

export async function closeOthers(id: string) {
  for (const d of getState().docs) if (d.id !== id && !(await closeDoc(d.id))) return;
}

export function cycleTab(delta: number) {
  const s = getState();
  if (s.docs.length < 2) return;
  const idx = s.docs.findIndex((d) => d.id === s.activeId);
  activate(s.docs[(idx + delta + s.docs.length) % s.docs.length].id);
}

export function moveTab(id: string, toIndex: number) {
  setState((s) => {
    const docs = [...s.docs];
    const from = docs.findIndex((d) => d.id === id);
    if (from < 0) return {};
    const [d] = docs.splice(from, 1);
    docs.splice(Math.max(0, Math.min(toIndex, docs.length)), 0, d);
    return { docs };
  });
  persistSession();
}

/* External changes */

export async function reloadFromDisk(id: string) {
  const doc = findDoc(id);
  if (!doc?.path) return;
  let historyOperation: string | null = null;
  try {
    const f = await fsApi.readText(doc.path);
    const current = findDoc(id);
    if (!current || current.path !== doc.path) return;
    historyOperation = await historyCheckpoint(current,"before-reload",f);
    if (isDirty(current) && !(await keepRecoveryCopy(`Before reload — ${displayName(current)}`, current.content, current.path, current.format, current.originalText, "before-reload"))) return;
    const latest = findDoc(id);
    if (!latest || latest.content !== current.content) { toast("Writing changed during reload. Try again after typing has stopped."); return; }
    const text = normalize(f.content);
    patchDoc(id, { content: text, savedContent: text, mtime: f.mtime, revision: f.revision, format: f.format, originalText: f.content, conflict: false, eol: detectEol(f.content), recoveryReason: null });
    bridge.replaceContent(id, text);
    persistSession();
  } catch {
    toast(`Couldn't reload “${displayName(doc)}”`, "error");
  } finally {
    await finishHistoryCheckpoint(id,historyOperation);
  }
}

let checking = false;
export async function checkExternalChanges() {
  if (checking) return;
  checking = true;
  try {
    for (const doc of getState().docs) {
      if (!doc.path || doc.saving) continue;
      const m = await fsApi.mtime(doc.path);
      if (m === null || m <= doc.mtime + 2) continue;
      const f = await fsApi.readText(doc.path).catch(() => null);
      if (!f) continue;
      const text = normalize(f.content);
      const current = findDoc(doc.id);
      if (!current) continue;
      if (text === current.content) {
        patchDoc(doc.id, { mtime: f.mtime, revision: f.revision, format: f.format, originalText: f.content, savedContent: text });
      } else if (!isDirty(current)) {
        patchDoc(doc.id, { content: text, savedContent: text, mtime: f.mtime, revision: f.revision, format: f.format, originalText: f.content });
        bridge.replaceContent(doc.id, text);
      } else {
        patchDoc(doc.id, { conflict: true });
        toast(`“${displayName(current)}” changed on disk`, "info", { label: "Reload", run: () => void reloadFromDisk(doc.id) });
      }
    }
  } finally {
    checking = false;
  }
}

/* ------------------------------------------------------------------ */
/* Links & images                                                      */
/* ------------------------------------------------------------------ */

/* Explicit history recovery never writes the historical path by default. */
export async function relinkHistory(documentId: string, currentId: string): Promise<boolean> {
  while (inflight.has(currentId)) await inflight.get(currentId)!.catch(() => false);
  const operation = performHistoryRelink(documentId,currentId); inflight.set(currentId,operation);
  try { return await operation; } finally { if (inflight.get(currentId) === operation) inflight.delete(currentId); }
}
async function performHistoryRelink(documentId: string, currentId: string): Promise<boolean> {
  const doc = findDoc(currentId);
  if (!doc?.path || currentId === documentId || findDoc(documentId)) { toast("Choose an open file without another open tab using this older identity."); return false; }
  if (!getState().settings.historyEnabled) { toast("Turn on local history before connecting an earlier history."); return false; }
  const operation = uid();
  window.clearTimeout(historyTimers.get(currentId)); historyTimers.delete(currentId);
  window.clearTimeout(saveTimers.get(currentId));
  try {
    const manifest = await historyApi.versions(documentId);
    if (manifest.currentPath && !samePath(manifest.currentPath,doc.path) && await fsApi.exists(manifest.currentPath)) {
      throw new Error("The original file still exists, so its versions stay with it.");
    }
    const disk = await fsApi.readText(doc.path);
    if (!sameRevision(doc.revision,disk.revision)) throw new Error("The file changed on disk. Open it and choose which version to keep first.");
    const linked = { ...doc, id: documentId };
    if (!await captureHistoryDoc(linked,"relink",true,operation) || !await captureHistoryDoc(linked,"relink",false,operation)) {
      throw new Error("The versions couldn’t be linked. Nothing has changed.");
    }
    const current = findDoc(currentId);
    const checkedDisk = await fsApi.readText(doc.path);
    if (!current || current.path !== doc.path || current.content !== doc.content || !sameRevision(current.revision,disk.revision) || !sameRevision(disk.revision,checkedDisk.revision)) {
      throw new Error("The writing changed while linking versions. Nothing was lost; try again when you stop typing.");
    }
    await historyApi.detach(currentId);
    // Recheck after the last asynchronous boundary; typing is never frozen.
    const final = findDoc(currentId);
    if (!final || final.path !== doc.path || final.content !== doc.content) throw new Error("The writing changed while linking versions. Nothing was lost; try again.");
    bridge.reidentify(currentId,documentId);
    for (const [oldId,nextId] of replacementIds) if (nextId === currentId) replacementIds.set(oldId,documentId);
    replacementIds.set(currentId,documentId);
    setState(s => ({ docs: s.docs.map(d => d.id === currentId ? { ...d, id: documentId } : d),
      activeId: s.activeId === currentId ? documentId : s.activeId }));
    if (isDirty(final)) { scheduleHistory(documentId); scheduleAutosave(documentId); }
    persistSession(); toast("Connected the earlier history. The current file and unsaved writing are unchanged.","success"); return true;
  } catch (error) { historyFailure(error); return false; }
  finally { await finishHistoryCheckpoint(documentId,operation); }
}

export async function recoverHistoryVersion(documentId: string, sequence: number): Promise<string | null> {
  try {
    const [version,manifest] = await Promise.all([historyApi.read(documentId,sequence),historyApi.versions(documentId)]);
    const id = newDoc(normalize(version.content), "Recovered — "+manifest.name);
    patchDoc(id,{ originalPath: manifest.currentPath ?? manifest.previousPaths.at(-1) ?? null,
      format: version.entry.format, originalText: version.entry.representation === "raw-disk" ? version.content : null, recoveryReason: "history-copy" });
    persistSession(); return id;
  } catch (error) { toast("Couldn't recover this version — "+ioMessage(error),"error"); return null; }
}
export async function restoreHistoryVersion(documentId: string, sequence: number): Promise<boolean> {
  const doc = findDoc(documentId);
  if (!doc?.path) { toast("Open the current file first, or recover this version as a new draft."); return false; }
  if (!getState().settings.historyEnabled) { toast("Turn on local history before restoring into a file, so its current version can be protected."); return false; }
  let operation: string | null = null;
  try {
    const version = await historyApi.read(documentId,sequence);
    const disk = await fsApi.readText(doc.path);
    if (!sameRevision(doc.revision,disk.revision)) { patchDoc(documentId,{ conflict: true }); throw new Error("The file changed on disk, so it wasn’t replaced. Open it and choose which version to keep first."); }
    operation = await historyCheckpoint(doc,"before-restore",disk);
    const current = findDoc(documentId);
    const checkedDisk = await fsApi.readText(doc.path);
    if (!current || current.path !== doc.path || current.content !== doc.content || !sameRevision(current.revision,disk.revision) || !sameRevision(disk.revision,checkedDisk.revision)) {
      throw new Error("The writing changed while keeping a copy, so nothing was replaced.");
    }
    const text = normalize(version.content);
    bridge.restoreContent(documentId,text);
    patchDoc(documentId,{ content: text }); persistSession();
    if (!await saveDoc(documentId,{ auto: true })) {
      toast("The version is open in the tab, with Undo available. Its file could not be saved; review the conflict or format before saving.","error"); return false;
    }
    toast("Restored the version. The previous writing remains in history; Undo is available.","success");
    return true;
  } catch (error) { toast("Couldn't restore this version — "+ioMessage(error),"error"); return false; }
  finally { await finishHistoryCheckpoint(documentId,operation); }
}

export function scrollToHeading(from: number) {
  const view = bridge.view;
  if (!view) return;
  const pos = Math.min(from, view.state.doc.length);
  view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to }, scrollIntoView: false });
  const block = view.lineBlockAt(pos);
  view.scrollDOM.scrollTo({ top: Math.max(0, block.top - 48), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  if (getState().settings.viewMode !== "read") view.focus();
  window.dispatchEvent(new CustomEvent("margin:scroll-to-line", { detail: view.state.doc.lineAt(pos).number - 1 }));
}

export function followLink(href: string) {
  if (href.startsWith("#")) {
    const doc = activeDoc();
    if (!doc) return;
    const target = decodeURIComponent(href.slice(1));
    const h = extractHeadings(doc.content).find((x) => slugify(x.text) === target);
    if (h) scrollToHeading(h.from);
    return;
  }
  if (isExternalUrl(href)) {
    void openExternal(href);
    return;
  }
  const doc = activeDoc();
  const base = doc?.path ? dirname(doc.path) : getState().workspace?.root;
  if (!base) return;
  const target = resolvePath(base, href);
  const ext = extname(target);
  if (MARKDOWN_EXTENSIONS.includes(ext)) void openPath(target);
  else if (!ext) void openPath(target + ".md");
  else void fsApi.reveal(target);
}

function requireSavedDoc(): Doc | null {
  const doc = activeDoc();
  if (doc?.path) return doc;
  toast("Save this document first so images have a home", "info", { label: "Save", run: () => void saveActive() });
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function assetName(docPath: string, ext: string) {
  const stem = sanitizeFileName(stripExt(basename(docPath))).replace(/\s+/g, "-").toLowerCase() || "image";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stem}-${stamp}-${crypto.randomUUID()}.${ext}`;
}

function imageInsertion(view: EditorView) {
  const doc = requireSavedDoc();
  if (!doc?.path || bridge.view !== view || bridge.viewDocId !== doc.id) return null;
  const before = view.state, path = doc.path, content = doc.content;
  const dir = dirname(path);
  // Capture one destination for the entire insertion, including collision retries.
  // A later setting or filename change never relocates existing images.
  const imageDir = join(dir, getState().settings.imageFolder === "document" ? stripExt(basename(path)) + ".assets" : "assets");
  // Compare writing and selection, not state identity: focus changes (file picker,
  // sidebar, Alt-Tab) dispatch new states without changing either.
  return { doc, path, dir, imageDir, current: () => getState().activeId === doc.id && bridge.view === view && bridge.viewDocId === doc.id
    && view.state.doc.eq(before.doc) && view.state.selection.eq(before.selection) && findDoc(doc.id)?.path === path && findDoc(doc.id)?.content === content };
}
function imageLink(dir: string, path: string, alt = "") {
  const escapedAlt = alt.replace(/[\\[\]]/g, "\\$&");
  const segment = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return `![${escapedAlt}](${relativeLink(dir, path, segment)})`;
}
async function createImage(dir: string, preferred: string, fallback: () => string, write: (path: string) => Promise<FileRevision>, current: () => boolean) {
  let name = preferred;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!current()) throw new Error("The document changed before image creation");
    const path = join(dir, name);
    try {
      const revision = await write(path);
      if (!revision?.canonicalPath || !/^[a-f0-9]{64}$/.test(revision.sha256)) throw new Error("Image write returned no verified file revision");
      return path;
    } catch (error) { if (!isIoFailure(error, "conflict")) throw error; name = fallback(); }
  }
  throw new Error("Image names kept colliding; existing files were preserved");
}
function interruptedImages(saved: string[]) {
  toast(saved.length ? `The document changed. No image links were inserted; saved images remain in “${dirname(saved[0])}”.`
    : "The document changed before image insertion. Try again in the document you want.", "info");
}

export async function pasteImage(view: EditorView, files: File[]) {
  const insertion = imageInsertion(view);
  if (!insertion) return;
  const dir = insertion.imageDir;
  const parts: string[] = [], saved: string[] = [];
  for (const file of files) {
    if (!insertion.current()) { interruptedImages(saved); return; }
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    try {
      const data = await blobToBase64(file);
      if (!insertion.current()) { interruptedImages(saved); return; }
      const path = await createImage(dir, assetName(insertion.path, ext), () => assetName(insertion.path, ext), path => fsApi.writeBase64(path, data), insertion.current);
      saved.push(path); parts.push(imageLink(insertion.dir, path));
    } catch (error) {
      if (!insertion.current()) { interruptedImages(saved); return; }
      toast("Couldn't save the pasted image: " + ioMessage(error), "error");
    }
  }
  if (!insertion.current()) { interruptedImages(saved); return; }
  if (!parts.length) return;
  const sel = view.state.selection.main;
  const insert = parts.join("\n");
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.paste" });
  view.focus();
}

export async function insertImageFiles(view: EditorView, paths: string[], pos?: number) {
  const insertion = imageInsertion(view);
  if (!insertion) return;
  const docDir = insertion.dir, at = pos ?? view.state.selection.main.head;
  if (!Number.isInteger(at) || at < 0 || at > view.state.doc.length) { toast("The image insertion position is no longer available", "error"); return; }
  const parts: string[] = [], saved: string[] = [];
  for (const p of paths) {
    if (!insertion.current()) { interruptedImages(saved); return; }
    let target = p;
    try {
      if (!isInside(p, docDir)) {
        target = await createImage(insertion.imageDir, basename(p), () => assetName(p, extname(p) || "png"), target => fsApi.copyFile(p, target), insertion.current);
        saved.push(target);
      } else if (!(await fsApi.exists(p))) throw new Error("The selected image no longer exists");
    } catch (error) {
      if (!insertion.current()) { interruptedImages(saved); return; }
      toast(`Couldn't insert “${basename(p)}”: ${ioMessage(error)}`, "error"); continue;
    }
    parts.push(imageLink(docDir, target, stripExt(basename(p))));
  }
  if (!insertion.current()) { interruptedImages(saved); return; }
  if (!parts.length) return;
  const line = view.state.doc.lineAt(at);
  const prefix = line.text.trim() && at > line.from ? "\n\n" : "";
  const insert = prefix + parts.join("\n\n");
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length }, userEvent: "input.drop" });
  view.focus();
}

export const pickImages = () => dialogs.openImages();

export async function handleDroppedPaths(paths: string[], x: number, y: number) {
  const docs = paths.filter((p) => MARKDOWN_EXTENSIONS.includes(extname(p)));
  const images = paths.filter((p) => IMAGE_EXTENSIONS.includes(extname(p)));
  const view = bridge.view;
  if (images.length && view && bridge.viewDocId) {
    const pos = view.posAtCoords({ x, y }) ?? undefined;
    await insertImageFiles(view, images, pos);
  }
  if (docs.length) await openPaths(docs);
  if (!docs.length && !images.length && paths.length === 1 && (await fsApi.listTree(paths[0]).then(() => true).catch(() => false))) {
    await openFolder(paths[0]);
  }
}

/* ------------------------------------------------------------------ */
/* File tree                                                           */
/* ------------------------------------------------------------------ */

export function toggleExpanded(path: string, open?: boolean) {
  setState((s) => {
    const has = s.expanded.some((p) => samePath(p, path));
    const want = open ?? !has;
    if (want === has) return {};
    return { expanded: want ? [...s.expanded, path] : s.expanded.filter((p) => !samePath(p, path)) };
  });
}

export function collapseAll() {
  setState({ expanded: [] });
}

export async function createEntry(kind: "file" | "folder", parent: string, rawName: string) {
  let name = sanitizeFileName(rawName);
  if (!name) return;
  if (kind === "file" && !extname(name)) name += ".md";
  const path = join(parent, name);
  try {
    if (kind === "file") await fsApi.createFile(path, "");
    else await fsApi.createDir(path);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return;
  }
  toggleExpanded(parent, true);
  await refreshTree();
  if (kind === "file") await openPath(path);
}

export async function renameEntry(path: string, rawName: string) {
  let name = sanitizeFileName(rawName);
  if (!name || name === basename(path)) return;
  const oldExt = extname(path);
  const isFile = !!oldExt;
  if (isFile && !extname(name)) name += "." + oldExt;
  const to = join(dirname(path), name);
  try {
    await fsApi.rename(path, to);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return;
  }
  setState((s) => ({
    docs: s.docs.map((d) => {
      if (!d.path) return d;
      if (samePath(d.path, path)) return { ...d, path: to, name: basename(to) };
      if (isInside(d.path, path)) return { ...d, path: to + d.path.slice(path.length) };
      return d;
    }),
    recentFiles: s.recentFiles.map((p) => (samePath(p, path) ? to : p)),
    goals: Object.fromEntries(Object.entries(s.goals).map(([k, v]) => [samePath(k, path) ? to : isInside(k, path) ? to + k.slice(path.length) : k, v])),
    expanded: s.expanded.map((p) => (samePath(p, path) ? to : isInside(p, path) ? to + p.slice(path.length) : p)),
  }));
  // A rename changes the canonical destination, not the saved byte baseline.
  // Rebind only if those bytes still match; an intervening edit stays a conflict.
  for (const doc of getState().docs.filter(d => d.path && (samePath(d.path, to) || isInside(d.path, to)))) {
    try {
      const disk = await fsApi.readText(doc.path!);
      if (doc.revision?.sha256 === disk.revision.sha256) patchDoc(doc.id, { revision: disk.revision, mtime: disk.mtime });
      else patchDoc(doc.id, { conflict: true });
    } catch { patchDoc(doc.id, { conflict: true }); }
  }
  try { await historyApi.rebind(path,to); } catch (error) { historyFailure(error); }
  await refreshTree();
  persistSession();
}

export async function trashEntry(entry: FileEntry) {
  const bin = isMac ? "Trash" : "Recycle Bin";
  const inside = (d: Doc) => !!d.path && (samePath(d.path, entry.path) || isInside(d.path, entry.path));
  const unsaved = getState().docs.some((d) => inside(d) && isDirty(d));
  const res = await ask({
    title: `Move “${entry.name}” to the ${bin}?`,
    message:
      (entry.isDir ? "The folder and everything inside it will be moved." : "You can restore it from the " + bin + ".") +
      (unsaved ? " Unsaved changes in its open tab will be discarded." : ""),
    actions: [
      { id: "cancel", label: "Cancel" },
      { id: "trash", label: "Move to " + bin, kind: "danger" },
    ],
  });
  if (res?.action !== "trash") return;
  const checkpoints: Array<[string,string | null]> = [];
  try {
    for (const doc of getState().settings.historyEnabled ? getState().docs.filter(inside) : []) {
      const disk = await fsApi.readText(doc.path!);
      checkpoints.push([doc.id,await historyCheckpoint(doc,"close",disk)]);
    }
    await fsApi.trash(entry.path);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return;
  } finally {
    for (const [id,operation] of checkpoints) await finishHistoryCheckpoint(id,operation);
  }
  const affected = getState().docs.filter(inside);
  for (const d of affected) {
    window.clearTimeout(saveTimers.get(d.id));
    bridge.forget(d.id);
    setState((s) => {
      const docs = s.docs.filter((x) => x.id !== d.id);
      return { docs, activeId: s.activeId === d.id ? (docs[0]?.id ?? null) : s.activeId };
    });
  }
  setState((s) => ({ recentFiles: s.recentFiles.filter((p) => !samePath(p, entry.path) && !isInside(p, entry.path)) }));
  await refreshTree();
  persistSession();
  toast(`Moved “${entry.name}” to the ${bin}`, "success");
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function setViewMode(viewMode: ViewMode, focusEditor = true) {
  getState().setSettings({ viewMode });
  if (viewMode !== "read" && focusEditor) requestAnimationFrame(() => bridge.focus());
}

export function toggleSidebar(open?: boolean) {
  const s = getState().settings;
  getState().setSettings({ sidebarOpen: open ?? !s.sidebarOpen });
}

export function showSidebarTab(tab: "files" | "outline") {
  const s = getState().settings;
  if (s.sidebarOpen && s.sidebarTab === tab) return toggleSidebar(false);
  getState().setSettings({ sidebarOpen: true, sidebarTab: tab });
}

let zenRestore: { sidebarOpen: boolean } | null = null;
export async function toggleZen(on?: boolean) {
  const s = getState();
  const next = on ?? !s.zen;
  if (next === s.zen) return;
  if (next) {
    zenRestore = { sidebarOpen: s.settings.sidebarOpen };
    s.setSettings({ sidebarOpen: false });
    setState({ zen: true, settingsOpen: false });
    await win.setFullscreen(true);
  } else {
    setState({ zen: false });
    if (zenRestore) s.setSettings({ sidebarOpen: zenRestore.sidebarOpen });
    zenRestore = null;
    await win.setFullscreen(false);
  }
  bridge.focus();
}

const media = window.matchMedia("(prefers-color-scheme: dark)");
let applying = 0;

export async function applyAppearance() {
  const run = ++applying;
  const { theme, accent, material } = getState().settings;
  const resolve = () => theme === "dark" || (theme === "system" && media.matches);
  const root = document.documentElement;
  let dark = resolve();
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.accent = accent;
  let active = await setMaterial(material, dark, theme);
  if (run !== applying) return;
  if (resolve() !== dark) {
    dark = resolve();
    root.dataset.theme = dark ? "dark" : "light";
    active = await setMaterial(material, dark, theme);
  }
  root.dataset.material = active ? "on" : "off";
  setState({ dark, materialActive: active });
}

media.addEventListener("change", () => {
  if (getState().settings.theme === "system") void applyAppearance();
});

export function cycleTheme() {
  const order = ["system", "light", "dark"] as const;
  const s = getState().settings;
  const next = order[(order.indexOf(s.theme) + 1) % order.length];
  getState().setSettings({ theme: next });
  toast(`Theme: ${next === "system" ? "Match system" : next === "light" ? "Light" : "Dark"}`);
}

export function adjustFontSize(delta: number) {
  const s = getState().settings;
  const fontSize = Math.max(13, Math.min(28, s.fontSize + delta));
  getState().setSettings({ fontSize });
}
