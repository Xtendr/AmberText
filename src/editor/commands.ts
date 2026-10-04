import { EditorSelection, type ChangeSpec, type EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";

const INLINE_NODES: Record<string, string> = {
  "**": "StrongEmphasis",
  _: "Emphasis",
  "~~": "Strikethrough",
  "`": "InlineCode",
};

/** Is the position inside a node of the given type? Returns the node range. */
export function enclosingNode(state: EditorState, pos: number, name: string): { from: number; to: number } | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
    while (node) {
      if (node.name === name) return { from: node.from, to: node.to };
      node = node.parent;
    }
  }
  return null;
}

export function isInlineActive(state: EditorState, marker: string): boolean {
  const name = INLINE_NODES[marker];
  if (!name) return false;
  const { from, to } = state.selection.main;
  const node = enclosingNode(state, from, name);
  return !!node && node.to >= to;
}

export function toggleInline(view: EditorView, marker: string): boolean {
  const { state } = view;
  const m = marker.length;
  const nodeName = INLINE_NODES[marker];
  const tr = state.changeByRange((range) => {
    // Cursor or selection inside an existing span of this style: unwrap it.
    if (nodeName) {
      const node = enclosingNode(state, range.from, nodeName);
      if (node && node.to >= range.to) {
        const open = state.sliceDoc(node.from, node.from + m);
        const close = state.sliceDoc(node.to - m, node.to);
        const om = open === marker || (marker === "_" && open === "*") ? m : 0;
        const cm = close === marker || (marker === "_" && close === "*") ? m : 0;
        if (om && cm) {
          return {
            changes: [
              { from: node.from, to: node.from + om },
              { from: node.to - cm, to: node.to },
            ],
            range: EditorSelection.range(
              Math.max(node.from, range.anchor - om),
              Math.min(node.to - om - cm, range.head - om),
            ),
          };
        }
      }
    }
    if (state.sliceDoc(range.from - m, range.from) === marker && state.sliceDoc(range.to, range.to + m) === marker) {
      return {
        changes: [
          { from: range.from - m, to: range.from },
          { from: range.to, to: range.to + m },
        ],
        range: EditorSelection.range(range.from - m, range.to - m),
      };
    }
    if (range.empty) {
      const word = state.wordAt(range.head);
      if (word) {
        return {
          changes: [
            { from: word.from, insert: marker },
            { from: word.to, insert: marker },
          ],
          range: EditorSelection.cursor(range.head + m),
        };
      }
      return {
        changes: { from: range.from, insert: marker + marker },
        range: EditorSelection.cursor(range.from + m),
      };
    }
    // Don't swallow surrounding whitespace into the markers.
    const text = state.sliceDoc(range.from, range.to);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    const from = range.from + lead;
    const to = range.to - trail;
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + m, to + m),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.format" }));
  view.focus();
  return true;
}

function selectedLines(state: EditorState) {
  const lines = new Map<number, { from: number; to: number; text: string; number: number }>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    const last = state.doc.lineAt(r.to).number;
    for (let n = first; n <= last; n++) {
      const l = state.doc.line(n);
      lines.set(n, { from: l.from, to: l.to, text: l.text, number: n });
    }
  }
  return [...lines.values()].sort((a, b) => a.number - b.number);
}

export function headingLevel(state: EditorState): number {
  const line = state.doc.lineAt(state.selection.main.head);
  const m = /^(#{1,6})\s/.exec(line.text);
  return m ? m[1].length : 0;
}

export function setHeading(view: EditorView, level: number): boolean {
  const { state } = view;
  const lines = selectedLines(state);
  const allSame = lines.every((l) => (/^(#{1,6})\s/.exec(l.text)?.[1].length ?? 0) === level);
  const changes: ChangeSpec[] = lines.map((l) => {
    const m = /^(#{1,6})\s+/.exec(l.text);
    const prefix = level && !allSame ? "#".repeat(level) + " " : "";
    return { from: l.from, to: l.from + (m ? m[0].length : 0), insert: prefix };
  });
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

const LIST_PREFIX = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;

export type LineKind = "quote" | "bullet" | "ordered" | "task";

function prefixFor(kind: LineKind, index: number) {
  switch (kind) {
    case "quote":
      return "> ";
    case "bullet":
      return "- ";
    case "ordered":
      return `${index + 1}. `;
    case "task":
      return "- [ ] ";
  }
}

function hasKind(text: string, kind: LineKind) {
  switch (kind) {
    case "quote":
      return /^\s*>/.test(text);
    case "bullet":
      return /^\s*[-*+]\s+(?!\[[ xX]\])/.test(text);
    case "ordered":
      return /^\s*\d+[.)]\s+/.test(text);
    case "task":
      return /^\s*[-*+]\s+\[[ xX]\]/.test(text);
  }
}

export function toggleLinePrefix(view: EditorView, kind: LineKind): boolean {
  const { state } = view;
  const lines = selectedLines(state).filter((l, _, all) => all.length === 1 || l.text.trim());
  const all = lines.every((l) => hasKind(l.text, kind));
  const changes: ChangeSpec[] = lines.map((l, i) => {
    const m = LIST_PREFIX.exec(l.text);
    const indent = m?.[1] ?? /^\s*/.exec(l.text)![0];
    const end = l.from + (m ? m[0].length : indent.length);
    return { from: l.from, to: end, insert: all ? indent : indent + prefixFor(kind, i) };
  });
  view.dispatch({ changes, userEvent: "input.format", scrollIntoView: true });
  view.focus();
  return true;
}

export function insertLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const text = state.sliceDoc(range.from, range.to);
  if (/^https?:\/\/\S+$/.test(text)) {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: `[](${text})` },
      selection: { anchor: range.from + 1 },
      userEvent: "input.format",
    });
  } else if (text) {
    const insert = `[${text}](url)`;
    const urlStart = range.from + text.length + 3;
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: urlStart, head: urlStart + 3 },
      userEvent: "input.format",
    });
  } else {
    view.dispatch({
      changes: { from: range.from, insert: "[link text](url)" },
      selection: { anchor: range.from + 1, head: range.from + 10 },
      userEvent: "input.format",
    });
  }
  view.focus();
  return true;
}

/**
 * Inserts a block at the cursor on its own line(s). `‸` in the template marks
 * where the cursor lands.
 */
export function insertBlock(view: EditorView, template: string, from?: number, to?: number): boolean {
  const { state } = view;
  const start = from ?? state.selection.main.from;
  const end = to ?? state.selection.main.to;
  const line = state.doc.lineAt(start);
  const before = state.sliceDoc(line.from, start);
  const after = state.sliceDoc(end, state.doc.lineAt(end).to);
  let text = template;
  if (before.trim()) text = "\n\n" + text;
  else if (line.number > 1 && /^-{3,}/.test(template) && state.doc.line(line.number - 1).text.trim()) text = "\n" + text;
  if (after.trim()) text = text + "\n\n";
  const caret = text.indexOf("‸");
  const insert = text.replace("‸", "");
  view.dispatch({
    changes: { from: start, to: end, insert },
    selection: { anchor: start + (caret >= 0 ? caret : insert.length) },
    userEvent: "input.insert",
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function toggleTaskAt(view: EditorView, pos: number): boolean {
  const text = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return false;
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " },
    userEvent: "input.toggle",
  });
  return true;
}

/** Toggles the task checkbox on a 0-based source line (used by the preview). */
export function toggleTaskOnLine(view: EditorView, line0: number): boolean {
  if (line0 + 1 > view.state.doc.lines) return false;
  const line = view.state.doc.line(line0 + 1);
  const m = /^(\s*[-*+]\s+)\[[ xX]\]/.exec(line.text);
  if (!m) return false;
  return toggleTaskAt(view, line.from + m[1].length);
}

export const formattingKeymap: KeyBinding[] = [
  { key: "Mod-b", run: (v) => toggleInline(v, "**") },
  { key: "Mod-i", run: (v) => toggleInline(v, "_") },
  { key: "Mod-Shift-x", run: (v) => toggleInline(v, "~~") },
  { key: "Mod-`", run: (v) => toggleInline(v, "`") },
  { key: "Mod-e", run: (v) => toggleInline(v, "`") },
  { key: "Mod-k", run: insertLink },
  { key: "Mod-Alt-0", run: (v) => setHeading(v, 0) },
  { key: "Mod-Alt-1", run: (v) => setHeading(v, 1) },
  { key: "Mod-Alt-2", run: (v) => setHeading(v, 2) },
  { key: "Mod-Alt-3", run: (v) => setHeading(v, 3) },
  { key: "Mod-Alt-4", run: (v) => setHeading(v, 4) },
  { key: "Mod-Alt-5", run: (v) => setHeading(v, 5) },
  { key: "Mod-Alt-6", run: (v) => setHeading(v, 6) },
  { key: "Mod-Shift-7", run: (v) => toggleLinePrefix(v, "ordered") },
  { key: "Mod-Shift-8", run: (v) => toggleLinePrefix(v, "bullet") },
  { key: "Mod-Shift-9", run: (v) => toggleLinePrefix(v, "task") },
  { key: "Mod-Shift-.", run: (v) => toggleLinePrefix(v, "quote") },
];
