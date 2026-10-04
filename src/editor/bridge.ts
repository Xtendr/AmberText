import type { EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";

interface Saved {
  state: EditorState;
  scroll: number;
}

type Listener = (u: ViewUpdate | null) => void;

/** Shared handle to the single CodeMirror view and the parked per-document states. */
export const bridge = {
  view: null as EditorView | null,
  viewDocId: null as string | null,
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
};
