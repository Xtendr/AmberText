import { useEffect, useRef } from "react";
import { Compartment, EditorState, Facet, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  placeholder,
  rectangularSelection,
  type KeyBinding,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { search, searchKeymap, searchPanelOpen } from "@codemirror/search";
import { completionKeymap } from "@codemirror/autocomplete";
import type { SyntaxNode } from "@lezer/common";
import { getState, setState, useStore, type Doc, type Settings } from "../state/store";
import { bridge } from "./bridge";
import { formattingKeymap } from "./commands";
import { focusMode, marginHighlight, typewriter } from "./extras";
import { createFindPanel } from "./FindPanel";
import { livePreview, refreshBlocks, setImageResolver, sourceMode, syncFocus } from "./livePreview";
import { setImagePicker, slashCommands } from "./slash";
import { countWords } from "../lib/text";
import { fileSrc } from "../lib/platform";
import { dirname, isExternalUrl, resolvePath } from "../lib/paths";
import { followLink, insertImageFiles, pasteImage, pickImages, updateContent } from "../state/actions";
import { aiFlashField, aiTargetField } from "./aiInline";
import { htmlToMarkdown, isConvertibleHtml } from "../lib/htmlToMarkdown";
import { smartEditing } from "./smartEdit";
import { Highlight } from "./mdExtensions";

const docIdFacet = Facet.define<string, string | null>({ combine: (v) => v[0] ?? null });

const live = new Compartment();
const focus = new Compartment();
const writer = new Compartment();
const spell = new Compartment();

function settingsExt(s: Settings) {
  return {
    live: s.livePreview ? livePreview() : sourceMode(),
    focus: s.focusMode ? focusMode() : [],
    writer: s.typewriter ? typewriter() : [],
    spell: EditorView.contentAttributes.of({
      spellcheck: String(s.spellcheck),
      autocorrect: "off",
      autocapitalize: "sentences",
      "aria-label": "Document editor",
    }),
  };
}

function inCode(view: EditorView, pos: number): boolean {
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "InlineCode") return true;
  }
  return false;
}

function linkAt(view: EditorView, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "URL") return view.state.sliceDoc(n.from, n.to);
    if (n.name === "Link" || n.name === "Autolink" || n.name === "Image") {
      const url = n.getChild("URL");
      return url ? view.state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "") : null;
    }
  }
  return null;
}

function onUpdate(u: ViewUpdate) {
  const id = u.state.facet(docIdFacet);
  if (!id) return;
  if (u.docChanged) {
    updateContent(id, u.state.doc.toString());
    const typed = u.transactions.some((t) => t.isUserEvent("input") || t.isUserEvent("delete"));
    if (typed && getState().settings.quietChrome && !getState().typing) setState({ typing: true });
  }
  if (u.docChanged || u.selectionSet) {
    const sel = u.state.selection.main;
    const line = u.state.doc.lineAt(sel.head);
    const selected = sel.empty ? "" : u.state.sliceDoc(sel.from, Math.min(sel.to, sel.from + 200000));
    setState({
      cursor: {
        pos: sel.head,
        line: line.number,
        col: sel.head - line.from + 1,
        selChars: sel.to - sel.from,
        selWords: selected ? countWords(selected) : 0,
      },
    });
  }
  bridge.emit(u);
}

/** Mod-Shift-L cycles the theme and Mod-G jumps to a heading unless a search is open. */
const editorSearchKeymap: KeyBinding[] = searchKeymap
  .filter((b) => b.key !== "Mod-Shift-l")
  .map((b) => {
    if (b.key !== "Mod-g") return b;
    const { run, shift } = b;
    return {
      ...b,
      run: run && ((v: EditorView) => searchPanelOpen(v.state) && run(v)),
      shift: shift && ((v: EditorView) => searchPanelOpen(v.state) && shift(v)),
    };
  });

const baseExtensions: Extension[] = [
  history(),
  drawSelection({ cursorBlinkRate: 1000 }),
  dropCursor(),
  rectangularSelection(),
  highlightSpecialChars(),
  EditorView.lineWrapping,
  EditorState.allowMultipleSelections.of(true),
  markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true, extensions: [Highlight] }),
  syntaxHighlighting(marginHighlight),
  search({ top: true, createPanel: createFindPanel }),
  slashCommands(),
  smartEditing(),
  aiTargetField,
  aiFlashField,
  keymap.of([...formattingKeymap, ...completionKeymap, ...editorSearchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
  placeholder("Start writing — or type / to insert a block"),
  EditorView.updateListener.of(onUpdate),
  EditorView.domEventHandlers({
    mousedown(e, view) {
      if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      const href = linkAt(view, pos);
      if (!href) return false;
      e.preventDefault();
      followLink(href);
      return true;
    },
    paste(e, view) {
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
      if (files.length) {
        e.preventDefault();
        void pasteImage(view, files);
        return true;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
      const sel = view.state.selection.main;
      if (!sel.empty && /^https?:\/\/\S+$/.test(text) && !/\n/.test(view.state.sliceDoc(sel.from, sel.to))) {
        e.preventDefault();
        const label = view.state.sliceDoc(sel.from, sel.to);
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` },
          selection: { anchor: sel.from + label.length + text.length + 4 },
          userEvent: "input.paste",
        });
        return true;
      }
      const html = e.clipboardData?.getData("text/html") ?? "";
      if (html && isConvertibleHtml(html) && !inCode(view, sel.from)) {
        let md = "";
        try {
          md = htmlToMarkdown(html);
        } catch {
          return false;
        }
        if (!md) return false;
        e.preventDefault();
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: md },
          selection: { anchor: sel.from + md.length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      }
      return false;
    },
    scroll() {
      bridge.emitScroll();
    },
  }),
];

export function createEditorState(doc: Doc): EditorState {
  const s = settingsExt(getState().settings);
  return EditorState.create({
    doc: doc.content,
    extensions: [
      docIdFacet.of(doc.id),
      baseExtensions,
      live.of(s.live),
      focus.of(s.focus),
      writer.of(s.writer),
      spell.of(s.spell),
    ],
  });
}

function reconfigure(view: EditorView) {
  const s = settingsExt(getState().settings);
  view.dispatch({
    effects: [live.reconfigure(s.live), focus.reconfigure(s.focus), writer.reconfigure(s.writer), spell.reconfigure(s.spell)],
  });
  view.dispatch({ effects: syncFocus(view) });
}

setImageResolver((src) => {
  if (!src || isExternalUrl(src) || src.startsWith("data:")) return src;
  const doc = getState().docs.find((d) => d.id === bridge.viewDocId);
  if (!doc?.path) return src;
  return fileSrc(resolvePath(dirname(doc.path), src));
});

setImagePicker((view, from) => {
  void pickImages().then((paths) => {
    if (paths.length) void insertImageFiles(view, paths, from);
  });
});

let launched = false;

export function Editor() {
  const host = useRef<HTMLDivElement>(null);
  const activeId = useStore((s) => s.activeId);
  const livePref = useStore((s) => s.settings.livePreview);
  const focusPref = useStore((s) => s.settings.focusMode);
  const writerPref = useStore((s) => s.settings.typewriter);
  const spellPref = useStore((s) => s.settings.spellcheck);
  const dark = useStore((s) => s.dark);

  useEffect(() => {
    const view = new EditorView({ parent: host.current!, state: EditorState.create({ doc: "" }) });
    bridge.view = view;
    return () => {
      view.destroy();
      bridge.view = null;
      bridge.viewDocId = null;
    };
  }, []);

  useEffect(() => {
    const view = bridge.view;
    if (!view) return;
    const prev = bridge.viewDocId;
    if (prev === activeId) return;
    if (prev && getState().docs.some((d) => d.id === prev)) {
      bridge.states.set(prev, { state: view.state, scroll: view.scrollDOM.scrollTop });
    }
    const doc = getState().docs.find((d) => d.id === activeId);
    if (!doc) {
      bridge.viewDocId = null;
      view.setState(EditorState.create({ doc: "" }));
      return;
    }
    const saved = bridge.states.get(doc.id);
    const state = saved && saved.state.doc.toString() === doc.content ? saved.state : createEditorState(doc);
    bridge.viewDocId = doc.id;
    view.setState(state);
    reconfigure(view);
    const scroll = saved?.scroll ?? 0;
    // On launch, open on the clean rendered page unless there's nothing to read yet.
    const autofocus = launched || !doc.content.trim();
    launched = true;
    requestAnimationFrame(() => {
      view.scrollDOM.scrollTop = scroll;
      if (autofocus && getState().settings.viewMode !== "read") view.focus();
    });
  }, [activeId]);

  useEffect(() => {
    if (bridge.view && bridge.viewDocId) reconfigure(bridge.view);
  }, [livePref, focusPref, writerPref, spellPref]);

  useEffect(() => {
    bridge.view?.dispatch({ effects: refreshBlocks.of(null) });
  }, [dark]);

  return <div className="editor-host" ref={host} />;
}
