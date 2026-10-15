import { invoke } from "@tauri-apps/api/core";
import { isTauri, type FileRevision, type TextFormat } from "./platform";

export interface RecoveryDoc {
  id: string; name: string; currentPath: string | null; originalPath: string | null;
  content: string; savedContent: string | null; savedRevision: FileRevision | null;
  format: TextFormat | null; originalText: string | null; updatedAt: number; reason: string | null;
}
export interface RecoverySnapshot {
  version: 1; updatedAt: number; docs: RecoveryDoc[]; activeId: string | null;
  root: string | null; legacySourceHash: string | null;
}
export interface RecoveryLoaded { snapshot: RecoverySnapshot | null; sequence: number; warnings: string[]; writable: boolean }
/** `omitted` documents were left out to stay within the limits; unsaved writing is kept first. */
export interface RecoveryWritten { sequence: number; omitted: number }
const JOURNAL = "ambertext:recovery-journal";
export const FALLBACK_KEY = "ambertext:recovery-fallback";
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENTS = 256;

/** Mirrors recovery.rs `fit`: keep what fits, unsaved and active writing first, in order. */
function fitRecovery(snapshot: RecoverySnapshot): { snapshot: RecoverySnapshot; omitted: number } {
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const budget = MAX_BYTES - size({ ...snapshot, docs: [] }) - 256;
  const sizes = snapshot.docs.map(doc => size(doc) + 1);
  if (snapshot.docs.length <= MAX_DOCUMENTS && sizes.reduce((a, b) => a + b, 0) <= budget) return { snapshot, omitted: 0 };
  const rank = (i: number) => (snapshot.docs[i].savedContent === snapshot.docs[i].content ? 2 : 0) + (snapshot.docs[i].id === snapshot.activeId ? 0 : 1);
  const keep = new Set<number>(); let used = 0;
  for (const i of snapshot.docs.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || a - b)) {
    if (keep.size < MAX_DOCUMENTS && used + sizes[i] <= budget) { keep.add(i); used += sizes[i]; }
  }
  return { snapshot: { ...snapshot, docs: snapshot.docs.filter((_, i) => keep.has(i)) }, omitted: snapshot.docs.length - keep.size };
}

export function parseRecovery(raw: string): RecoverySnapshot {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Recovery exceeds its safe read limit");
  const value = JSON.parse(raw) as RecoverySnapshot;
  if (value?.version !== 1 || !Array.isArray(value.docs) || value.docs.length > 256 || !Number.isFinite(value.updatedAt)) throw new Error("Unsupported recovery record");
  const ids = new Set<string>();
  const optionalString = (v: unknown) => v === null || typeof v === "string";
  if (![value.activeId, value.root, value.legacySourceHash].every(optionalString)) throw new Error("Invalid recovery metadata");
  for (const doc of value.docs) {
    if (!doc || typeof doc.id !== "string" || !doc.id || ids.has(doc.id) || typeof doc.content !== "string" || typeof doc.name !== "string"
      || ![doc.savedContent, doc.currentPath, doc.originalPath, doc.originalText, doc.reason].every(optionalString) || !Number.isFinite(doc.updatedAt)
      || (doc.savedRevision !== null && (!doc.savedRevision || typeof doc.savedRevision.canonicalPath !== "string" || !/^[a-f0-9]{64}$/.test(doc.savedRevision.sha256)))
      || (doc.format !== null && (!doc.format || !["utf8", "windows1252"].includes(doc.format.encoding) || typeof doc.format.bom !== "boolean"
        || typeof doc.format.confirmed !== "boolean" || !["\n", "\r\n", "\r", "mixed"].includes(doc.format.eol)))) throw new Error("Invalid recovery document");
    ids.add(doc.id);
  }
  return value;
}
async function hash(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export const recoveryApi = {
  async load(): Promise<RecoveryLoaded> {
    if (isTauri) return invoke("recovery_load");
    const raw = localStorage.getItem(JOURNAL);
    if (!raw) return { snapshot: null, sequence: 0, warnings: [], writable: true };
    try {
      const envelope = JSON.parse(raw);
      const snapshot = parseRecovery(JSON.stringify(envelope.snapshot));
      if (await hash(JSON.stringify(snapshot)) !== envelope.sha256) throw new Error("Recovery integrity check failed");
      return { snapshot, sequence: envelope.sequence, warnings: [], writable: true };
    } catch (error) { return { snapshot: null, sequence: 0, warnings: [String(error)], writable: true }; }
  },
  async write(next: RecoverySnapshot): Promise<RecoveryWritten> {
    if (isTauri) return invoke("recovery_write", { snapshot: next });
    const { snapshot, omitted } = fitRecovery(next);
    parseRecovery(JSON.stringify(snapshot));
    const current = await this.load();
    // Like recovery.rs: a damaged journal is kept under another key, never overwritten.
    const raw = current.warnings.length ? localStorage.getItem(JOURNAL) : null;
    if (raw !== null) localStorage.setItem(`${JOURNAL}.corrupt-${Date.now()}`, raw);
    const sequence = current.sequence + 1;
    const envelope = JSON.stringify({ sequence, snapshot, sha256: await hash(JSON.stringify(snapshot)) });
    localStorage.setItem(JOURNAL, envelope);
    if (localStorage.getItem(JOURNAL) !== envelope) throw new Error("Recovery could not be verified");
    return { sequence, omitted };
  },
  async preserveLegacy(source: string): Promise<string> {
    if (isTauri) return invoke("recovery_preserve_legacy", { source });
    const fingerprint = await hash(source);
    const key = "ambertext:legacy-source:" + fingerprint;
    const existing = localStorage.getItem(key);
    if (existing !== null && existing !== source) throw new Error("Legacy recovery copy changed");
    localStorage.setItem(key, source);
    if (localStorage.getItem(key) !== source) throw new Error("Legacy recovery copy could not be verified");
    return fingerprint;
  },
};
