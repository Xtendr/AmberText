import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { fsApi, isTauri, ioMessage, sameRevision, MARKDOWN_EXTENSIONS, type FileRevision } from "./platform";
import { getState, isDirty, useStore } from "../state/store";
import { isInside, samePath, relativeTo } from "./paths";
import { parseMarkdownReferences, resolveReferenceTarget, type MarkdownReference, type ReferenceTarget } from "./markdownReferences";
import { searchHash, type SearchCoverage } from "./workspaceSearch";
interface TargetInfo { status: "present" | "missing" | "unknown"; canonicalPath: string | null; outside: boolean; message: string }
export interface AssetReference extends MarkdownReference, ReferenceTarget {
  sourcePath: string; relativePath: string; source: "disk" | "buffer"; documentId: string | null;
  contentHash: string; revision: FileRevision | null; status: string;
  canonicalPath: string | null; outside: boolean; uses: number; documents: number;
}
const emptyCoverage = (): SearchCoverage => ({ visited: 0, eligible: 0, scanned: 0, bytesRead: 0, excluded: 0, skipped: 0, partial: false, cancelled: false, warnings: [] });
interface State { busy: boolean; stale: boolean; root: string | null; records: AssetReference[]; coverage: SearchCoverage; error: string | null }
export const useAssetDiagnostics = create<State>(() => ({ busy: false, stale: false, root: null, records: [], coverage: emptyCoverage(), error: null }));
let generation = 0;
// Native cancel is only sent while a scan is actually running.
let running = 0;
let activeProgress: { generation: number; publish: () => void } | null = null;
export const assetDiagnosticsApi = {
  async cancel() { if (isTauri && running > 0) await invoke("reference_scan_cancel"); },
  async catalogue(root: string): Promise<{ paths: string[]; coverage: SearchCoverage }> {
    if (isTauri) return invoke("reference_catalogue", { root });
    const c = fsApi.browserSearchCatalogue(root); return { paths: c.paths, coverage: { ...emptyCoverage(), ...c.coverage } };
  },
  async read(root: string, path: string) {
    if (isTauri) return invoke<{ content: string; revision: FileRevision; byteLength: number; format: { confirmed: boolean } }>("reference_read", { root, path });
    const file = await fsApi.readText(path); const byteLength = new TextEncoder().encode(file.content).length;
    if (byteLength > 2 * 1024 * 1024) throw new Error("Skipped: larger than 2 MB");
    return { ...file, byteLength };
  },
  async target(root: string, path: string): Promise<TargetInfo> {
    if (isTauri) return invoke("reference_target", { root, path });
    // Browser memory fixtures have lexical identities; native metadata proves
    // physical aliases separately. Browser binary import remains a no-op.
    return { ...fsApi.browserReferenceTarget(path), outside: !isInside(path, root) };
  },
};
export function invalidateAssetDiagnostics() {
  generation++; void assetDiagnosticsApi.cancel().catch(() => undefined);
  // Only results from a started check can become outdated.
  useAssetDiagnostics.setState(s => ({ stale: s.root !== null, busy: false }));
}
export function stopAssetDiagnostics() {
  if (activeProgress?.generation === generation) activeProgress.publish();
  generation++; void assetDiagnosticsApi.cancel().catch(() => undefined);
  useAssetDiagnostics.setState(s => ({ busy: false, coverage: { ...s.coverage, partial: true, cancelled: true } }));
}
/** Explicit, bounded, read-only scan. No renderer, binary reads or persistent index. */
export async function scanAssetDiagnostics() {
  const mine = ++generation, state = getState(), root = state.workspace?.root;
  useAssetDiagnostics.setState({ busy: !!root, stale: false, root: root ?? null, records: [], coverage: emptyCoverage(), error: null });
  if (!root) return false;
  const current = () => mine === generation && getState().workspace?.root === root;
  const warning = (coverage: SearchCoverage, message: string, important = false) => {
    if (important) { coverage.warnings.unshift(message); coverage.warnings.length = Math.min(50, coverage.warnings.length); }
    else if (coverage.warnings.length < 50) coverage.warnings.push(message);
  };
  const issue = (coverage: SearchCoverage, message: string, important = false) => { coverage.partial = true; coverage.skipped++; warning(coverage, message, important); };
  let counted = false;
  try {
    await assetDiagnosticsApi.cancel(); if (!current()) return false;
    running++; counted = true;
    const catalogue = await assetDiagnosticsApi.catalogue(root); if (!current()) return false;
    const coverage = { ...catalogue.coverage, warnings: [...catalogue.coverage.warnings] };
    const paths = [...catalogue.paths];
    const eligible = (path: string) => isInside(path, root) && MARKDOWN_EXTENSIONS.includes(path.split(".").at(-1)?.toLowerCase() ?? "")
      && !relativeTo(path, root).split(/[\\/]/).some(p => p.startsWith(".") || p.startsWith("~") || ["node_modules", "target", "__pycache__", "$RECYCLE.BIN"].includes(p));
    for (const doc of state.docs) if (doc.path && isDirty(doc) && eligible(doc.path) && !paths.includes(doc.path)) paths.push(doc.path);
    const records: AssetReference[] = [], targets = new Map<string, TargetInfo>(); let overlayBytes = 0, readBudget = 0, processedBytes = 0;
    const publish = () => {
      const groups = new Map<string, AssetReference[]>();
      for (const record of records) if (record.type === "local" && record.status === "present" && record.canonicalPath) { const group = groups.get(record.canonicalPath) ?? []; group.push(record); groups.set(record.canonicalPath, group); }
      for (const group of groups.values()) { const documents = new Set(group.map(r => r.sourcePath)).size; for (const record of group) { record.uses = group.length; record.documents = documents; } }
      useAssetDiagnostics.setState({ records: records.map(r => ({ ...r })), coverage: { ...coverage, warnings: [...coverage.warnings] } });
    };
    activeProgress = { generation: mine, publish };
    let lastPublish = performance.now();
    for (const path of paths.slice(0, 20000)) {
      if (!current()) return false;
      // Reserve the bounded reader's full 2 MiB + oversize-detection byte.
      // Failed reads consume that upper bound instead of allowing unlimited
      // failed IO after the combined budget is reached.
      if (readBudget + 2 * 1024 * 1024 + 1 > 256 * 1024 * 1024) { issue(coverage, "The folder is too large to check completely.", true); break; }
      try {
        let disk: Awaited<ReturnType<typeof assetDiagnosticsApi.read>> | null = null;
        try { disk = await assetDiagnosticsApi.read(root, path); readBudget += disk.byteLength; coverage.bytesRead += disk.byteLength; }
        catch (error) { readBudget += 2 * 1024 * 1024 + 1; if (!state.docs.some(d => samePath(d.path, path) && isDirty(d))) throw error; issue(coverage, relativeTo(path, root) + ": the saved file couldn’t be read, so the open version was checked."); }
        const tabs = state.docs.filter(d => samePath(d.path, path) || (!!disk && d.revision?.canonicalPath === disk.revision.canonicalPath));
        if (tabs.length > 1) throw new Error("This file is open in more than one tab. Close the extra tab and try again.");
        const doc = tabs[0], content = (doc?.content ?? disk?.content ?? "").replace(/\r\n?/g, "\n");
        const bytes = new TextEncoder().encode(content).length;
        if (bytes > 2 * 1024 * 1024 || processedBytes + bytes > 256 * 1024 * 1024 || (doc && overlayBytes + bytes > 32 * 1024 * 1024)) throw new Error("The folder is too large to check completely.");
        if (doc) overlayBytes += bytes;
        if (doc && disk && !sameRevision(doc.revision, disk.revision)) issue(coverage, relativeTo(path, root) + ": the open document differs from the saved file; the open version was checked.");
        if ((doc?.format ?? disk?.format)?.confirmed === false) issue(coverage, relativeTo(path, root) + ": open and save this file once to check it fully.");
        processedBytes += bytes; coverage.scanned++;
        const contentHash = await searchHash(content), parsed = parseMarkdownReferences(content);
        if (parsed.partial) { coverage.partial = true; for (const message of parsed.warnings) warning(coverage, relativeTo(path, root) + ": " + message); }
        for (const reference of parsed.references) {
          if (!current()) return false;
          if (records.length >= 20000) { issue(coverage, "Only the first 20,000 images and links are listed.", true); break; }
          let resolved = resolveReferenceTarget(reference.target, path);
          if (resolved.type === "unresolved" && parsed.partial) resolved = { ...resolved, type: "unknown", message: "Only part of this document was checked, so this couldn’t be confirmed." };
          let info: TargetInfo = { status: "unknown", canonicalPath: null, outside: false, message: resolved.message };
          if (resolved.type === "local" && resolved.path) {
            const cached = targets.get(resolved.path);
            if (cached) info = cached;
            else {
              try { info = await assetDiagnosticsApi.target(root, resolved.path); }
              catch (error) { info.message = ioMessage(error); }
              targets.set(resolved.path, info);
            }
            if (info.status === "unknown") issue(coverage, resolved.path + ": " + info.message);
          }
          records.push({ ...reference, ...resolved, sourcePath: path, relativePath: relativeTo(path, root), source: doc ? "buffer" : "disk", documentId: doc?.id ?? null,
            contentHash, revision: doc?.revision ?? disk?.revision ?? null, status: resolved.type === "local" ? info.status : resolved.type,
            canonicalPath: info.canonicalPath, outside: info.outside, message: info.message, uses: 0, documents: 0 });
        }
      } catch (error) { issue(coverage, relativeTo(path, root) + ": " + ioMessage(error)); }
      if (!current()) return false;
      if (performance.now() - lastPublish > 50) { publish(); lastPublish = performance.now(); }
      if (records.length >= 20000) { issue(coverage, "Only the first 20,000 images and links are listed.", true); break; }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (paths.length > 20000) issue(coverage, "The folder has too many files to check completely.", true);
    if (current()) { publish(); useAssetDiagnostics.setState({ busy: false, coverage }); return true; }
    return false;
  } catch (error) { if (current()) useAssetDiagnostics.setState({ busy: false, error: ioMessage(error), coverage: { ...useAssetDiagnostics.getState().coverage, partial: true } }); return false; }
  finally { if (counted) running--; if (activeProgress?.generation === mine) activeProgress = null; }
}
let observedRoot = getState().workspace?.root, observedDocs = getState().docs;
useStore.subscribe(state => {
  const changed = state.docs !== observedDocs && (state.docs.length !== observedDocs.length || state.docs.some((d, i) => {
    const prior = observedDocs[i]; return d.id !== prior.id || d.path !== prior.path || d.content !== prior.content || d.revision?.sha256 !== prior.revision?.sha256;
  }));
  observedDocs = state.docs;
  if (state.workspace?.root !== observedRoot || changed) { observedRoot = state.workspace?.root; invalidateAssetDiagnostics(); }
});
window.addEventListener("ambertext:filesystem-changed", () => invalidateAssetDiagnostics());
