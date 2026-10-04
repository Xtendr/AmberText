import { completionStatus } from "@codemirror/autocomplete";
import { EditorSelection, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { enclosingNode } from "./commands";

/* ------------------------------------------------------------------ */
/* Typing a Markdown pair character with text selected wraps it         */
/* ------------------------------------------------------------------ */

const PAIRS: Record<string, string> = {
  "*": "*",
  _: "_",
  "`": "`",
  "~": "~",
  '"': '"',
  "“": "”",
  "(": ")",
  "[": "]",
};

const wrapSelection = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = PAIRS[text];
  const { state } = view;
  if (!close || state.selection.ranges.every((r) => r.empty)) return false;
  if (state.selection.ranges.some((r) => !r.empty && state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number)) return false;
  view.dispatch(
    state.changeByRange((r) => {
      if (r.empty) return { changes: { from: r.from, insert: text }, range: EditorSelection.cursor(r.from + text.length) };
      return {
        changes: [
          { from: r.from, insert: text },
          { from: r.to, insert: close },
        ],
        range: EditorSelection.range(r.anchor + text.length, r.head + text.length),
      };
    }),
    { userEvent: "input.type", scrollIntoView: true },
  );
  return true;
});

/* ------------------------------------------------------------------ */
/* Tables: Tab between cells, auto-align, Enter adds a row              */
/* ------------------------------------------------------------------ */

type Align = "left" | "center" | "right" | null;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let tick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (c === "`") {
      tick = !tick;
      cur += c;
    } else if (c === "|" && !tick) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const isDelimiter = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

/** Visual width, counting wide (CJK/emoji) characters as two columns. */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, w: number, align: Align) {
  const gap = Math.max(0, w - width(s));
  if (align === "right") return " ".repeat(gap) + s;
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
}

interface Table {
  rows: string[][];
  delimiter: number;
  aligns: Align[];
  cols: number;
}

function parseTable(lines: string[]): Table | null {
  const rows = lines.map(splitRow);
  const delimiter = rows.findIndex(isDelimiter);
  if (delimiter !== 1) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push("");
  return { rows, delimiter, aligns: rows[delimiter].map(alignOf), cols };
}

function formatTable(t: Table): string[] {
  const widths = Array.from({ length: t.cols }, (_, c) => Math.max(3, ...t.rows.map((r, i) => (i === t.delimiter ? 0 : width(r[c])))));
  return t.rows.map((r, i) => {
    if (i === t.delimiter) {
      return (
        "| " +
        widths
          .map((w, c) => {
            const a = t.aligns[c];
            const dashes = "-".repeat(Math.max(1, w - (a === "center" ? 2 : a ? 1 : 0)));
            return a === "center" ? `:${dashes}:` : a === "right" ? `${dashes}:` : a === "left" ? `:${dashes}` : dashes;
          })
          .join(" | ") +
        " |"
      );
    }
    return "| " + r.map((cell, c) => pad(cell, widths[c], t.aligns[c])).join(" | ") + " |";
  });
}

/** Offsets of each cell's content start within a formatted row. */
function cellStarts(row: string): number[] {
  const out: number[] = [];
  let tick = false;
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    if (c === "\\") i++;
    else if (c === "`") tick = !tick;
    else if (c === "|" && !tick && i < row.trimEnd().length - 1) out.push(i + 2);
  }
  return out;
}

function cellIndex(lineText: string, col: number): number {
  let n = -1;
  let tick = false;
  const lead = lineText.length - lineText.trimStart().length;
  if (!lineText.trimStart().startsWith("|")) n = 0;
  for (let i = lead; i < col && i < lineText.length; i++) {
    const c = lineText[i];
    if (c === "\\") i++;
    else if (c === "`") tick = !tick;
    else if (c === "|" && !tick) n++;
  }
  return Math.max(0, n);
}

interface TableAt {
  from: number;
  to: number;
  firstLine: number;
  table: Table;
  row: number;
  cell: number;
}

function tableAt(view: EditorView): TableAt | null {
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length > 1) return null;
  const line = state.doc.lineAt(sel.head);
  // Line-based rather than syntax-tree based: the tree can lag behind fast typing.
  const isRow = (text: string) => /^\s{0,3}\S/.test(text) && text.includes("|");
  if (!isRow(line.text) || enclosingNode(state, sel.head, "FencedCode")) return null;
  let firstN = line.number;
  let lastN = line.number;
  while (firstN > 1 && isRow(state.doc.line(firstN - 1).text)) firstN--;
  while (lastN < state.doc.lines && isRow(state.doc.line(lastN + 1).text)) lastN++;
  const first = state.doc.line(firstN);
  const last = state.doc.line(lastN);
  const lines: string[] = [];
  for (let n = firstN; n <= lastN; n++) lines.push(state.doc.line(n).text);
  const table = parseTable(lines);
  if (!table) return null;
  return { from: first.from, to: last.to, firstLine: first.number, table, row: line.number - first.number, cell: cellIndex(line.text, sel.head - line.from) };
}

function moveToCell(view: EditorView, at: TableAt, formatted: string[], row: number, cell: number) {
  let offset = 0;
  for (let i = 0; i < row; i++) offset += formatted[i].length + 1;
  const starts = cellStarts(formatted[row]);
  const start = starts[Math.min(cell, starts.length - 1)] ?? 2;
  const cellText = at.table.rows[row]?.[cell] ?? "";
  const anchor = at.from + offset + start;
  const insert = formatted.join("\n");
  const head = anchor + (at.table.aligns[cell] ? 0 : cellText.length);
  view.dispatch({
    changes: view.state.sliceDoc(at.from, at.to) === insert ? undefined : { from: at.from, to: at.to, insert },
    selection: EditorSelection.range(anchor, Math.max(anchor, head)),
    scrollIntoView: true,
    userEvent: "input.table",
  });
}

function nextCell(view: EditorView, dir: 1 | -1): boolean {
  const at = tableAt(view);
  if (!at) return false;
  const { table } = at;
  let row = at.row;
  let cell = at.cell + dir;
  if (cell >= table.cols) {
    cell = 0;
    row++;
    if (row === table.delimiter) row++;
  } else if (cell < 0) {
    cell = table.cols - 1;
    row--;
    if (row === table.delimiter) row--;
  }
  if (row < 0) return true;
  if (row >= table.rows.length) table.rows.push(Array(table.cols).fill(""));
  moveToCell(view, at, formatTable(table), row, cell);
  return true;
}

function tableEnter(view: EditorView): boolean {
  const at = tableAt(view);
  if (!at || !view.state.selection.main.empty) return false;
  const { table } = at;
  const isLast = at.row === table.rows.length - 1;
  if (isLast && at.row > table.delimiter && table.rows[at.row].every((c) => !c)) {
    // Enter on an empty last row leaves the table.
    table.rows.pop();
    const formatted = formatTable(table).join("\n");
    view.dispatch({
      changes: { from: at.from, to: at.to, insert: formatted + "\n\n" },
      selection: { anchor: at.from + formatted.length + 2 },
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  const row = at.row <= table.delimiter ? table.delimiter + 1 : at.row + 1;
  table.rows.splice(row, 0, Array(table.cols).fill(""));
  moveToCell(view, at, formatTable(table), row, 0);
  return true;
}

const unlessCompleting = (fn: (v: EditorView) => boolean) => (v: EditorView) => (completionStatus(v.state) === "active" ? false : fn(v));

const tableKeys: KeyBinding[] = [
  { key: "Tab", run: unlessCompleting((v) => nextCell(v, 1)) },
  { key: "Shift-Tab", run: unlessCompleting((v) => nextCell(v, -1)) },
  { key: "Enter", run: unlessCompleting(tableEnter) },
];

export function smartEditing(): Extension {
  return [wrapSelection, Prec.highest(keymap.of(tableKeys))];
}
