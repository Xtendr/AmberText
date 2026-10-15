import { Compartment, Facet, type EditorState } from "@codemirror/state";
import { Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import type { EditorView, ViewUpdate } from "@codemirror/view";

interface Saved {
  state: EditorState;
  scroll: number;
}

type Listener = (u: ViewUpdate | null) => void;
export const docIdFacet = Facet.define<string, string | null>({ combine: (v) => v[0] ?? null });
export const documentIdentity = new Compartment();

/** Shared handle to the single CodeMirror view and the parked per-document states. */
export const bridge = {
  view: null as EditorView | null,
  viewDocId: null as string | null,
  skipAutofocus: false,
  states: new Map<string, Saved>(),
  listeners: new Set<Listener>(),
  scrollListeners: new Set<() => void>(),

  onUpdate(fn: Listener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  },
  emit(u: ViewUpdate | null) {
    for (const fn of this.listeners) fn(u);
  },
  onScroll(fn: () => void) {
    this.scrollListeners.add(fn);
    return () => void this.scrollListeners.delete(fn);
  },
  emitScroll() {
    for (const fn of this.scrollListeners) fn();
  },

  focus() {
    this.view?.focus();
  },

  /** Replace a document's text (e.g. reloaded from disk) without losing the tab. */
  replaceContent(id: string, text: string) {
    const view = this.view;
    if (view && this.viewDocId === id) {
      if (view.state.doc.toString() === text) return;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: head },
        userEvent: "reload",
      });
    } else {
      this.states.delete(id);
    }
  },

  forget(id: string) {
    this.states.delete(id);
    if (this.viewDocId === id) this.viewDocId = null;
  },

  /** A reviewed history restore is one Undo step in active or parked state. */
  restoreContent(id: string, text: string) {
    const view = this.view;
    const saved = this.states.get(id);
    const state = view && this.viewDocId === id ? view.state : saved?.state;
    if (!state || state.doc.toString() === text) return;
    const change = { changes: { from: 0, to: state.doc.length, insert: text },
      selection: { anchor: Math.min(state.selection.main.head,text.length) },
      annotations: [Transaction.userEvent.of("input.history"),isolateHistory.of("full")] };
    if (view && this.viewDocId === id) view.dispatch(change);
    else if (saved) this.states.set(id,{ ...saved, state: state.update(change).state });
  },

  /** Apply one reviewed Undo step in active or parked state. */
  applyReviewedChanges(id: string, before: string, changes: Array<{ from: number; to: number; insert: string }>, after: string): boolean {
    const view = this.view, parked = this.states.get(id);
    const state = view && this.viewDocId === id ? view.state : parked?.state;
    if (!state || state.doc.toString() !== before) return false;
    const spec = { changes, annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")] };
    const transaction = state.update(spec);
    if (transaction.newDoc.toString() !== after) return false;
    if (view && this.viewDocId === id) view.dispatch(transaction);
    else if (parked) this.states.set(id, { ...parked, state: transaction.state });
    return true;
  },

  /** Keep selection/undo/scroll when Save As commits a distinct file identity. */
  reidentify(from: string, to: string) {
    const parked = this.states.get(from);
    if (parked) this.states.set(to, { ...parked, state: parked.state.update({ effects: documentIdentity.reconfigure(docIdFacet.of(to)) }).state });
    this.states.delete(from);
    if (this.viewDocId === from) {
      this.viewDocId = to;
      this.view?.dispatch({ effects: documentIdentity.reconfigure(docIdFacet.of(to)) });
    }
  },
};
