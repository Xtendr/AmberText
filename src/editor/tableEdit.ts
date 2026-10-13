import type { EditorView } from "@codemirror/view";
import { renderFragment } from "../lib/markdown";
import { formatTable, parseTable, type Table } from "./smartEdit";

/*
 * Editable tables for pure Styled view. Click a cell and type: the cell shows its own Markdown while
 * you're in it, and every keystroke is written straight into the table source, re-aligned. The widget
 * keeps its DOM while a cell is being edited (see TableWidget.updateDOM), so focus is never lost.
 */

interface Editing {
  view: EditorView;
  el: HTMLElement;
  cell: HTMLElement;
  row: number;
  col: number;
}

let editing: Editing | null = null;

export const isEditingTable = (el: HTMLElement) => editing?.el === el;

/** Table rows as written: 0 is the header, 1 the delimiter, then the body. DOM rows skip the delimiter. */
const sourceRow = (domRow: number) => (domRow === 0 ? 0 : domRow + 1);

export function renderTable(el: HTMLElement, source: string) {
  el.dataset.source = source;
  el.innerHTML = `<div class="cm-table-scroll prose">${renderFragment(source)}</div>`;
  el.querySelectorAll("tr").forEach((tr, r) => {
    [...tr.children].forEach((cell, c) => {
      (cell as HTMLElement).dataset.row = String(r);
      (cell as HTMLElement).dataset.col = String(c);
    });
  });
}

export function makeTableEditable(view: EditorView, el: HTMLElement) {
  el.classList.add("is-editable");
  el.contentEditable = "false"; // only the cell being edited is typeable, not the whole table
  el.addEventListener("mousedown", (e) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>("th, td");
    if (cell?.classList.contains("is-editing")) return; // already typing here: let the browser move the caret
    e.preventDefault();
    if ((e.target as HTMLElement).closest("a")) return;
    if (!cell) {
      // The space around the table (its padding) belongs to the table's box: send the click to the
      // line above or below instead of swallowing it.
      const box = el.querySelector("table")?.getBoundingClientRect();
      placeCursorBeside(view, el, box && e.clientY < box.top ? -1 : 1);
      return;
    }
    const offset = caretOffsetAt(e.clientX, e.clientY, cell);
    startEdit(view, el, Number(cell.dataset.row), Number(cell.dataset.col), offset);
  });
}

function caretOffsetAt(x: number, y: number, cell: HTMLElement): number | null {
  const range = document.caretRangeFromPoint?.(x, y);
  if (!range || !cell.contains(range.startContainer)) return null;
  const before = document.createRange();
  before.setStart(cell, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function tableAt(el: HTMLElement): Table | null {
  return parseTable((el.dataset.source ?? "").split("\n"));
}

function startEdit(view: EditorView, el: HTMLElement, row: number, col: number, offset: number | null = null) {
  if (editing && (editing.el !== el || editing.row !== row || editing.col !== col)) stopEdit();
  const cell = el.querySelector<HTMLElement>(`[data-row="${row}"][data-col="${col}"]`);
  const table = tableAt(el);
  if (!cell || !table) return;
  const raw = table.rows[sourceRow(row)]?.[col] ?? "";
  // A plain cell reads the same styled or raw, so the caret can stay exactly where you clicked.
  const keepOffset = offset != null && cell.textContent === raw;
  cell.textContent = raw;
  cell.contentEditable = "plaintext-only";
  cell.classList.add("is-editing");
  editing = { view, el, cell, row, col };
  cell.focus();
  placeCaret(cell, keepOffset ? offset! : raw.length);
  cell.addEventListener("input", onInput);
  cell.addEventListener("keydown", onKey);
  cell.addEventListener("focusout", onBlur);
}

function placeCaret(cell: HTMLElement, offset: number) {
  const text = cell.firstChild;
  const range = document.createRange();
  if (text) range.setStart(text, Math.min(offset, text.textContent?.length ?? 0));
  else range.setStart(cell, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function caretOffset(cell: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return 0;
  const r = document.createRange();
  r.setStart(cell, 0);
  r.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return r.toString().length;
}

/** Cell text as Markdown: one line, unescaped pipes escaped so they don't split the cell. */
function cellMarkdown(cell: HTMLElement): string {
  return (cell.textContent ?? "").replace(/\s*\n\s*/g, " ").trim().replace(/(^|[^\\])\|/g, "$1\\|").replace(/(^|[^\\])\|/g, "$1\\|");
}

/** Writes the table back into the document, changing only the part that differs. */
function writeTable(e: Editing, change: (t: Table) => void): boolean {
  const { view, el } = e;
  const source = el.dataset.source ?? "";
  const table = tableAt(el);
  if (!table) return false;
  const from = view.posAtDOM(el);
  if (view.state.sliceDoc(from, from + source.length) !== source) return false;
  change(table);
  const next = formatTable(table).join("\n");
  if (next === source) return true;
  let start = 0;
  while (start < source.length && start < next.length && source[start] === next[start]) start++;
  let end = 0;
  while (end < source.length - start && end < next.length - start && source[source.length - 1 - end] === next[next.length - 1 - end]) end++;
  el.dataset.source = next;
  view.dispatch({ changes: { from: from + start, to: from + source.length - end, insert: next.slice(start, next.length - end) }, userEvent: "input.type" });
  return true;
}

function onInput() {
  if (!editing) return;
  const e = editing;
  writeTable(e, (t) => {
    t.rows[sourceRow(e.row)][e.col] = cellMarkdown(e.cell);
  });
}

function stopEdit() {
  const e = editing;
  if (!e) return;
  editing = null;
  e.cell.removeEventListener("input", onInput);
  e.cell.removeEventListener("keydown", onKey);
  e.cell.removeEventListener("focusout", onBlur);
  e.cell.contentEditable = "false";
  // Show the finished table styled again, with the latest text and column widths.
  renderTable(e.el, e.el.dataset.source ?? "");
}

function onBlur(ev: FocusEvent) {
  if (!editing || editing.cell.contains(ev.relatedTarget as Node)) return;
  stopEdit();
}

/** Leaves the table and puts the text cursor just above or below it. */
function leave(dir: -1 | 1) {
  const e = editing;
  if (!e) return;
  stopEdit();
  placeCursorBeside(e.view, e.el, dir);
}

function placeCursorBeside(view: EditorView, el: HTMLElement, dir: -1 | 1) {
  if (editing) stopEdit();
  const from = view.posAtDOM(el);
  const to = from + (el.dataset.source ?? "").length;
  const anchor = dir < 0 ? Math.max(0, from - 1) : Math.min(view.state.doc.length, to + 1);
  view.focus();
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
}

function moveTo(row: number, col: number, addRow = false) {
  const e = editing;
  if (!e) return;
  const table = tableAt(e.el);
  if (!table) return;
  if (addRow) {
    writeTable(e, (t) => void t.rows.push(Array.from({ length: t.cols }, () => "")));
    stopEdit();
  }
  startEdit(e.view, e.el, row, col);
}

function onKey(ev: KeyboardEvent) {
  const e = editing;
  if (!e) return;
  const table = tableAt(e.el);
  if (!table) return;
  const rows = table.rows.length - 1; // DOM rows (no delimiter)
  const cols = table.cols;
  const last = e.row === rows - 1;
  const at = caretOffset(e.cell);
  const len = (e.cell.textContent ?? "").length;
  const handled = () => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  if (ev.key === "Tab") {
    handled();
    if (ev.shiftKey) {
      if (e.col > 0) moveTo(e.row, e.col - 1);
      else if (e.row > 0) moveTo(e.row - 1, cols - 1);
    } else if (e.col < cols - 1) moveTo(e.row, e.col + 1);
    else moveTo(e.row + 1, 0, last);
  } else if (ev.key === "Enter") {
    handled();
    if (ev.shiftKey) e.row > 0 ? moveTo(e.row - 1, e.col) : leave(-1);
    else moveTo(e.row + 1, e.col, last);
  } else if (ev.key === "ArrowUp") {
    handled();
    e.row > 0 ? moveTo(e.row - 1, e.col) : leave(-1);
  } else if (ev.key === "ArrowDown") {
    handled();
    last ? leave(1) : moveTo(e.row + 1, e.col);
  } else if (ev.key === "ArrowLeft" && at === 0 && !ev.shiftKey) {
    handled();
    if (e.col > 0) moveTo(e.row, e.col - 1);
    else if (e.row > 0) moveTo(e.row - 1, cols - 1);
    else leave(-1);
  } else if (ev.key === "ArrowRight" && at === len && !ev.shiftKey) {
    handled();
    if (e.col < cols - 1) moveTo(e.row, e.col + 1);
    else if (!last) moveTo(e.row + 1, 0);
    else leave(1);
  } else if (ev.key === "Escape") {
    handled();
    leave(1);
  }
}

/**
 * From the text editor, step into a table's first (dir 1) or last (dir -1) row. `lastCell` goes to the
 * very end of the table instead, as Backspace from the line below does.
 */
export function enterTable(view: EditorView, tableFrom: number, dir: -1 | 1, lastCell = false): boolean {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>(".cm-table-widget.is-editable")) {
    if (view.posAtDOM(el) !== tableFrom) continue;
    const rows = el.querySelectorAll("tr");
    const row = dir > 0 ? 0 : rows.length - 1;
    startEdit(view, el, row, lastCell ? rows[row].children.length - 1 : 0);
    return true;
  }
  return false;
}
