import { invoke } from "@tauri-apps/api/core";
import { samePath } from "./paths";
import { fsApi, isTauri, sameRevision, type FileRevision, type TextFormat } from "./platform";

export interface HistoryEntry {
  sequence: number; capturedAt: number; reason: string; representation: "buffer-utf8" | "raw-disk";
  sha256: string; byteLength: number; format: TextFormat; diskRevision: FileRevision | null; operation: string | null;
}
export interface HistoryManifest {
  version: 1; documentId: string; name: string; currentPath: string | null;
  canonicalPath: string | null; previousPaths: string[]; entries: HistoryEntry[];
}
export interface HistoryCapture {
  documentId: string; name: string; currentPath: string | null; content: string | null;
  diskRevision: FileRevision | null; format: TextFormat; reason: string; operation: string | null;
}
export interface HistoryCatalogue { documents: HistoryManifest[]; warnings: string[]; truncated: boolean }
export interface HistoryMaintenance { byteUsage: number; removedVersions: number; warnings: string[]; trimmedDocuments: string[]; setAside: number }
export interface HistoryVersion { entry: HistoryEntry; content: string }
const PREFIX = "ambertext:history:";
const MAX_CONTENT = 32 * 1024 * 1024;
const id = (value: string) => /^[A-Za-z0-9_-]{1,80}$/.test(value);
async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,"0")).join("");
}
function key(documentId: string) {
  if (!id(documentId)) throw new Error("Invalid history identity");
  return PREFIX + documentId;
}
type BrowserRecord = { sha256: string; manifest: HistoryManifest; contents: Record<string,string> };
async function readRecord(documentId: string): Promise<BrowserRecord | null> {
  const raw = localStorage.getItem(key(documentId));
  if (!raw) return null;
  if (new TextEncoder().encode(raw).length > 40 * 1024 * 1024) throw new Error("History exceeds its safe read limit");
  const record = JSON.parse(raw) as BrowserRecord;
  const m = record?.manifest;
  if (m?.version !== 1 || m.documentId !== documentId || typeof m.name !== "string"
    || !Array.isArray(m.entries) || m.entries.length > 10000 || !Array.isArray(m.previousPaths)
    || !record.contents || typeof record.contents !== "object"
    || m.entries.some((e,i) => !Number.isSafeInteger(e.sequence) || e.sequence < 1 || (i > 0 && e.sequence <= m.entries[i-1].sequence)
      || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isFinite(e.capturedAt) || e.byteLength > MAX_CONTENT
      || !["buffer-utf8","raw-disk"].includes(e.representation) || typeof record.contents[e.sha256] !== "string")
    || record.sha256 !== await hash(new TextEncoder().encode(JSON.stringify(m)))) throw new Error("Some version history is damaged. It has been kept, not deleted");
  return record;
}
let browserGate: Promise<unknown> = Promise.resolve();
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const operation = browserGate.catch(() => undefined).then(run);
  browserGate = operation; return operation;
}
/** Browser fallback is fixture/dev storage; native durability is tested separately. */
export const historyApi = {
  async detach(documentId: string): Promise<void> {
    if (isTauri) return serialize(() => invoke("history_detach", { documentId }));
    await serialize(async () => {
      const r = await readRecord(documentId); if (!r) return;
      if (r.manifest.currentPath && !r.manifest.previousPaths.includes(r.manifest.currentPath)) r.manifest.previousPaths.push(r.manifest.currentPath);
      r.manifest.currentPath = null; r.manifest.canonicalPath = null;
      r.sha256 = await hash(new TextEncoder().encode(JSON.stringify(r.manifest)));
      localStorage.setItem(key(documentId),JSON.stringify(r));
    });
  },
  async rebind(from: string, to: string): Promise<void> {
    if (isTauri) return serialize(() => invoke("history_rebind", { from, to }));
    await serialize(async () => {
      const catalogue = await this.catalogue();
      if (catalogue.truncated || catalogue.warnings.length) throw new Error("History rename index is incomplete; its sources are retained");
      const norm = (p: string) => p.replace(/[\\/]+/g,"/").replace(/\/$/,"");
      const prefix = norm(from), sep = to.includes("\\") ? "\\" : "/";
      for (const m of catalogue.documents) {
        const old = m.currentPath ? norm(m.currentPath) : null;
        if (!old || !(old === prefix || old.startsWith(prefix+"/"))) continue;
        const r = (await readRecord(m.documentId))!;
        if (m.currentPath && !r.manifest.previousPaths.includes(m.currentPath)) r.manifest.previousPaths.push(m.currentPath);
        r.manifest.currentPath = to.replace(/[\\/]+$/,"")+old.slice(prefix.length).replaceAll("/",sep); r.manifest.canonicalPath = null;
        r.sha256 = await hash(new TextEncoder().encode(JSON.stringify(r.manifest)));
        localStorage.setItem(key(m.documentId),JSON.stringify(r));
      }
    });
  },
  /** Picks the history for a file being opened; other records claiming it are detached, never deleted. */
  async resolve(path: string, canonicalPath: string | null, exclude: string[]): Promise<string | null> {
    if (isTauri) return serialize(() => invoke("history_resolve", { path, canonical: canonicalPath, exclude }));
    return serialize(async () => {
      const found = (await this.catalogue()).documents.filter(m => samePath(m.currentPath, path) || (canonicalPath !== null && m.canonicalPath === canonicalPath));
      const rank = (m: HistoryManifest) => [m.entries.at(-1)?.capturedAt ?? 0];
      found.sort((a,b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 1; i++) if (x[i] !== y[i]) return y[i]-x[i]; return a.documentId < b.documentId ? -1 : 1; });
      const winner = found.find(m => !exclude.includes(m.documentId));
      for (const m of found) {
        if (m === winner || exclude.includes(m.documentId)) continue;
        const r = await readRecord(m.documentId); if (!r) continue;
        if (r.manifest.currentPath && !r.manifest.previousPaths.includes(r.manifest.currentPath)) r.manifest.previousPaths.push(r.manifest.currentPath);
        r.manifest.currentPath = null; r.manifest.canonicalPath = null;
        r.sha256 = await hash(new TextEncoder().encode(JSON.stringify(r.manifest)));
        localStorage.setItem(key(m.documentId),JSON.stringify(r));
      }
      return winner?.documentId ?? null;
    });
  },
  async usage(): Promise<number> {
    if (isTauri) return invoke("history_usage");
    return Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).reduce((n,k) => n + new TextEncoder().encode(localStorage.getItem(k) ?? "").length,0);
  },
  async release(documentId: string, operation: string): Promise<void> {
    if (isTauri) return serialize(() => invoke("history_release", { documentId, operation }));
    await serialize(async () => {
      const record = await readRecord(documentId); if (!record) return;
      for (const entry of record.manifest.entries) if (entry.operation === operation) entry.operation = null;
      record.sha256 = await hash(new TextEncoder().encode(JSON.stringify(record.manifest)));
      localStorage.setItem(key(documentId),JSON.stringify(record));
    });
  },
  async maintain(): Promise<HistoryMaintenance> {
    if (isTauri) return serialize(() => invoke("history_maintain"));
    return serialize(async () => {
      const catalogue = await this.catalogue();
      if (catalogue.truncated) throw new Error("History cleanup stopped at an incomplete index; all sources are retained");
      const now = Date.now(); let removedVersions = 0;
      const updates: Array<[string,BrowserRecord]> = [];
      for (const m of catalogue.documents) {
        const record = (await readRecord(m.documentId))!;
        for (const entry of m.entries) await this.read(m.documentId,entry.sequence);
        const protectedSequences = new Set(m.entries.filter(e => e.operation).map(e => e.sequence));
        for (const kind of ["raw-disk","buffer-utf8"]) { const entry = [...m.entries].reverse().find(e => e.representation === kind); if (entry) protectedSequences.add(entry.sequence); }
        const days = new Set<number>();
        record.manifest.entries = [...m.entries].reverse().filter(entry => {
          const age = Math.max(0,now-entry.capturedAt), day = Math.floor(entry.capturedAt/86400000);
          if (protectedSequences.has(entry.sequence) || age <= 7*86400000) return true;
          if (age <= 90*86400000 && !days.has(day)) { days.add(day); return true; } return false;
        }).reverse();
        removedVersions += m.entries.length-record.manifest.entries.length;
        const refs = new Set(record.manifest.entries.map(e => e.sha256));
        record.contents = Object.fromEntries(Object.entries(record.contents).filter(([digest]) => refs.has(digest)));
        record.sha256 = await hash(new TextEncoder().encode(JSON.stringify(record.manifest)));
        updates.push([key(m.documentId),record]);
      }
      for (const [name,record] of updates) localStorage.setItem(name,JSON.stringify(record));
      return { byteUsage: await this.usage(), removedVersions, warnings: [], trimmedDocuments: [], setAside: 0 };
    });
  },
  async removeAll(): Promise<void> {
    if (isTauri) return serialize(() => invoke("history_remove_all"));
    await serialize(async () => {
      const catalogue = await this.catalogue();
      if (catalogue.truncated) throw new Error("History removal stopped at an incomplete index; sources are retained");
      if (catalogue.documents.some(m => m.entries.some(e => e.operation))) throw new Error("History is protecting an unfinished action");
      for (const name of Object.keys(localStorage).filter(k => k.startsWith(PREFIX))) localStorage.removeItem(name);
    });
  },
  async catalogue(): Promise<HistoryCatalogue> {
    if (isTauri) return invoke("history_catalogue");
    const result: HistoryCatalogue = { documents: [], warnings: [], truncated: false };
    const keys = Object.keys(localStorage).filter(key => key.startsWith(PREFIX));
    result.truncated = keys.length > 10000;
    for (const name of keys.slice(0,10000)) {
      try { const r = await readRecord(name.slice(PREFIX.length)); if (r) result.documents.push(r.manifest); }
      catch (error) { result.warnings.push(String(error)); }
    }
    result.documents.sort((a,b) => (b.entries.at(-1)?.capturedAt ?? 0) - (a.entries.at(-1)?.capturedAt ?? 0));
    return result;
  },
  async versions(documentId: string): Promise<HistoryManifest> {
    if (isTauri) return invoke("history_versions", { documentId });
    const r = await readRecord(documentId); if (!r) throw new Error("No local history exists for this document"); return r.manifest;
  },
  async read(documentId: string, sequence: number): Promise<HistoryVersion> {
    if (isTauri) return invoke("history_read", { documentId, sequence });
    const r = await readRecord(documentId);
    const entry = r?.manifest.entries.find(e => e.sequence === sequence);
    if (!r || !entry) throw new Error("This history version is unavailable");
    const stored = r.contents[entry.sha256];
    const bytes = new TextEncoder().encode(stored);
    if (await hash(bytes) !== entry.sha256 || bytes.length !== entry.byteLength) throw new Error("This saved version is damaged and can’t be opened");
    return { entry, content: entry.representation === "raw-disk" ? stored.replace(/^\ufeff/, "") : stored };
  },
  async capture(request: HistoryCapture): Promise<HistoryManifest> {
    if (isTauri) return serialize(() => invoke("history_capture", { request }));
    return serialize(async () => {
      if ((request.content === null) === (request.diskRevision === null)) throw new Error("History needs exactly one disk revision or editor buffer");
      const previous = await readRecord(request.documentId);
      const oldRaw = localStorage.getItem(key(request.documentId));
      let text: string; let format = request.format; let revision: FileRevision | null = null;
      if (request.content !== null) text = request.content.replace(/\r\n?/g,"\n");
      else {
        if (!request.currentPath) throw new Error("Raw history needs a path");
        const file = await fsApi.readText(request.currentPath);
        if (!sameRevision(request.diskRevision, file.revision)) throw new Error("The file changed on disk before AmberText could keep a copy of it");
        if (file.format.encoding !== "utf8") throw new Error("Original legacy bytes require native history");
        text = (file.format.bom ? "\ufeff" : "") + file.content; format = file.format; revision = file.revision;
      }
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > MAX_CONTENT) throw new Error("This version is too large to keep");
      const sha256 = await hash(bytes);
      const manifest: HistoryManifest = previous ? structuredClone(previous.manifest) : {
        version: 1, documentId: request.documentId, name: request.name, currentPath: null, canonicalPath: null, previousPaths: [], entries: [],
      };
      if (manifest.currentPath !== request.currentPath) {
        if (manifest.currentPath && !manifest.previousPaths.includes(manifest.currentPath)) manifest.previousPaths.push(manifest.currentPath);
        manifest.currentPath = request.currentPath; manifest.canonicalPath = null;
      }
      if (revision) manifest.canonicalPath = revision.canonicalPath;
      manifest.name = request.name;
      const representation = request.content === null ? "raw-disk" : "buffer-utf8";
      const last = manifest.entries.at(-1);
      if (!(last?.sha256 === sha256 && last.representation === representation && JSON.stringify(last.format) === JSON.stringify(format) && last.operation === request.operation)) {
        if (manifest.entries.length >= 10000) throw new Error("History reached its version limit");
        manifest.entries.push({ sequence: (last?.sequence ?? 0)+1, capturedAt: Date.now(), reason: request.reason,
          representation, sha256, byteLength: bytes.length, format, diskRevision: revision, operation: request.operation });
      }
      const contents = { ...previous?.contents };
      if (contents[sha256] !== undefined && contents[sha256] !== text) throw new Error("A history content file failed its integrity check");
      contents[sha256] = text;
      const record: BrowserRecord = { sha256: await hash(new TextEncoder().encode(JSON.stringify(manifest))), manifest, contents };
      if (localStorage.getItem(key(request.documentId)) !== oldRaw) throw new Error("History changed before commit");
      const raw = JSON.stringify(record); localStorage.setItem(key(request.documentId),raw);
      if (localStorage.getItem(key(request.documentId)) !== raw) throw new Error("History changed during verification");
      return manifest;
    });
  },
};
