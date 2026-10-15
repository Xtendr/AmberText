import { markdownLanguage } from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
import { referenceUtils } from "./markdown";
import { dirname, isAbsolute, linkFilePath, resolvePath } from "./paths";

export type Span = [number, number];
export interface MarkdownReference {
  kind: "image" | "link";
  syntax: "inline" | "reference" | "autolink";
  sourceSpan: Span;
  destinationSpan: Span | null;
  definitionSpan: Span | null;
  target: string | null;
  label: string | null;
}
export interface ReferenceParse {
  references: MarkdownReference[];
  htmlSpans: Span[];
  partial: boolean;
  warnings: string[];
}
const MAX_REFERENCES = 2000;
const MAX_SOURCE = 2 * 1024 * 1024;
function destination(node: SyntaxNode, source: string): { span: Span; target: string } {
  let from = node.from, to = node.to;
  if (source[from] === "<" && source[to - 1] === ">") { from++; to--; }
  return { span: [from, to], target: referenceUtils.unescape(source.slice(from, to)) };
}
/** Exact UTF-16 spans in the supplied source. Does not render, fetch or mutate. */
export function parseMarkdownReferences(source: string): ReferenceParse {
  const result: ReferenceParse = { references: [], htmlSpans: [], partial: false, warnings: [] };
  if (source.length > MAX_SOURCE || new TextEncoder().encode(source).length > MAX_SOURCE) {
    return { ...result, partial: true, warnings: ["Only part of this document was checked, because it is larger than 2 MB."] };
  }
  // The renderer excludes initial frontmatter. Mask it without moving offsets.
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/.exec(source);
  const parsed = frontmatter ? frontmatter[0].replace(/[^\r\n]/g, " ") + source.slice(frontmatter[0].length) : source;
  const tree = markdownLanguage.parser.parse(parsed);
  const definitions = new Map<string, { span: Span; target: string; definition: Span }>();
  const nodes: SyntaxNode[] = [];
  tree.iterate({ enter(cursor) {
    const node = cursor.node;
    if (["CodeBlock", "FencedCode", "InlineCode"].includes(node.name)) return false;
    if (node.name === "HTMLBlock" || node.name === "HTMLTag") {
      if (result.htmlSpans.length < MAX_REFERENCES) result.htmlSpans.push([node.from, node.to]);
      else result.partial = true;
      return false;
    }
    if (node.name === "LinkReference") {
      const label = node.getChild("LinkLabel"), url = node.getChild("URL");
      if (label && url) {
        const key = referenceUtils.label(source.slice(label.from + 1, label.to - 1));
        if (key.startsWith("^")) {
          result.partial = true;
          if (!result.warnings.includes("Footnote definition contents need separate review.")) result.warnings.push("Footnote definition contents need separate review.");
          return false;
        }
        // CommonMark/renderer semantics: the first definition wins.
        if (!definitions.has(key)) {
          if (definitions.size >= MAX_REFERENCES) { result.partial = true; if (!result.warnings.includes("Reference definition limit reached (2,000).")) result.warnings.push("Reference definition limit reached (2,000)."); }
          else definitions.set(key, { ...destination(url, source), definition: [node.from, node.to] });
        }
      }
      return false;
    }
    if (["Link", "Image", "Autolink"].includes(node.name)) {
      if (nodes.length < MAX_REFERENCES) nodes.push(node);
      else result.partial = true;
    }
  } });
  for (const node of nodes) {
    const url = node.getChild("URL");
    if (url) {
      const target = destination(url, source);
      result.references.push({ kind: node.name === "Image" ? "image" : "link", syntax: node.name === "Autolink" ? "autolink" : "inline",
        sourceSpan: [node.from, node.to], destinationSpan: target.span, definitionSpan: null,
        target: node.name === "Autolink" && !target.target.includes(":") && target.target.includes("@") ? "mailto:" + target.target : target.target, label: null });
    } else {
      const explicit = node.getChild("LinkLabel");
      const marks = node.getChildren("LinkMark"), open = marks[0], close = marks.find(m => source.slice(m.from, m.to) === "]");
      const paren = marks.find(m => source.slice(m.from, m.to) === "(");
      if (paren) {
        result.references.push({ kind: node.name === "Image" ? "image" : "link", syntax: "inline", sourceSpan: [node.from, node.to], destinationSpan: [paren.to, paren.to], definitionSpan: null, target: "", label: null });
        continue;
      }
      const rawLabel = explicit && explicit.to - explicit.from > 2 ? source.slice(explicit.from + 1, explicit.to - 1)
        : open && close ? source.slice(open.to, close.from) : "";
      const label = referenceUtils.label(rawLabel), defined = definitions.get(label);
      if (label.startsWith("^")) continue;
      result.references.push({ kind: node.name === "Image" ? "image" : "link", syntax: "reference", sourceSpan: [node.from, node.to],
        destinationSpan: defined?.span ?? null, definitionSpan: defined?.definition ?? null, target: defined?.target ?? null, label });
    }
  }
  if (result.htmlSpans.length) { result.partial = true; result.warnings.push("Raw HTML needs separate review; its targets are not included in Markdown reference counts."); }
  if (result.partial && nodes.length >= MAX_REFERENCES) result.warnings.push("Per-source reference limit reached (2,000). Counts are partial.");
  return result;
}

export interface ReferenceTarget {
  type: "local" | "remote" | "embedded" | "fragment" | "unresolved" | "unknown";
  path: string | null;
  fragment: string;
  message: string;
}
/** Resolve locally without fetching remote URLs or guessing lexical case aliases. */
export function resolveReferenceTarget(target: string | null, documentPath: string | null): ReferenceTarget {
  const outcome = (type: ReferenceTarget["type"], message = "", path: string | null = null, fragment = ""): ReferenceTarget => ({ type, path, fragment, message });
  if (target === null) return outcome("unresolved", "No definition; this reference renders as text.");
  if (target.startsWith("#")) return outcome("fragment", "Same-document heading; not an asset file.", null, target.slice(1));
  if (/^data:/i.test(target)) return outcome("embedded", "Embedded content; not a local file.");
  if (/^file:/i.test(target)) return outcome("unknown", "File URLs need explicit review; not probed automatically.");
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return outcome("remote", "Remote URL; not fetched.");
  if (/^[\\/]{2}/.test(target)) return outcome("unknown", "Network paths are not probed automatically.");
  // The file part is decoded and resolved exactly as the preview renders it.
  const hash = target.indexOf("#"), file = linkFilePath(target);
  let fragment = hash < 0 ? "" : target.slice(hash + 1);
  try { fragment = decodeURIComponent(fragment); } catch { /* kept as written */ }
  if (!file) return outcome("fragment", "Same-document reference; not an asset file.", null, fragment);
  if (/^[\\/]{2}/.test(file) || file.includes("\0")) return outcome("unknown", "Network or invalid path is not probed.");
  if (!documentPath && !isAbsolute(file)) return outcome("unknown", "Unsaved draft has no folder for relative references.");
  if (/^[a-z]:[^\\/]/i.test(file)) return outcome("unknown", "Drive-relative paths need explicit review.");
  return outcome("local", "", resolvePath(documentPath ? dirname(documentPath) : "", target), fragment);
}
