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
  type FileEntry,
} from "../lib/platform";
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

let idCounter = 0;
const uid = () => `d${Date.now().toString(36)}${(++idCounter).toString(36)}`;

const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
const detectEol = (text: string): Doc["eol"] => (text.includes("\r\n") ? "\r\n" : "\n");

function makeDoc(p: Partial<Doc> & Pick<Doc, "content">): Doc {
  return {
    id: p.id ?? uid(),
    path: p.path ?? null,
    name: p.name ?? "Untitled",
    content: p.content,
    savedContent: p.savedContent ?? p.content,
    mtime: p.mtime ?? 0,
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

const SESSION_KEY = "margin:session";

interface SessionDoc {
  id: string;
  path: string | null;
  name: string;
  content?: string;
  savedContent?: string;
}

interface Session {
  docs: SessionDoc[];
  activeId: string | null;
  root: string | null;
}

let sessionTimer = 0;
export function persistSession(immediate = false) {
  window.clearTimeout(sessionTimer);
  const write = () => {
    const s = getState();
    const session: Session = {
      docs: s.docs.map((d) => ({
        id: d.id,
        path: d.path,
        name: d.name,
        ...(d.path && !isDirty(d) ? {} : { content: d.content, savedContent: d.path ? undefined : d.savedContent }),
      })),
      activeId: s.activeId,
      root: s.workspace?.root ?? null,
    };
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
      /* storage full — nothing sensible to do */
    }
  };
  if (immediate) write();
  else sessionTimer = window.setTimeout(write, 400);
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function boot() {
  await applyAppearance();
  const session = loadSession();
  const docs: Doc[] = [];
  for (const sd of session?.docs ?? []) {
    if (sd.path) {
      try {
        const f = await fsApi.readText(sd.path);
        const disk = normalize(f.content);
        docs.push(makeDoc({ id: sd.id, path: sd.path, content: sd.content ?? disk, savedContent: disk, mtime: f.mtime, eol: detectEol(f.content) }));
      } catch {
        if (sd.content != null) docs.push(makeDoc({ id: sd.id, name: basename(sd.path), content: sd.content, savedContent: "" }));
      }
    } else {
      docs.push(makeDoc({ id: sd.id, name: sd.name, content: sd.content ?? "", savedContent: sd.savedContent ?? "" }));
    }
  }
  if (!session) docs.push(makeDoc({ name: WELCOME_TITLE, content: welcomeDoc() }));
  const activeId = docs.some((d) => d.id === session?.activeId) ? session!.activeId : (docs[0]?.id ?? null);
  setState({ docs, activeId });

  const root = session?.root ?? (isTauri ? null : demoRoot);
  if (root) await openFolder(root, { quiet: true, keepSidebar: true });

  const files = await takeLaunchFiles();
  if (files.length) await openPaths(files);
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export function activate(id: string) {
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
  const existing = getState().docs.find((d) => samePath(d.path, path));
  if (existing) {
    activate(existing.id);
    addRecent(path);
    return existing.id;
  }
  let file;
  try {
    file = await fsApi.readText(path);
  } catch {
    toast(`Couldn't open “${basename(path)}”`, "error");
    removeRecent(path);
    return null;
  }
  const content = normalize(file.content);
  const doc = makeDoc({ path, content, savedContent: content, mtime: file.mtime, eol: detectEol(file.content) });
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

export async function saveDoc(id: string, opts: { auto?: boolean } = {}): Promise<boolean> {
  const doc = findDoc(id);
  if (!doc) return false;
  if (!doc.path) return opts.auto ? false : saveDocAs(id);
  if (doc.saving) {
    scheduleAutosave(id);
    return false;
  }
  window.clearTimeout(saveTimers.get(id));
  const content = doc.content;
  const path = doc.path;
  patchDoc(id, { saving: true });
  try {
    const mtime = await fsApi.writeText(path, doc.eol === "\r\n" ? content.replace(/\n/g, "\r\n") : content);
    patchDoc(id, { savedContent: content, mtime, saving: false, lastSavedAt: Date.now(), conflict: false });
    const now = findDoc(id);
    if (now && now.content !== content) scheduleAutosave(id);
    persistSession();
    return true;
  } catch (e) {
    patchDoc(id, { saving: false });
    toast(`Couldn't save “${displayName(doc)}” — ${e instanceof Error ? e.message : String(e)}`, "error");
    return false;
  }
}

export async function saveDocAs(id: string): Promise<boolean> {
  const doc = findDoc(id);
  if (!doc) return false;
  const suggested = sanitizeFileName(doc.path ? stripExt(basename(doc.path)) : inferTitle(doc.content) || doc.name) || "Untitled";
  const dir = doc.path ? dirname(doc.path) : getState().workspace?.root;
  const defaultPath = dir ? join(dir, `${suggested}.md`) : `${suggested}.md`;
  let path = await dialogs.saveFile(defaultPath);
  if (!path) return false;
  if (!extname(path)) path += ".md";
  const other = getState().docs.find((d) => d.id !== id && samePath(d.path, path));
  if (other) {
    bridge.forget(other.id);
    setState((s) => ({ docs: s.docs.filter((d) => d.id !== other.id) }));
  }
  patchDoc(id, { path, name: basename(path), mtime: 0 });
  const ok = await saveDoc(id);
  if (ok) {
    addRecent(path);
    void refreshTree();
  }
  return ok;
}

export async function saveActive() {
  const doc = activeDoc();
  if (doc) await saveDoc(doc.id);
}

export async function saveActiveAs() {
  const doc = activeDoc();
  if (doc) await saveDocAs(doc.id);
}

/** Persist everything before the window closes. Never prompts: drafts live in the session. */
export async function flushAll() {
  const s = getState();
  await Promise.all(
    s.docs.filter((d) => d.path && isDirty(d) && s.settings.autosave && !d.conflict).map((d) => saveDoc(d.id, { auto: true })),
  );
  persistSession(true);
}

export async function closeDoc(id: string): Promise<boolean> {
  const doc = findDoc(id);
  if (!doc) return false;
  if (isDirty(doc)) {
    if (doc.path && getState().settings.autosave && !doc.conflict) {
      if (!(await saveDoc(id))) return false;
    } else {
      const res = await ask({
        title: `Save changes to “${displayName(doc)}”?`,
        message: doc.path ? "Your changes will be lost if you don't save them." : "This draft hasn't been saved to a file yet.",
        actions: [
          { id: "discard", label: "Don't save", kind: "default" },
          { id: "cancel", label: "Cancel" },
          { id: "save", label: doc.path ? "Save" : "Save as…", kind: "primary" },
        ],
      });
      if (!res || res.action === "cancel") return false;
      if (res.action === "save" && !(await saveDoc(id))) return false;
    }
  }
  setState((s) => {
    const idx = s.docs.findIndex((d) => d.id === id);
    const docs = s.docs.filter((d) => d.id !== id);
    const activeId = s.activeId === id ? (docs[Math.min(idx, docs.length - 1)]?.id ?? null) : s.activeId;
    return { docs, activeId };
  });
  bridge.forget(id);
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
  try {
    const f = await fsApi.readText(doc.path);
    const text = normalize(f.content);
    patchDoc(id, { content: text, savedContent: text, mtime: f.mtime, conflict: false, eol: detectEol(f.content) });
    bridge.replaceContent(id, text);
  } catch {
    toast(`Couldn't reload “${displayName(doc)}”`, "error");
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
        patchDoc(doc.id, { mtime: f.mtime, savedContent: text });
      } else if (!isDirty(current)) {
        patchDoc(doc.id, { content: text, savedContent: text, mtime: f.mtime });
        bridge.replaceContent(doc.id, text);
      } else {
        patchDoc(doc.id, { conflict: true, mtime: f.mtime });
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

export function scrollToHeading(from: number) {
  const view = bridge.view;
  if (!view) return;
  const pos = Math.min(from, view.state.doc.length);
  view.dispatch({ selection: { anchor: view.state.doc.lineAt(pos).to }, scrollIntoView: false });
  const block = view.lineBlockAt(pos);
  view.scrollDOM.scrollTo({ top: Math.max(0, block.top - 48), behavior: "smooth" });
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
  return `${stem}-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`;
}

export async function pasteImage(view: EditorView, files: File[]) {
  const doc = requireSavedDoc();
  if (!doc?.path) return;
  const dir = join(dirname(doc.path), "assets");
  const parts: string[] = [];
  for (const file of files) {
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const name = assetName(doc.path, ext);
    try {
      await fsApi.writeBase64(join(dir, name), await blobToBase64(file));
      parts.push(`![](assets/${encodeURI(name)})`);
    } catch {
      toast("Couldn't save the pasted image", "error");
    }
  }
  if (!parts.length) return;
  const sel = view.state.selection.main;
  const insert = parts.join("\n");
  view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: "input.paste" });
  view.focus();
}

export async function insertImageFiles(view: EditorView, paths: string[], pos?: number) {
  const doc = requireSavedDoc();
  if (!doc?.path) return;
  const docDir = dirname(doc.path);
  const parts: string[] = [];
  for (const p of paths) {
    let target = p;
    if (!isInside(p, docDir)) {
      target = join(docDir, "assets", basename(p));
      if (await fsApi.exists(target)) target = join(docDir, "assets", assetName(p, extname(p) || "png"));
      try {
        await fsApi.copyFile(p, target);
      } catch {
        toast(`Couldn't copy “${basename(p)}”`, "error");
        continue;
      }
    }
    parts.push(`![${stripExt(basename(p))}](${relativeLink(docDir, target)})`);
  }
  if (!parts.length) return;
  const at = pos ?? view.state.selection.main.head;
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
    expanded: s.expanded.map((p) => (samePath(p, path) ? to : isInside(p, path) ? to + p.slice(path.length) : p)),
  }));
  await refreshTree();
  persistSession();
}

export async function trashEntry(entry: FileEntry) {
  const bin = isMac ? "Trash" : "Recycle Bin";
  const res = await ask({
    title: `Move “${entry.name}” to the ${bin}?`,
    message: entry.isDir ? "The folder and everything inside it will be moved." : "You can restore it from the " + bin + ".",
    actions: [
      { id: "cancel", label: "Cancel" },
      { id: "trash", label: "Move to " + bin, kind: "danger" },
    ],
  });
  if (res?.action !== "trash") return;
  try {
    await fsApi.trash(entry.path);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
    return;
  }
  const affected = getState().docs.filter((d) => d.path && (samePath(d.path, entry.path) || isInside(d.path, entry.path)));
  for (const d of affected) {
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

export function setViewMode(viewMode: ViewMode) {
  getState().setSettings({ viewMode });
  if (viewMode !== "read") requestAnimationFrame(() => bridge.focus());
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
