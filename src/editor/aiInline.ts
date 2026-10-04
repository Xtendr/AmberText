import { StateEffect, StateField, type EditorState, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface AiTarget {
  from: number;
  to: number;
  /** Line end after which the result card is shown. */
  anchor: number;
  /** Show the card (false: just keep the target highlighted, e.g. while the menu is open). */
  card: boolean;
  /** Card sits above the anchor line instead of below (for "insert at top"). */
  above?: boolean;
  id: number;
}

export const setAiTarget = StateEffect.define<AiTarget | null>();

/** The card hosts its React content through a portal into this element. */
type HostListener = (el: HTMLElement | null) => void;
let hostEl: HTMLElement | null = null;
const hostListeners = new Set<HostListener>();
export const aiHost = {
  get: () => hostEl,
  subscribe(fn: () => void) {
    hostListeners.add(fn);
    return () => void hostListeners.delete(fn);
  },
  set(el: HTMLElement | null) {
    hostEl = el;
    for (const fn of hostListeners) fn(el);
  },
};

class AiCardWidget extends WidgetType {
  constructor(readonly id: number) {
    super();
  }
  eq(other: AiCardWidget) {
    return other.id === this.id;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-ai-host";
    queueMicrotask(() => aiHost.set(el));
    return el;
  }
  destroy(el: HTMLElement) {
    if (hostEl === el) aiHost.set(null);
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 140;
  }
}

const targetMark = Decoration.mark({ class: "cm-ai-target" });

function decorations(t: AiTarget | null): DecorationSet {
  if (!t) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  if (t.to > t.from) ranges.push(targetMark.range(t.from, t.to));
  if (t.card) ranges.push(Decoration.widget({ widget: new AiCardWidget(t.id), block: true, side: t.above ? -1 : 1 }).range(t.anchor));
  return Decoration.set(ranges, true);
}

/** Briefly tints text the AI just wrote so the eye can find it. */
export const flashRange = StateEffect.define<{ from: number; to: number } | null>();
const flashMark = Decoration.mark({ class: "cm-ai-flash" });
export const aiFlashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(flashRange)) return e.value && e.value.to > e.value.from ? Decoration.set([flashMark.range(e.value.from, e.value.to)]) : Decoration.none;
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function flash(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: flashRange.of({ from, to }) });
  window.setTimeout(() => {
    if (view.state.field(aiFlashField, false)?.size) view.dispatch({ effects: flashRange.of(null) });
  }, 1600);
}

export const aiTargetField = StateField.define<AiTarget | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setAiTarget)) return e.value;
    if (!value || !tr.docChanged) return value;
    const from = tr.changes.mapPos(value.from, 1);
    const to = Math.max(from, tr.changes.mapPos(value.to, -1));
    const anchor = value.above ? tr.changes.mapPos(value.anchor, -1) : tr.state.doc.lineAt(Math.max(to, tr.changes.mapPos(value.anchor, 1))).to;
    return { ...value, from, to, anchor };
  },
  provide: (f) => EditorView.decorations.from(f, decorations),
});

/** Where a card for the range should sit: the end of the last line the range touches. */
export function anchorFor(state: EditorState, to: number, from: number): number {
  let pos = to;
  if (to > from && to === state.doc.lineAt(to).from) pos = to - 1;
  return state.doc.lineAt(pos).to;
}

export function currentTarget(view: EditorView | null): AiTarget | null {
  return view?.state.field(aiTargetField, false) ?? null;
}
