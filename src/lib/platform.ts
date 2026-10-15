import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DEMO_FILES } from "./samples";
import { basename, dirname, isInside, join, samePath } from "./paths";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const ua = navigator.userAgent;
const plat = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || ua;
export const isMac = /Mac|iPhone|iPad/i.test(plat);
export const isWindows = /Win/i.test(plat);
/** How we refer to the user's machine in copy, e.g. "Runs on this Mac". */
export const deviceName = isMac ? "this Mac" : isWindows ? "this PC" : "this computer";
export const platformName: "mac" | "windows" | "linux" = isMac ? "mac" : isWindows ? "windows" : "linux";
export const fileManagerName = isMac ? "Finder" : isWindows ? "File Explorer" : "file manager";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileEntry[];
}

export interface TextFile {
  content: string;
  mtime: number;
  revision: FileRevision;
  format: TextFormat;
}

export interface TextFormat { encoding: "utf8" | "windows1252"; bom: boolean; eol: "\n" | "\r\n" | "\r" | "mixed"; confirmed: boolean }
export const defaultTextFormat = (): TextFormat => ({ encoding: "utf8", bom: false, eol: "\n", confirmed: true });
export function textLineEnding(text: string): TextFormat["eol"] {
  const breaks = new Set(text.match(/\r\n|\r|\n/g) ?? []);
  return breaks.size > 1 ? "mixed" : (breaks.values().next().value ?? "\n") as TextFormat["eol"];
}

/** Fingerprints refer to disk bytes, never the editor's normalized text. */
export interface FileRevision { canonicalPath: string; sha256: string }
export interface SavedFile { mtime: number; revision: FileRevision }
export interface IoFailure { kind: "conflict" | "missing" | "permission" | "unsupported" | "confirmation" | "invalid" | "io"; message: string }
export const ioMessage = (error: unknown) => error instanceof Error ? error.message
  : typeof error === "object" && error !== null && "message" in error ? String(error.message) : String(error);
export const isIoFailure = (error: unknown, kind: IoFailure["kind"]) => typeof error === "object" && error !== null && "kind" in error && error.kind === kind;
export const sameRevision = (a: FileRevision | null, b: FileRevision) => a?.canonicalPath === b.canonicalPath && a.sha256 === b.sha256;

export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"];

/* ------------------------------------------------------------------ */
/* In-memory file system used when running in a plain browser (dev).  */
/* ------------------------------------------------------------------ */

const DEMO_ROOT = "/Users/you/Notes";
const mem = new Map<string, Pick<TextFile, "content" | "mtime">>();
const memDirs = new Set<string>([DEMO_ROOT]);
for (const [rel, content] of Object.entries(DEMO_FILES)) {
  const p = join(DEMO_ROOT, ...rel.split("/"));
  mem.set(p, { content, mtime: Date.now() });
  let d = dirname(p);
  while (d.length > DEMO_ROOT.length) {
    memDirs.add(d);
    d = dirname(d);
  }
}

function memTree(root: string): FileEntry[] {
  const children = (dir: string): FileEntry[] => {
    const dirs = [...memDirs].filter((d) => dirname(d) === dir && d !== dir);
    const files = [...mem.keys()].filter((f) => dirname(f) === dir);
    return [
      ...dirs.sort().map((d) => ({ name: basename(d), path: d, isDir: true, children: children(d) })),
      ...files.sort().map((f) => ({ name: basename(f), path: f, isDir: false })),
    ];
  };
  return children(root);
}

function memRename(from: string, to: string) {
  if (from === to) return;
  if (mem.has(to) || memDirs.has(to)) throw new Error("Something with that name already exists");
  if (!mem.has(from) && !memDirs.has(from)) throw new Error("File or folder not found");
  if (mem.has(from)) {
    mem.set(to, mem.get(from)!);
    mem.delete(from);
    return;
  }
  for (const d of [...memDirs]) {
    if (samePath(d, from) || isInside(d, from)) {
      memDirs.delete(d);
      memDirs.add(to + d.slice(from.length));
    }
  }
  for (const [f, v] of [...mem]) {
    if (isInside(f, from)) {
      mem.delete(f);
      mem.set(to + f.slice(from.length), v);
    }
  }
}

/* ------------------------------------------------------------------ */

async function memRevision(path: string, content: string): Promise<FileRevision> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return { canonicalPath: path, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

const memWrites = new Map<string, Promise<unknown>>();
function fileChanged(...paths:string[]) {window.dispatchEvent(new CustomEvent("ambertext:filesystem-changed",{detail:paths}));}

export const fsApi = {
  browserReferenceTarget(path: string): { status: "present" | "missing" | "unknown"; canonicalPath: string | null; message: string } {
    if (isTauri) throw new Error("Browser metadata is not a native reference source");
    return { status: mem.has(path) ? "present" : memDirs.has(path) ? "unknown" : "missing", canonicalPath: mem.has(path) ? path : null,
      message: memDirs.has(path) ? "Target is a folder, not a regular file" : "" };
  },
  browserSearchCatalogue(root: string): {paths:string[];coverage:{visited:number;eligible:number;excluded:number;partial:boolean;skipped:number;warnings:string[]}} {
    if(isTauri)throw new Error("Browser catalogue is not a native search source");
    const all=[...mem.keys()].filter(path=>isInside(path,root));
    const eligible=all.filter(path=>{
      const parts=path.slice(root.length).split("/").filter(Boolean);
      return !parts.some(p=>p.startsWith(".")||p.startsWith("~")||["node_modules","target","__pycache__","$RECYCLE.BIN"].includes(p))&&MARKDOWN_EXTENSIONS.includes(path.split(".").at(-1)?.toLowerCase()??"");
    });
    return {paths:eligible.sort().slice(0,20000),coverage:{visited:all.length,eligible:eligible.length,excluded:all.length-eligible.length,partial:eligible.length>20000,skipped:eligible.length>20000?1:0,warnings:eligible.length>20000?["Workspace listing limit reached"]:[]}};
  },
  async listTree(root: string): Promise<FileEntry[]> {
    if (!isTauri) return memTree(root);
    return invoke<FileEntry[]>("list_tree", { root });
  },
  async readText(path: string): Promise<TextFile> {
    if (!isTauri) {
      const f = mem.get(path);
      if (!f) throw new Error("File not found");
      return { ...f, content: f.content.replace(/^\ufeff/, ""), revision: await memRevision(path, f.content),
        format: { ...defaultTextFormat(), bom: f.content.startsWith("\ufeff"), eol: textLineEnding(f.content) } };
    }
    return invoke<TextFile>("read_text", { path });
  },
  async writeText(path: string, content: string, expected: FileRevision | null = null, format: TextFormat = defaultTextFormat()): Promise<SavedFile> {
    if (!isTauri) {
      const previous = memWrites.get(path);
      const write = (async () => {
        await previous?.catch(() => undefined);
        const current = mem.get(path);
        if (expected) {
          if (!current) throw { kind: "missing", message: "The file no longer exists" } satisfies IoFailure;
          if (!sameRevision(expected, await memRevision(path, current.content))) throw { kind: "conflict", message: "The file changed since it was read" } satisfies IoFailure;
        } else if (current || memDirs.has(path)) throw { kind: "conflict", message: "The destination already exists" } satisfies IoFailure;
        if (!format.confirmed || format.eol === "mixed") throw { kind: "confirmation", message: "Confirm the text format before saving" } satisfies IoFailure;
        if (format.encoding !== "utf8") throw { kind: "unsupported", message: "Legacy byte encoding is available in the native app" } satisfies IoFailure;
        const bytes = (format.bom ? "\ufeff" : "") + content.replace(/\r\n?/g, "\n").replace(/\n/g, format.eol);
        const revision = await memRevision(path, bytes);
        const mtime = Date.now();
        mem.set(path, { content: bytes, mtime });
        fileChanged(path);
        return { mtime, revision };
      })();
      memWrites.set(path, write);
      try { return await write; } finally { if (memWrites.get(path) === write) memWrites.delete(path); }
    }
    const saved=await invoke<SavedFile>("write_text", { path, content, expected, format });fileChanged(path);return saved;
  },
  async mtime(path: string): Promise<number | null> {
    if (!isTauri) return mem.get(path)?.mtime ?? null;
    return invoke<number | null>("file_mtime", { path });
  },
  async exists(path: string): Promise<boolean> {
    if (!isTauri) return mem.has(path) || memDirs.has(path);
    return invoke<boolean>("path_exists", { path });
  },
  async createFile(path: string, content = ""): Promise<number> {
    if (!isTauri) {
      if (mem.has(path)) throw new Error("A file with that name already exists");
      mem.set(path, { content, mtime: Date.now() });
      fileChanged(path);
      return Date.now();
    }
    const saved=await invoke<number>("create_file", { path, content });fileChanged(path);return saved;
  },
  async createDir(path: string): Promise<void> {
    if (!isTauri) {
      memDirs.add(path);
      fileChanged(path);
      return;
    }
    await invoke("create_dir", { path });fileChanged(path);
  },
  async rename(from: string, to: string): Promise<void> {
    if (!isTauri) memRename(from,to);else await invoke("rename_path",{from,to});fileChanged(from,to);
  },
  async trash(path: string): Promise<void> {
    if (!isTauri) {
      mem.delete(path);
      for (const f of [...mem.keys()]) if (isInside(f, path)) mem.delete(f);
      for (const d of [...memDirs]) if (samePath(d, path) || isInside(d, path)) memDirs.delete(d);
      fileChanged(path);
      return;
    }
    await invoke("trash_path", { path });fileChanged(path);
  },
  async writeBase64(path: string, data: string): Promise<FileRevision> {
    if (!isTauri) throw { kind: "unsupported", message: "Saving image files requires the AmberText desktop app" };
    const revision = await invoke<FileRevision>("write_base64", { path, data });fileChanged(path);return revision;
  },
  async copyFile(from: string, to: string): Promise<FileRevision> {
    if (!isTauri) throw { kind: "unsupported", message: "Copying image files requires the AmberText desktop app" };
    const revision = await invoke<FileRevision>("copy_file", { from, to });fileChanged(to);return revision;
  },
  async reveal(path: string): Promise<void> {
    if (!isTauri) return;
    return invoke("reveal_path", { path });
  },
};

export const dialogs = {
  async openFiles(): Promise<string[]> {
    if (!isTauri) return [join(DEMO_ROOT, "Welcome.md")];
    const res = await openDialog({
      multiple: true,
      directory: false,
      filters: [
        { name: "Markdown", extensions: MARKDOWN_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  },
  async openFolder(): Promise<string | null> {
    if (!isTauri) return DEMO_ROOT;
    const res = await openDialog({ directory: true, multiple: false });
    return typeof res === "string" ? res : null;
  },
  async openImages(): Promise<string[]> {
    if (!isTauri) return [];
    const res = await openDialog({ multiple: true, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (!res) return [];
    return Array.isArray(res) ? res : [res];
  },
  async saveFile(defaultPath: string, kind: "markdown" | "html" = "markdown"): Promise<string | null> {
    if (!isTauri) return join(DEMO_ROOT, basename(defaultPath));
    const filters =
      kind === "html"
        ? [{ name: "HTML", extensions: ["html"] }]
        : [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];
    return saveDialog({ defaultPath, filters });
  },
};

export const demoRoot = DEMO_ROOT;
let verifiedNativeClose = false;

export const win = {
  hasVerifiedClose: () => verifiedNativeClose,
  async minimize() {
    if (isTauri) await getCurrentWindow().minimize();
  },
  async toggleMaximize() {
    if (isTauri) await getCurrentWindow().toggleMaximize();
  },
  async close() {
    if (isTauri) await getCurrentWindow().close();
  },
  async destroy() {
    if (isTauri) await getCurrentWindow().destroy();
  },
  async show() {
    if (!isTauri) return;
    await invoke("reveal_ready_window");
  },
  async isMaximized() {
    return isTauri ? getCurrentWindow().isMaximized() : false;
  },
  async isFullscreen() {
    return isTauri ? getCurrentWindow().isFullscreen() : !!document.fullscreenElement;
  },
  async setFullscreen(on: boolean) {
    if (isTauri) return getCurrentWindow().setFullscreen(on);
    if (on) await document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  },
  async setTitle(title: string) {
    document.title = title;
    if (isTauri) await getCurrentWindow().setTitle(title).catch(() => {});
  },
  onResized(cb: () => void): () => void {
    if (!isTauri) {
      window.addEventListener("resize", cb);
      return () => window.removeEventListener("resize", cb);
    }
    let un: (() => void) | undefined;
    let dead = false;
    getCurrentWindow()
      .onResized(cb)
      .then((u) => (dead ? u() : (un = u)));
    return () => {
      dead = true;
      un?.();
    };
  },
  onCloseRequested(cb: () => Promise<boolean>): () => void {
    if (!isTauri) {
      // Browser unload cannot await storage; native close is the verified durability boundary.
      const h = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; void cb(); };
      window.addEventListener("beforeunload", h);
      return () => window.removeEventListener("beforeunload", h);
    }
    let un: (() => void) | undefined;
    let dead = false;
    let closing = false;
    getCurrentWindow()
      .onCloseRequested(async event => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        try {
          if (await cb()) {
            verifiedNativeClose = true;
            try { await getCurrentWindow().destroy(); }
            catch (error) { verifiedNativeClose = false; throw error; }
          }
        }
        finally { closing = false; }
      })
      .then((u) => (dead ? u() : (un = u)));
    return () => {
      dead = true;
      un?.();
    };
  },
  onFocus(cb: () => void): () => void {
    window.addEventListener("focus", cb);
    return () => window.removeEventListener("focus", cb);
  },
};

export async function setMaterial(enabled: boolean, dark: boolean, theme: string): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return await invoke<boolean>("set_material", { enabled, dark, theme });
  } catch {
    return false;
  }
}

export async function takeLaunchFiles(): Promise<string[]> {
  if (!isTauri) return [];
  try {
    return await invoke<string[]>("take_launch_files");
  } catch {
    return [];
  }
}

export function onNativeEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!isTauri) return () => {};
  let un: (() => void) | undefined;
  let dead = false;
  listen<T>(name, (e) => cb(e.payload)).then((u) => (dead ? u() : (un = u)));
  return () => {
    dead = true;
    un?.();
  };
}

export interface DropEvent {
  type: "enter" | "over" | "drop" | "leave";
  paths: string[];
  x: number;
  y: number;
}

export function onFileDrop(cb: (e: DropEvent) => void): () => void {
  if (!isTauri) return () => {};
  let un: (() => void) | undefined;
  let dead = false;
  getCurrentWebview()
    .onDragDropEvent((event) => {
      const p = event.payload;
      const ratio = window.devicePixelRatio || 1;
      const pos = "position" in p ? p.position : { x: 0, y: 0 };
      cb({
        type: p.type,
        paths: "paths" in p ? p.paths : [],
        x: pos.x / ratio,
        y: pos.y / ratio,
      });
    })
    .then((u) => (dead ? u() : (un = u)));
  return () => {
    dead = true;
    un?.();
  };
}

export async function openExternal(url: string) {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  await openUrl(url);
}

export function fileSrc(path: string): string {
  return isTauri ? convertFileSrc(path) : path;
}

export async function printPage() {
  if (isTauri && isMac) {
    await invoke("print_page");
    return;
  }
  window.print();
}
