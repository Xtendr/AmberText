import { create } from "zustand";
import { fsApi, ioMessage, sameRevision, type FileRevision, type TextFormat } from "./platform";
import { getState, isDirty } from "../state/store";
import { isInside, plainPath } from "./paths";
import { isPathOutdated, searchHash, useWorkspaceSearch, type SearchHit, type SearchOptions } from "./workspaceSearch";

const MAX_FILE = 2 * 1024 * 1024;
const MAX_REVIEW = 32 * 1024 * 1024;
const MAX_REPLACEMENT = 64 * 1024;
const bytes = (text: string) => new TextEncoder().encode(text).length;
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");
export interface ReplacementProposal {
  path: string; relativePath: string; documentId: string | null;
  source: "disk" | "buffer"; open: boolean; dirty: boolean; revision: FileRevision;
  contentHash: string; afterHash: string; format: TextFormat;
  before: string; after: string; ranges: Array<[number, number]>;
  selected: boolean;
}
export interface ReplacementReview {
  id: string; queryId: string; root: string; query: string; replacement: string;
  options: SearchOptions; proposals: ReplacementProposal[];
  warnings: string[]; partial: boolean; stale: boolean;
}
interface State { replacement: string; review: ReplacementReview | null; busy: boolean; error: string | null }
export const useWorkspaceReplacement = create<State>(() => ({ replacement: "", review: null, busy: false, error: null }));
let generation = 0;
export function clearReplacementReview() {
  generation++;
  useWorkspaceReplacement.setState({ review: null, busy: false, error: null });
}
export function setReplacement(text: string) {
  clearReplacementReview();
  useWorkspaceReplacement.setState({ replacement: text });
}
export function selectReplacement(path: string, selected: boolean) {
  const review = useWorkspaceReplacement.getState().review;
  if (!review || review.stale) return;
  useWorkspaceReplacement.setState({ review: { ...review, proposals: review.proposals.map(p => p.path === path ? { ...p, selected } : p) } });
}
/** Applies only captured literal ranges; never runs a matcher after review. */
export function replacementText(before: string, ranges: Array<[number, number]>, replacement: string) {
  let cursor = 0, length = before.length;
  for (const [from, to] of ranges) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < cursor || to <= from || to > before.length
      || (from > 0 && /[\uDC00-\uDFFF]/.test(before[from])) || (to < before.length && /[\uDC00-\uDFFF]/.test(before[to]))) {
      throw new Error("The search results are out of date. Search again.");
    }
    length += replacement.length - (to - from); cursor = to;
  }
  if (length > MAX_FILE) throw new Error("The result would be larger than 2 MB, which is too large to preview.");
  cursor = 0; const parts: string[] = [];
  for (const [from, to] of ranges) { parts.push(before.slice(cursor, from), replacement); cursor = to; }
  parts.push(before.slice(cursor));
  const after = parts.join("");
  if (bytes(after) > MAX_FILE) throw new Error("The result would be larger than 2 MB, which is too large to preview.");
  return after;
}
function sameSearch(queryId: string, root: string, query: string, options: SearchOptions, changes?: number) {
  const current = useWorkspaceSearch.getState();
  return !current.stale && !current.busy && current.queryId === queryId && current.root === root
    && getState().workspace?.root === root && current.query === query
    && current.options.caseSensitive === options.caseSensitive && current.options.wholeWord === options.wholeWord
    && (changes === undefined || current.changes === changes);
}
/** Read-only capture. No writes, editor transactions, history or save calls. */
export async function previewWorkspaceReplacement(): Promise<boolean> {
  const mine = ++generation;
  const search = useWorkspaceSearch.getState();
  const replacement = normalize(useWorkspaceReplacement.getState().replacement);
  useWorkspaceReplacement.setState({ review: null, busy: true, error: null });
  try {
    if (search.busy || search.stale || !search.queryId || !search.root || !search.query || !search.hits.length) {
      throw new Error("Search first, then preview the changes.");
    }
    if (bytes(replacement) > MAX_REPLACEMENT) throw new Error("The replacement text is too long.");
    const options = { ...search.options }, queryId = search.queryId, root = search.root, query = search.query, changes = search.changes;
    const groups = new Map<string, SearchHit[]>();
    for (const hit of search.hits) { const group = groups.get(hit.path) ?? []; group.push(structuredClone(hit)); groups.set(hit.path, group); }
    const warnings = [...search.coverage.warnings];
    const proposals: ReplacementProposal[] = [];
    let retained = 0;
    for (const [path, hits] of groups) {
      if (mine !== generation) return false;
      if (!sameSearch(queryId, root, query, options, changes)) throw new Error("Your writing changed while preparing the preview. Search again.");
      try {
        const first = hits[0];
        const relativeParts = first.relativePath.split(/[\\/]/);
        if (!relativeParts.length || relativeParts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
          throw new Error("This folder can’t be used. Open it again and search.");
        }
        // Files cut off by a match limit list only some of their matches; never replace those.
        if (hits.some(h => h.truncated)) throw new Error("Only some matches in this file are listed, so it was not changed.");
        const sourcePath = plainPath(path);
        if (!isInside(sourcePath, root) || hits.some(h => h.contentHash !== first.contentHash || h.source !== first.source
          || h.documentId !== first.documentId || JSON.stringify(h.revision) !== JSON.stringify(first.revision))) {
          throw new Error("This file is open in more than one place. Close the extra tab and search again.");
        }
        const disk = await fsApi.readText(sourcePath);
        if (!first.revision || !sameRevision(first.revision, disk.revision)) throw new Error("The file changed since the search.");
        const docs = getState().docs.filter(d => d.path === sourcePath || d.revision?.canonicalPath === disk.revision.canonicalPath);
        if (docs.length > 1) throw new Error("This file is open in more than one tab. Close the extra tab first.");
        const doc = first.documentId ? getState().docs.find(d => d.id === first.documentId) : docs[0];
        if (first.source === "buffer" && (!doc || !doc.path || !sameRevision(doc.revision, disk.revision) || !isDirty(doc))) throw new Error("That document changed or was closed since the search.");
        if (doc && (!sameRevision(doc.revision, disk.revision) || docs[0]?.id !== doc.id)) throw new Error("The file changed on disk. Open it and choose which version to keep first.");
        const before = normalize(doc?.content ?? disk.content);
        if (before.length > MAX_FILE || bytes(before) > MAX_FILE || await searchHash(before) !== first.contentHash) {
          throw new Error("The writing changed, or it’s too large to preview.");
        }
        const ranges = hits.map(h => [h.from, h.to] as [number, number]).sort((a, b) => a[0] - b[0]);
        const after = replacementText(before, ranges, replacement);
        const size = bytes(before) + bytes(after);
        if (retained + size > MAX_REVIEW) throw new Error("The preview is too large. Select fewer files.");
        const afterHash = await searchHash(after);
        // Recheck after asynchronous hashing: no proposal silently captures newer writing.
        const currentDoc = doc && getState().docs.find(d => d.id === doc.id);
        if (doc && (!currentDoc || currentDoc.path !== doc.path || currentDoc.content !== doc.content || !sameRevision(currentDoc.revision, disk.revision))) {
          throw new Error("Your writing changed while preparing the preview. Preview again.");
        }
        retained += size;
        proposals.push({ path: sourcePath, relativePath: first.relativePath, documentId: doc?.id ?? null, source: first.source,
          open: !!doc, dirty: !!doc && isDirty(doc), revision: { ...disk.revision }, format: { ...(doc?.format ?? disk.format) },
          contentHash: first.contentHash, afterHash, before, after, ranges, selected: false });
      } catch (error) { if (warnings.length < 100) warnings.push(path + ": " + ioMessage(error)); }
    }
    if (mine !== generation) return false;
    // Files flagged as changed that could not be re-verified: say so plainly instead of an empty review.
    if (!proposals.length && [...groups.keys()].some(path => isPathOutdated(search, path))) throw new Error("The writing changed since this search. Search again.");
    if (!sameSearch(queryId, root, query, options, changes)) throw new Error("Your writing changed while preparing the preview. Search again.");
    const review: ReplacementReview = { id: crypto.randomUUID(), queryId, root, query, replacement, options, proposals, warnings,
      partial: search.coverage.partial || search.resultLimited || proposals.length !== groups.size, stale: false };
    useWorkspaceReplacement.setState({ review, busy: false });
    return true;
  } catch (error) {
    if (mine === generation) useWorkspaceReplacement.setState({ busy: false, error: ioMessage(error) });
    return false;
  }
}
// Keep reviewed text unchanged for inspection, but refuse selection after invalidation.
useWorkspaceSearch.subscribe(() => {
  const review = useWorkspaceReplacement.getState().review;
  const search = useWorkspaceSearch.getState();
  if (review && !review.stale && (!sameSearch(review.queryId, review.root, review.query, review.options) || review.proposals.some(p => isPathOutdated(search, p.path)))) {
    useWorkspaceReplacement.setState({ review: { ...review, stale: true } });
  }
});
