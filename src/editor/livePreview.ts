import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import katex from "katex";
import { renderFragment } from "../lib/markdown";
import { cachedMermaid, renderMermaid } from "../lib/mermaid";
import { toggleTaskAt } from "./commands";

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

let imageResolver: (src: string) => string = (s) => s;
export function setImageResolver(fn: (src: string) => string) {
  imageResolver = fn;
}

/** Forces block widgets (tables, math, diagrams) to re-render, e.g. on theme change. */
export const refreshBlocks = StateEffect.define<null>();

const hide = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();
const mark = (cls: string) => {
  let d = markCache.get(cls);
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
};
const lineDeco = (cls: string) => {
  let d = lineCache.get(cls);
  if (!d) lineCache.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};

/** Syntax is only revealed around the cursor while the editor is focused. */
const setFocused = StateEffect.define<boolean>();
const focusedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) return e.value;
    return value;
  },
});
export const syncFocus = (view: EditorView) => setFocused.of(view.hasFocus);

function touches(state: EditorState, from: number, to: number): boolean {
  if (state.field(focusedField, false) === false) return false;
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

function linesTouch(state: EditorState, from: number, to: number): boolean {
  return touches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to);
}

/** End offset of a leading YAML front-matter block, or -1. */
export function frontmatterEnd(state: EditorState): number {
  const doc = state.doc;
  if (doc.lines < 2 || doc.line(1).text !== "---") return -1;
  const max = Math.min(doc.lines, 200);
  for (let n = 2; n <= max; n++) {
    const t = doc.line(n).text;
    if (t === "---" || t === "...") return doc.line(n).to;
  }
  return -1;
}

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) out.push(c);
  return out;
}

function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let p = node.parent; p; p = p.parent) if (p.name === "BulletList" || p.name === "OrderedList") depth++;
  return depth;
}

/** Places the cursor at the widget's source and focuses the editor. */
function editAt(view: EditorView, dom: HTMLElement, lineOffset = 0) {
  let pos = view.posAtDOM(dom);
  const line = view.state.doc.lineAt(pos);
  if (lineOffset && line.number + lineOffset <= view.state.doc.lines) pos = view.state.doc.line(line.number + lineOffset).from;
  view.dispatch({ selection: { anchor: pos } });
  view.focus();
}

/* ------------------------------------------------------------------ */
/* Inline widgets                                                      */
/* ------------------------------------------------------------------ */

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: BulletWidget) {
    return o.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.dataset.depth = String(((this.depth - 1) % 3) + 1);
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

class NumberWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly hang: number,
  ) {
    super();
  }
  eq(o: NumberWidget) {
    return o.label === this.label && o.hang === this.hang;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-list-number cm-number-mark";
    el.style.width = `${this.hang}em`;
    el.textContent = this.label;
    return el;
  }
}

const listLineCache = new Map<string, Decoration>();
function listLineDeco(indent: number, hang: number) {
  const key = `${indent}|${hang}`;
  let d = listLineCache.get(key);
  if (!d) {
    d = Decoration.line({ class: "cm-li", attributes: { style: `--li-indent:${indent}em;--li-hang:${hang}em` } });
    listLineCache.set(key, d);
  }
  return d;
}

let lastTaskToggle = 0;

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-task-box" + (this.checked ? " is-checked" : "") + (Date.now() - lastTaskToggle < 400 ? " just-toggled" : "");
    el.setAttribute("role", "checkbox");
    el.setAttribute("aria-checked", String(this.checked));
    el.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.4l2.6 2.6L12 5.6"/></svg>`;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      lastTaskToggle = Date.now();
      toggleTaskAt(view, view.posAtDOM(el));
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-hr";
    return el;
  }
}
const ruleWidget = new RuleWidget();

const CALLOUT_LABELS: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  caution: "Caution",
};

class CalloutLabelWidget extends WidgetType {
  constructor(readonly kind: string) {
    super();
  }
  eq(o: CalloutLabelWidget) {
    return o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-callout-label";
    el.textContent = CALLOUT_LABELS[this.kind] ?? this.kind;
    return el;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-image";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    img.onload = () => view.requestMeasure();
    img.onerror = () => {
      wrap.classList.add("is-broken");
      wrap.textContent = this.alt ? `Image not found — ${this.alt}` : "Image not found";
      view.requestMeasure();
    };
    wrap.appendChild(img);
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: pos + 2 } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Inline decorations (visible ranges only)                            */
/* ------------------------------------------------------------------ */

function buildInline(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const out: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const fmEnd = frontmatterEnd(state);
  const blocks = state.field(blockField, false)?.ranges ?? [];
  const replacedBlock = (from: number) => {
    const b = blocks.find((r) => r.from === from);
    return !!b && !linesTouch(state, b.from, b.to);
  };

  if (fmEnd > 0) {
    for (let n = 1; doc.line(n).to <= fmEnd; n++) {
      out.push(lineDeco(n === 1 || doc.line(n).to === fmEnd ? "cm-frontmatter cm-frontmatter-fence" : "cm-frontmatter").range(doc.line(n).from));
      if (n === doc.lines) break;
    }
  }

  const eachLine = (from: number, to: number, fn: (lineFrom: number, n: number, first: number, last: number) => void) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) fn(doc.line(n).from, n, first, last);
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (ref) => {
        if (fmEnd > 0 && ref.from < fmEnd) return ref.name === "Document" ? undefined : false;
        const node = ref.node;
        const name = ref.name;

        if (name.startsWith("ATXHeading")) {
          const level = Number(name.slice(10)) || 1;
          const line = doc.lineAt(ref.from);
          out.push(lineDeco(`cm-heading cm-h${level}`).range(line.from));
          const active = touches(state, line.from, line.to);
          for (const m of children(node, "HeaderMark")) {
            if (active) {
              out.push(mark("cm-md-mark cm-heading-mark").range(m.from, m.to));
              continue;
            }
            let start = m.from;
            let end = m.to;
            if (m.from === line.from || doc.sliceString(line.from, m.from).trim() === "") {
              if (doc.sliceString(end, end + 1) === " ") end++;
            } else if (doc.sliceString(start - 1, start) === " ") start--;
            if (end > start) out.push(hide.range(start, end));
          }
          return;
        }

        switch (name) {
          case "SetextHeading1":
          case "SetextHeading2": {
            const level = name.endsWith("1") ? 1 : 2;
            eachLine(ref.from, ref.to, (lf, n, _first, last) => {
              out.push(lineDeco(n === last ? "cm-setext-mark" : `cm-heading cm-h${level}`).range(lf));
            });
            return;
          }
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough":
          case "InlineCode": {
            if (name === "InlineCode") out.push(mark("cm-inline-code").range(ref.from, ref.to));
            const markName = name === "Strikethrough" ? "StrikethroughMark" : name === "InlineCode" ? "CodeMark" : "EmphasisMark";
            const active = touches(state, ref.from, ref.to);
            for (const m of children(node, markName)) out.push((active ? mark("cm-md-mark") : hide).range(m.from, m.to));
            return;
          }
          case "Link":
          case "Autolink": {
            if (doc.sliceString(ref.from, ref.from + 2) === "[!") return false;
            const marks = children(node, "LinkMark");
            const active = touches(state, ref.from, ref.to);
            if (name === "Autolink") {
              const url = node.getChild("URL");
              if (url) out.push(mark("cm-link").range(url.from, url.to));
              if (!active) for (const m of marks) out.push(hide.range(m.from, m.to));
              return false;
            }
            if (marks.length >= 2 && marks[1].from > marks[0].to) {
              out.push(mark("cm-link").range(marks[0].to, marks[1].from));
              if (!active) {
                out.push(hide.range(marks[0].from, marks[0].to));
                out.push(hide.range(marks[1].from, ref.to));
              } else {
                out.push(mark("cm-md-mark").range(marks[0].from, marks[0].to));
                out.push(mark("cm-md-mark cm-link-dest").range(marks[1].from, ref.to));
              }
            }
            return;
          }
          case "Image": {
            const active = touches(state, ref.from, ref.to);
            const url = node.getChild("URL");
            const marks = children(node, "LinkMark");
            const sameLine = doc.lineAt(ref.from).number === doc.lineAt(ref.to).number;
            if (!active && url && sameLine && marks.length >= 2) {
              const src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
              const alt = doc.sliceString(marks[0].to, marks[1].from);
              out.push(Decoration.replace({ widget: new ImageWidget(imageResolver(src), alt) }).range(ref.from, ref.to));
            } else {
              out.push(mark("cm-image-src").range(ref.from, ref.to));
            }
            return false;
          }
          case "URL": {
            const parent = node.parent?.name;
            if (parent !== "Link" && parent !== "Image" && parent !== "Autolink" && parent !== "LinkReference") {
              out.push(mark("cm-link cm-bare-url").range(ref.from, ref.to));
            }
            return;
          }
          case "Blockquote": {
            if (node.parent?.name === "Blockquote") return;
            const firstLine = doc.lineAt(ref.from);
            const callout = /^\s*>\s*\[!(note|tip|important|warning|caution)\]/i.exec(firstLine.text);
            const kind = callout?.[1].toLowerCase();
            eachLine(ref.from, ref.to, (lf, n, first, last) => {
              let cls = kind ? `cm-quote cm-callout cm-callout-${kind}` : "cm-quote";
              if (n === first) cls += " cm-quote-first";
              if (n === last) cls += " cm-quote-last";
              out.push(lineDeco(cls).range(lf));
            });
            if (kind) {
              const start = firstLine.from + firstLine.text.indexOf("[");
              const end = firstLine.from + firstLine.text.indexOf("]") + 1;
              if (!touches(state, firstLine.from, firstLine.to)) {
                const rest = doc.sliceString(end, firstLine.to).trim();
                if (rest) {
                  let e = end;
                  if (doc.sliceString(e, e + 1) === " ") e++;
                  out.push(hide.range(start, e));
                  out.push(mark("cm-callout-title").range(e, firstLine.to));
                } else {
                  out.push(Decoration.replace({ widget: new CalloutLabelWidget(kind) }).range(start, end));
                }
              } else {
                out.push(mark("cm-md-mark").range(start, end));
              }
            }
            return;
          }
          case "QuoteMark": {
            const line = doc.lineAt(ref.from);
            if (!touches(state, line.from, line.to)) {
              let end = ref.to;
              if (doc.sliceString(end, end + 1) === " ") end++;
              out.push(hide.range(ref.from, end));
            } else out.push(mark("cm-md-mark").range(ref.from, ref.to));
            return;
          }
          case "ListMark": {
            // Rendered markers replace the indentation + marker with a fixed-width widget so wrapped
            // lines can hang exactly under the text (padding-left + negative text-indent).
            const list = node.parent?.parent;
            const line = doc.lineAt(ref.from);
            const bare = /^[ \t]*$/.test(doc.sliceString(line.from, ref.from));
            const start = bare ? line.from : ref.from;
            const spaceAfter = (p: number) => (doc.sliceString(p, p + 1) === " " ? p + 1 : p);
            const indent = bare ? (listDepth(node) - 1) * 1.5 : 0;
            const hanging = (hang: number) => {
              if (bare) out.push(listLineDeco(indent, hang).range(line.from));
            };
            const task = node.nextSibling?.name === "Task" ? node.nextSibling.firstChild : null;
            if (task?.name === "TaskMarker") {
              const end = spaceAfter(task.to);
              const checked = /x/i.test(doc.sliceString(task.from, task.to));
              if (!touches(state, start, end)) {
                out.push(hide.range(start, task.from));
                out.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(task.from, end));
                hanging(1.42);
              } else {
                out.push(mark("cm-md-mark").range(ref.from, ref.to));
                out.push(mark("cm-md-mark").range(task.from, task.to));
              }
              return;
            }
            const end = spaceAfter(ref.to);
            if (touches(state, start, end)) {
              out.push(mark(list?.name === "BulletList" ? "cm-list-mark" : "cm-list-number").range(ref.from, ref.to));
              return;
            }
            if (list?.name === "BulletList") {
              out.push(Decoration.replace({ widget: new BulletWidget(listDepth(node)) }).range(start, end));
              hanging(1.1);
            } else {
              const label = doc.sliceString(ref.from, ref.to);
              const hang = Math.max(1.5, label.length * 0.55 + 0.4);
              out.push(Decoration.replace({ widget: new NumberWidget(label, hang) }).range(start, end));
              hanging(hang);
            }
            return;
          }
          case "TaskMarker": {
            if (/x/i.test(doc.sliceString(ref.from, ref.to))) out.push(lineDeco("cm-task-done").range(doc.lineAt(ref.from).from));
            return;
          }
          case "HorizontalRule": {
            const line = doc.lineAt(ref.from);
            out.push(lineDeco("cm-hr-line").range(line.from));
            if (!touches(state, line.from, line.to)) out.push(Decoration.replace({ widget: ruleWidget }).range(ref.from, ref.to));
            else out.push(mark("cm-md-mark").range(ref.from, ref.to));
            return false;
          }
          case "FencedCode": {
            const info = node.getChild("CodeInfo");
            const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
            if (lang === "mermaid" && replacedBlock(ref.from)) return false;
            // Outside the block the fences collapse to a quiet language label.
            const quiet = !linesTouch(state, ref.from, ref.to) ? " cm-code-quiet" : "";
            eachLine(ref.from, ref.to, (lf, n, first, last) => {
              let cls = "cm-code";
              if (n === first) cls += " cm-code-first cm-code-fence" + quiet;
              if (n === last && last !== first && /^\s*(`{3,}|~{3,})\s*$/.test(doc.line(n).text)) cls += " cm-code-last cm-code-fence" + quiet;
              else if (n === last) cls += " cm-code-last";
              out.push(lineDeco(cls).range(lf));
            });
            for (const m of children(node, "CodeMark")) out.push((quiet ? hide : mark("cm-code-mark")).range(m.from, m.to));
            if (info) out.push(mark("cm-code-info").range(info.from, info.to));
            return false;
          }
          case "CodeBlock": {
            eachLine(ref.from, ref.to, (lf, n, first, last) => {
              out.push(lineDeco(`cm-code cm-code-indented${n === first ? " cm-code-first" : ""}${n === last ? " cm-code-last" : ""}`).range(lf));
            });
            return false;
          }
          case "Table": {
            if (replacedBlock(ref.from)) return false;
            eachLine(ref.from, ref.to, (lf, n, first) => {
              out.push(lineDeco(n === first ? "cm-table-src cm-table-head" : "cm-table-src").range(lf));
            });
            return false;
          }
          case "Paragraph": {
            if (replacedBlock(ref.from)) return false;
            if (blocks.some((b) => b.from === ref.from && b.kind === "math")) {
              eachLine(ref.from, ref.to, (lf) => out.push(lineDeco("cm-math-src").range(lf)));
              return false;
            }
            return;
          }
          case "HTMLTag":
          case "HTMLBlock":
          case "CommentBlock":
          case "Comment":
            out.push(mark("cm-html").range(ref.from, ref.to));
            return false;
          case "Escape":
            out.push(mark("cm-md-mark").range(ref.from, ref.from + 1));
            return;
          case "LinkReference":
            out.push(mark("cm-link-ref").range(ref.from, ref.to));
            return false;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.state) !== syntaxTree(u.startState) ||
        u.transactions.some((t) => t.effects.some((e) => e.is(refreshBlocks) || e.is(setFocused)))
      ) {
        this.decorations = buildInline(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

/* ------------------------------------------------------------------ */
/* Block widgets: tables, display math, Mermaid diagrams               */
/* ------------------------------------------------------------------ */

interface BlockRange {
  kind: "table" | "math" | "mermaid";
  from: number;
  to: number;
  source: string;
}

abstract class BlockWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly lines: number,
  ) {
    super();
  }
  protected shell(view: EditorView, cls: string, lineOffset: number): HTMLElement {
    const el = document.createElement("div");
    el.className = `cm-block-widget ${cls}`;
    el.addEventListener("mousedown", (e) => {
      if ((e.target as HTMLElement).closest("a")) return;
      e.preventDefault();
      editAt(view, el, lineOffset);
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class TableWidget extends BlockWidget {
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  get estimatedHeight() {
    return this.lines * 38;
  }
  toDOM(view: EditorView) {
    const el = this.shell(view, "cm-table-widget", 0);
    el.innerHTML = `<div class="cm-table-scroll prose">${renderFragment(this.source)}</div>`;
    return el;
  }
}

class MathWidget extends BlockWidget {
  eq(o: MathWidget) {
    return o.source === this.source;
  }
  get estimatedHeight() {
    return 72;
  }
  toDOM(view: EditorView) {
    const el = this.shell(view, "cm-math-widget", 1);
    try {
      el.innerHTML = katex.renderToString(this.source, { displayMode: true, throwOnError: false });
    } catch {
      el.textContent = this.source;
    }
    return el;
  }
}

class MermaidWidget extends BlockWidget {
  constructor(
    source: string,
    lines: number,
    readonly dark: boolean,
  ) {
    super(source, lines);
  }
  eq(o: MermaidWidget) {
    return o.source === this.source && o.dark === this.dark;
  }
  get estimatedHeight() {
    return 220;
  }
  toDOM(view: EditorView) {
    const el = this.shell(view, "cm-mermaid-widget", 1);
    const fill = (r: { svg?: string; error?: string }) => {
      if (r.svg) el.innerHTML = r.svg;
      else {
        el.classList.add("is-error");
        el.textContent = r.error ?? "Could not render diagram";
      }
      view.requestMeasure();
    };
    const hit = cachedMermaid(this.source, this.dark);
    if (hit) fill(hit);
    else {
      el.classList.add("is-loading");
      el.textContent = "Rendering diagram…";
      renderMermaid(this.source, this.dark).then((r) => {
        el.classList.remove("is-loading");
        fill(r);
      });
    }
    return el;
  }
}

function collectBlocks(state: EditorState): BlockRange[] {
  const out: BlockRange[] = [];
  const doc = state.doc;
  const fmEnd = frontmatterEnd(state);
  for (let node = syntaxTree(state).topNode.firstChild; node; node = node.nextSibling) {
    if (node.from < fmEnd) continue;
    if (node.name === "Table") {
      out.push({ kind: "table", from: node.from, to: node.to, source: doc.sliceString(node.from, node.to) });
    } else if (node.name === "FencedCode") {
      const info = node.getChild("CodeInfo");
      if (!info || doc.sliceString(info.from, info.to).trim().toLowerCase() !== "mermaid") continue;
      if (children(node, "CodeMark").length < 2) continue;
      const text = node.getChild("CodeText");
      const source = text ? doc.sliceString(text.from, text.to) : "";
      if (source.trim()) out.push({ kind: "mermaid", from: node.from, to: node.to, source });
    } else if (node.name === "Paragraph") {
      const text = doc.sliceString(node.from, node.to);
      const m = /^\$\$([\s\S]+?)\$\$\s*$/.exec(text);
      if (m && m[1].trim()) out.push({ kind: "math", from: node.from, to: node.to, source: m[1].trim() });
    }
  }
  return out;
}

function decorateBlocks(state: EditorState, ranges: BlockRange[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const dark = document.documentElement.dataset.theme === "dark";
  for (const r of ranges) {
    const from = state.doc.lineAt(r.from).from;
    const to = state.doc.lineAt(r.to).to;
    if (touches(state, from, to)) continue;
    const lines = state.doc.lineAt(to).number - state.doc.lineAt(from).number + 1;
    const widget =
      r.kind === "table"
        ? new TableWidget(r.source, lines)
        : r.kind === "math"
          ? new MathWidget(r.source, lines)
          : new MermaidWidget(r.source, lines, dark);
    builder.add(from, to, Decoration.replace({ widget, block: true }));
  }
  return builder.finish();
}

interface BlockFieldValue {
  ranges: BlockRange[];
  tree: Tree;
  decos: DecorationSet;
}

const blockField = StateField.define<BlockFieldValue>({
  create(state) {
    const ranges = collectBlocks(state);
    return { ranges, tree: syntaxTree(state), decos: decorateBlocks(state, ranges) };
  },
  update(value, tr) {
    const tree = syntaxTree(tr.state);
    const refresh = tr.effects.some((e) => e.is(refreshBlocks) || e.is(setFocused));
    if (tr.docChanged || tree !== value.tree) {
      const ranges = collectBlocks(tr.state);
      return { ranges, tree, decos: decorateBlocks(tr.state, ranges) };
    }
    if (tr.selection || refresh) return { ...value, decos: decorateBlocks(tr.state, value.ranges) };
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decos),
});

/* ------------------------------------------------------------------ */

export function livePreview(): Extension {
  return [
    focusedField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
    blockField,
    inlinePlugin,
    EditorView.editorAttributes.of({ class: "cm-live" }),
  ];
}

/** Lightweight styling used when live preview is off (pure source mode). */
const sourcePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const out: Range<Decoration>[] = [];
      const doc = view.state.doc;
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(view.state).iterate({
          from,
          to,
          enter: (ref) => {
            if (ref.name === "FencedCode" || ref.name === "CodeBlock") {
              const first = doc.lineAt(ref.from).number;
              const last = doc.lineAt(ref.to).number;
              for (let n = first; n <= last; n++) {
                out.push(lineDeco(`cm-code${n === first ? " cm-code-first" : ""}${n === last ? " cm-code-last" : ""}`).range(doc.line(n).from));
              }
              return false;
            }
            if (ref.name === "InlineCode") out.push(mark("cm-inline-code").range(ref.from, ref.to));
            return;
          },
        });
      }
      return Decoration.set(out, true);
    }
  },
  { decorations: (v) => v.decorations },
);

export function sourceMode(): Extension {
  return [sourcePlugin, EditorView.editorAttributes.of({ class: "cm-source" })];
}
