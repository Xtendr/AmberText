import { create } from "zustand";
import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import { bridge } from "../editor/bridge";
import { aiTargetField, anchorFor, currentTarget, flash, setAiTarget } from "../editor/aiInline";
import { frontmatterEnd } from "../editor/livePreview";
import { activeDoc, getState, useStore } from "../state/store";
import { displayName, setViewMode, toast } from "../state/actions";
import { extractHeadings } from "../lib/text";
import { aiReady, chat, installModel, prewarm, useAi, type ChatMessage } from "./engine";
import { buildMessages, cleanOutput, customAction, MAX_DOC_CHARS, preservationWarnings, type AiAction, type AiScope } from "./actions";
import type { ModelTier } from "./models";

export type SessionStatus = "setup" | "loading" | "streaming" | "done" | "error";

export interface AiSession {
  id: number;
  action: AiAction;
  docId: string;
  placement: "inline" | "dock";
  status: SessionStatus;
  output: string;
  original: string;
  /** Document text when a whole-document rewrite started. */
  docSnapshot?: string;
  messages: ChatMessage[];
  warnings: string[];
  error?: string;
  /** How many refinements/retries so far. */
  turns: number;
  truncated?: boolean;
}

export interface MenuState {
  scope: AiScope;
  from: number;
  to: number;
  initial?: string;
}

interface SessionStore {
  session: AiSession | null;
  menu: MenuState | null;
}

export const useAiSession = create<SessionStore>(() => ({ session: null, menu: null }));
const setS = useAiSession.setState;
const getS = useAiSession.getState;

let seq = 0;
let controller: AbortController | null = null;

function view(): EditorView | null {
  return bridge.view && bridge.viewDocId ? bridge.view : null;
}

function patch(p: Partial<AiSession>) {
  const s = getS().session;
  if (s) setS({ session: { ...s, ...p } });
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */

export function openAiMenu(initial?: string) {
  if (!getState().settings.aiEnabled) {
    getState().setSettings({ aiEnabled: true });
  }
  if (!activeDoc()) return;
  if (getState().settings.viewMode === "read") setViewMode("write");
  const v = view();
  if (!v) return;
  if (getS().session) discard(false);
  const sel = v.state.selection.main;
  const scope: AiScope = sel.empty ? "cursor" : "selection";
  v.dispatch({ effects: setAiTarget.of({ from: sel.from, to: sel.to, anchor: anchorFor(v.state, sel.to, sel.from), card: false, id: ++seq }) });
  setS({ menu: { scope, from: sel.from, to: sel.to, initial } });
  prewarm();
}

export function closeAiMenu(refocus = true) {
  if (!getS().menu) return;
  setS({ menu: null });
  const v = view();
  if (v && !getS().session && currentTarget(v)) v.dispatch({ effects: setAiTarget.of(null) });
  if (refocus) requestAnimationFrame(() => v?.focus());
}

/* ------------------------------------------------------------------ */
/* Running actions                                                     */
/* ------------------------------------------------------------------ */

function titleOf(): string {
  const d = activeDoc();
  return d ? displayName(d) : "";
}

export function runAction(action: AiAction) {
  const v = view();
  const doc = activeDoc();
  if (!v || !doc) return;
  if (getState().settings.viewMode === "read") setViewMode("write");
  controller?.abort();
  const menu = getS().menu;
  setS({ menu: null });

  const state = v.state;
  const sel = state.selection.main;
  const from = menu ? menu.from : sel.from;
  const to = menu ? menu.to : sel.to;
  const text = state.doc.toString();
  const id = ++seq;

  let placement: AiSession["placement"] = "inline";
  let original = "";
  let messages: ChatMessage[];
  let truncated = false;

  if (action.scope === "selection") {
    original = state.sliceDoc(from, to);
    messages = buildMessages(action, { text: original, title: titleOf() });
    v.dispatch({ effects: setAiTarget.of({ from, to, anchor: anchorFor(state, to, from), card: true, id }) });
  } else if (action.scope === "cursor") {
    messages = buildMessages(action, { text, before: state.sliceDoc(0, to), after: state.sliceDoc(to) });
    v.dispatch({ effects: setAiTarget.of({ from: to, to, anchor: state.doc.lineAt(to).to, card: true, id }) });
  } else {
    placement = "dock";
    original = text;
    truncated = text.length > MAX_DOC_CHARS;
    messages = buildMessages(action, { text });
    v.dispatch({ effects: setAiTarget.of(null) });
  }

  setS({
    session: {
      id,
      action,
      docId: doc.id,
      placement,
      status: aiReady() ? "loading" : "setup",
      output: "",
      original,
      docSnapshot: action.scope === "document" ? text : undefined,
      messages,
      warnings: [],
      turns: 0,
      truncated,
    },
  });
  if (aiReady()) void generate();
}

export function runCustom(instruction: string, scope?: AiScope) {
  const menu = getS().menu;
  const v = view();
  const s: AiScope = scope ?? menu?.scope ?? (v && !v.state.selection.main.empty ? "selection" : "document");
  runAction(customAction(instruction, s));
}

async function generate(temperature?: number) {
  const s = getS().session;
  if (!s) return;
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  const id = s.id;
  patch({ status: "loading", output: "", error: undefined, warnings: [] });

  let buffer = "";
  let frame = 0;
  const flushTokens = () => {
    frame = 0;
    const cur = getS().session;
    if (!cur || cur.id !== id || ctrl.signal.aborted) return;
    patch({ output: buffer, status: "streaming" });
  };

  try {
    const raw = await chat({
      messages: s.messages,
      maxTokens: s.action.maxTokens ?? (s.action.kind === "answer" ? 900 : Math.min(2400, Math.max(400, Math.ceil(s.original.length / 2.2)))),
      temperature: temperature ?? 0.3,
      signal: ctrl.signal,
      onToken: (t) => {
        buffer += t;
        if (!frame) frame = requestAnimationFrame(flushTokens);
      },
    });
    if (frame) cancelAnimationFrame(frame);
    const cur = getS().session;
    if (!cur || cur.id !== id || ctrl.signal.aborted) return;
    const output = cleanOutput(raw || buffer, cur.original, cur.action.kind);
    if (!output) {
      patch({ status: "error", error: "The model didn't return anything. Try again, or rephrase the request." });
      return;
    }
    patch({
      status: "done",
      output,
      warnings: cur.action.preserve && cur.original ? preservationWarnings(cur.original, output) : [],
    });
  } catch (e) {
    if (frame) cancelAnimationFrame(frame);
    const cur = getS().session;
    if (!cur || cur.id !== id || ctrl.signal.aborted) return;
    patch({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}

export function retry() {
  const s = getS().session;
  if (!s) return;
  patch({ turns: s.turns + 1 });
  void generate(0.75);
}

export function refine(instruction: string) {
  const s = getS().session;
  if (!s || !s.output.trim()) return;
  const messages: ChatMessage[] = [
    ...s.messages,
    { role: "assistant", content: s.output },
    { role: "user", content: `${instruction}\n\nReply with the complete revised result only.` },
  ];
  patch({ messages, turns: s.turns + 1 });
  void generate();
}

/** Downloads a model; the waiting request resumes via the subscription below. */
export function setupAndRun(tier: ModelTier) {
  void installModel(tier);
}

export function resumeAfterSetup() {
  const s = getS().session;
  if (s && s.status === "setup" && aiReady()) void generate();
}

export function stop() {
  controller?.abort();
  const s = getS().session;
  if (!s) return;
  if (s.output.trim()) patch({ status: "done", output: cleanOutput(s.output, s.original, s.action.kind) });
  else discard();
}

export function discard(refocus = true) {
  controller?.abort();
  controller = null;
  const v = view();
  setS({ session: null });
  if (v && currentTarget(v)) v.dispatch({ effects: setAiTarget.of(null) });
  if (refocus) requestAnimationFrame(() => v?.focus());
}

/* ------------------------------------------------------------------ */
/* Applying results                                                    */
/* ------------------------------------------------------------------ */

function insertionAtTop(state: EditorState): { pos: number; prefix: string; suffix: string } {
  let pos = 0;
  const fm = frontmatterEnd(state);
  if (fm >= 0) pos = fm;
  const rest = state.sliceDoc(pos);
  const h1 = /^\s*(#\s+[^\n]*)/.exec(rest);
  if (h1) pos += h1[0].length;
  const before = pos > 0 ? "\n\n" : "";
  const nextChars = state.sliceDoc(pos, pos + 2);
  const after = nextChars.startsWith("\n\n") ? "" : pos >= state.doc.length ? "\n" : nextChars.startsWith("\n") ? "\n" : "\n\n";
  return { pos, prefix: before, suffix: after };
}

function blockSeparated(state: EditorState, pos: number, text: string) {
  const line = state.doc.lineAt(pos);
  const prefix = line.text.trim() ? "\n\n" : line.number > 1 && state.doc.line(line.number - 1).text.trim() ? "\n" : "";
  const nextLine = line.number < state.doc.lines ? state.doc.line(line.number + 1).text : "";
  const suffix = nextLine.trim() ? "\n" : "";
  return { insert: prefix + text + suffix, offset: prefix.length };
}

/** `offset` skips leading separator whitespace when placing the caret and highlight. */
function apply(v: EditorView, from: number, to: number, insert: string, offset = 0) {
  const start = from + offset;
  const end = start + insert.slice(offset).trimEnd().length;
  v.dispatch({ changes: { from, to, insert }, selection: { anchor: end }, userEvent: "input.ai", scrollIntoView: true });
  flash(v, start, end);
}

function headingLevelBefore(state: EditorState, pos: number): number {
  const hs = extractHeadings(state.sliceDoc(0, pos));
  return hs.length ? Math.min(6, Math.max(2, hs[hs.length - 1].level)) : 2;
}

export type AcceptMode = "replace" | "below" | "insert" | "cursor";

export function primaryMode(s: AiSession): AcceptMode {
  if (s.action.kind === "rewrite") return "replace";
  if (s.action.kind === "insert") return "insert";
  return s.action.scope === "selection" ? "below" : "cursor";
}

export function accept(mode: AcceptMode = "replace") {
  const s = getS().session;
  const v = view();
  if (!s || !v || !s.output.trim() || (s.status !== "done" && s.status !== "streaming")) return;
  if (s.status === "streaming") stop();
  const output = (getS().session ?? s).output.trim();
  if (!output) return;
  const state = v.state;
  const target = state.field(aiTargetField, false);
  const action = s.action;

  if (action.scope === "document" && mode === "replace") {
    if (state.doc.toString() !== s.docSnapshot) {
      toast("The document changed while the AI was working — try again to include your edits", "error");
      return;
    }
    const keepFm = frontmatterEnd(state);
    let next = output;
    if (keepFm >= 0 && !output.startsWith("---")) next = state.sliceDoc(0, keepFm) + "\n\n" + output;
    if (state.doc.toString().endsWith("\n") && !next.endsWith("\n")) next += "\n";
    v.dispatch({ changes: { from: 0, to: state.doc.length, insert: next }, userEvent: "input.ai", selection: { anchor: 0 }, scrollIntoView: true });
    finish(v);
    toast("Document updated — undo to restore the original", "success", { label: "Undo", run: () => undo(v) });
    return;
  }

  if (action.placement === "frontmatter") {
    const yaml = output.replace(/^---\s*\n?/, "").replace(/\n?---\s*$/, "").trim();
    const fm = frontmatterEnd(state);
    if (fm >= 0) {
      const existing = state.sliceDoc(0, fm);
      const keys = new Set([...existing.matchAll(/^([\w-]+):/gm)].map((m) => m[1]));
      const fresh: string[] = [];
      let skipping = false;
      for (const line of yaml.split("\n")) {
        const key = /^([\w-]+):/.exec(line)?.[1];
        if (key) skipping = keys.has(key);
        if (!skipping) fresh.push(line);
      }
      if (!fresh.length) {
        toast("The front matter already has these fields");
        finish(v);
        return;
      }
      const closeLine = state.doc.lineAt(fm);
      apply(v, closeLine.from, closeLine.from, fresh.join("\n") + "\n");
    } else {
      apply(v, 0, 0, `---\n${yaml}\n---\n\n`);
    }
    finish(v);
    return;
  }

  if (action.scope === "document" && (mode === "insert" || action.placement === "top")) {
    const { pos, prefix, suffix } = insertionAtTop(state);
    apply(v, pos, pos, prefix + output + suffix, prefix.length);
    finish(v);
    return;
  }

  const from = target?.from ?? state.selection.main.from;
  const to = target?.to ?? state.selection.main.to;

  if (mode === "replace") {
    const lead = /^\s*/.exec(s.original)![0];
    const trail = /\s*$/.exec(s.original)![0];
    const insert = lead + output + trail;
    apply(v, from, to, insert, lead.length);
  } else if (action.id === "heading") {
    const line = state.doc.lineAt(from);
    const level = headingLevelBefore(state, line.from);
    const heading = `${"#".repeat(level)} ${output.replace(/^#+\s*/, "").replace(/^["“]|["”]$/g, "")}\n\n`;
    apply(v, line.from, line.from, heading);
  } else if (mode === "cursor" || (action.scope === "cursor" && mode === "insert")) {
    const pos = action.scope === "cursor" ? from : state.selection.main.head;
    const line = state.doc.lineAt(pos);
    const atLineEnd = pos === line.to;
    if (atLineEnd || !line.text.trim()) {
      const { insert, offset } = blockSeparated(state, pos, output);
      apply(v, pos, pos, insert, offset);
    } else {
      apply(v, pos, pos, output);
    }
  } else {
    const anchor = target?.anchor ?? state.doc.lineAt(to).to;
    const { insert, offset } = blockSeparated(state, anchor, output);
    apply(v, anchor, anchor, insert, offset);
  }
  finish(v);
}

export function applyTitle(title: string) {
  const v = view();
  if (!v) return;
  const state = v.state;
  const fm = frontmatterEnd(state);
  const start = fm >= 0 ? fm : 0;
  const rest = state.sliceDoc(start);
  const m = /^(\s*)#\s+([^\n]*)/.exec(rest);
  if (m) {
    const from = start + m[1].length + m[0].length - m[1].length - m[2].length;
    apply(v, from, from + m[2].length, title);
  } else {
    const prefix = start > 0 ? "\n\n" : "";
    apply(v, start, start, `${prefix}# ${title}\n\n`, prefix.length);
  }
  finish(v);
}

function finish(v: EditorView) {
  controller = null;
  setS({ session: null });
  if (currentTarget(v)) v.dispatch({ effects: setAiTarget.of(null) });
  requestAnimationFrame(() => v.focus());
}

export async function copyOutput() {
  const s = getS().session;
  if (!s?.output) return;
  try {
    await navigator.clipboard.writeText(s.output.trim());
    toast("Copied");
  } catch {
    toast("Couldn't access the clipboard", "error");
  }
}

/* Leaving the document drops the session — its target belongs to that editor state. */
useStore.subscribe((s, prev) => {
  if (s.activeId === prev.activeId) return;
  const session = getS().session;
  if (session) {
    controller?.abort();
    setS({ session: null });
    const parked = bridge.states.get(session.docId);
    if (parked) bridge.states.set(session.docId, { ...parked, state: parked.state.update({ effects: setAiTarget.of(null) }).state });
  }
  if (getS().menu) setS({ menu: null });
});

/* When a model finishes downloading elsewhere (settings), pick up a waiting request. */
useAi.subscribe((s, prev) => {
  if (prev.installing && !s.installing) resumeAfterSetup();
});
