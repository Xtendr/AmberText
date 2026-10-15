import { invoke } from "@tauri-apps/api/core";
import { isTauri, sameRevision, type FileRevision } from "./platform";
import { searchHash } from "./workspaceSearch";
export type FileOutcome = "pending" | "prepared" | "applying" | "applied" | "skipped" | "failed" | "reverting" | "reverted" | "conflict";
export interface ReplacementFileReceipt {
  documentId: string; path: string; relativePath: string; mode: "disk" | "buffer";
  beforeHash: string; afterHash: string; beforeRevision: FileRevision; afterRevision: FileRevision | null;
  beforeSequence: number | null; afterSequence: number | null; diskSequence: number | null; state: FileOutcome; message: string;
}
export interface ReplacementReceipt {
  version: 1; id: string; root: string; createdAt: number; updatedAt: number;
  state: "running" | "stopped" | "complete" | "releasing" | "released"; files: ReplacementFileReceipt[];
}
export interface ReceiptRecord { receipt: ReplacementReceipt; revision: FileRevision }
export interface ReceiptCatalogue { records: ReceiptRecord[]; warnings: string[]; truncated: boolean }
const PREFIX = "ambertext:replacement-receipt:";
const LIMIT = 4 * 1024 * 1024;
const validId = (s: string) => /^[A-Za-z0-9_-]{1,80}$/.test(s);
function validate(r: ReplacementReceipt) {
  if (r.version !== 1 || !validId(r.id) || !Array.isArray(r.files) || !r.files.length || r.files.length > 2000
    || !["running", "stopped", "complete", "releasing", "released"].includes(r.state)
    || new Set(r.files.map(f => f.documentId)).size !== r.files.length
    || r.files.some(f => !validId(f.documentId) || !/^[a-f0-9]{64}$/.test(f.beforeHash) || !/^[a-f0-9]{64}$/.test(f.afterHash)
      || !["disk", "buffer"].includes(f.mode) || !["pending", "prepared", "applying", "applied", "skipped", "failed", "reverting", "reverted", "conflict"].includes(f.state))) {
    throw new Error("A past replacement couldn’t be read. It has been kept, not deleted.");
  }
}
async function read(id: string): Promise<ReceiptRecord | null> {
  if (!validId(id)) throw new Error("Invalid replacement identity.");
  const raw = localStorage.getItem(PREFIX + id); if (!raw) return null;
  if (new TextEncoder().encode(raw).length > LIMIT) throw new Error("A past replacement record is too large to read.");
  const env = JSON.parse(raw); validate(env.receipt);
  if (env.receipt.id !== id || env.sha256 !== await searchHash(JSON.stringify(env.receipt))) throw new Error("A past replacement record is damaged. It has been kept, not deleted.");
  return { receipt: env.receipt, revision: { canonicalPath: PREFIX + id, sha256: await searchHash(raw) } };
}
const KEEP = 100;
/** Remove the oldest released receipts beyond the bound; anything still undoable or unfinished stays. */
function prune() {
  const found: Array<{ key: string; createdAt: number; released: boolean }> = [];
  for (const key of Object.keys(localStorage).filter(k => k.startsWith(PREFIX))) {
    try { const r = JSON.parse(localStorage.getItem(key) ?? "").receipt; found.push({ key, createdAt: r.createdAt, released: r.state === "released" }); } catch { /* unreadable receipts are kept */ }
  }
  found.sort((a, b) => b.createdAt - a.createdAt);
  for (const f of found.slice(KEEP)) if (f.released) localStorage.removeItem(f.key);
}
let gate: Promise<unknown> = Promise.resolve();
export const replacementReceiptApi = {
  write(receipt: ReplacementReceipt, expected: FileRevision | null): Promise<ReceiptRecord> {
    const operation = gate.catch(() => undefined).then(async () => {
      validate(receipt);
      if (isTauri) return invoke<ReceiptRecord>("replacement_receipt_write", { receipt, expected });
      const current = await read(receipt.id);
      if (current ? !sameRevision(expected, current.revision) : expected !== null) throw new Error("Replacement receipt changed; sources retained.");
      const raw = JSON.stringify({ receipt, sha256: await searchHash(JSON.stringify(receipt)) });
      if (new TextEncoder().encode(raw).length > LIMIT) throw new Error("Replacement receipt exceeds its write limit.");
      const previous = localStorage.getItem(PREFIX + receipt.id);
      if (current && current.revision.sha256 !== await searchHash(previous!)) throw new Error("Receipt changed before commit.");
      if (!current && previous !== null) throw new Error("Receipt appeared before commit.");
      localStorage.setItem(PREFIX + receipt.id, raw);
      const record = await read(receipt.id);
      if (!record || record.revision.sha256 !== await searchHash(raw)) throw new Error("Receipt changed during verification.");
      if (receipt.state === "released") prune();
      return record;
    });
    gate = operation; return operation;
  },
  async catalogue(): Promise<ReceiptCatalogue> {
    if (isTauri) return invoke("replacement_receipt_catalogue");
    const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX));
    const result: ReceiptCatalogue = { records: [], warnings: [], truncated: keys.length > 200 };
    let retained = 0;
    for (const key of keys.slice(0, 200)) {
      retained += new TextEncoder().encode(localStorage.getItem(key) ?? "").length;
      if (retained > 16 * 1024 * 1024) { result.truncated = true; break; }
      try { const r = await read(key.slice(PREFIX.length)); if (r) result.records.push(r); }
      catch (error) { result.warnings.push(String(error)); }
    }
    result.records.sort((a, b) => b.receipt.createdAt - a.receipt.createdAt); return result;
  },
};
