import { HighlightStyle } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const marginHighlight = HighlightStyle.define([
  { tag: t.heading, class: "tok-heading" },
  { tag: t.strong, class: "tok-strong" },
  { tag: t.emphasis, class: "tok-em" },
  { tag: t.strikethrough, class: "tok-strike" },
  { tag: t.link, class: "tok-link" },
  { tag: t.url, class: "tok-url" },
  { tag: t.monospace, class: "tok-mono" },
  { tag: t.quote, class: "tok-quote" },
  { tag: [t.processingInstruction, t.contentSeparator], class: "tok-mark" },
  { tag: t.labelName, class: "tok-label" },
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self], class: "tok-keyword" },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], class: "tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], class: "tok-number" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: "tok-function" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: "tok-type" },
  { tag: [t.propertyName, t.attributeName], class: "tok-property" },
  { tag: [t.tagName, t.angleBracket], class: "tok-tag" },
  { tag: [t.operator, t.derefOperator], class: "tok-operator" },
  { tag: [t.punctuation, t.separator, t.bracket], class: "tok-punct" },
  { tag: [t.definition(t.variableName), t.variableName], class: "tok-variable" },
  { tag: [t.meta, t.annotation], class: "tok-meta" },
  { tag: [t.inserted], class: "tok-inserted" },
  { tag: [t.deleted], class: "tok-deleted" },
  { tag: t.invalid, class: "tok-invalid" },
]);

/* Focus mode: everything but the current paragraph recedes. */

function paragraphLines(state: EditorState): DecorationSet {
  const doc = state.doc;
  const line = doc.lineAt(state.selection.main.head);
  const deco = Decoration.line({ class: "cm-focus-active" });
  if (!line.text.trim()) return Decoration.set([deco.range(line.from)]);
  let a = line.number;
  let b = line.number;
  while (a > 1 && a > line.number - 300 && doc.line(a - 1).text.trim()) a--;
  while (b < doc.lines && b < line.number + 300 && doc.line(b + 1).text.trim()) b++;
  const out = [];
  for (let n = a; n <= b; n++) out.push(deco.range(doc.line(n).from));
  return Decoration.set(out);
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = paragraphLines(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = paragraphLines(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);

export function focusMode(): Extension {
  return [focusPlugin, EditorView.editorAttributes.of({ class: "cm-focus-mode" })];
}

/* Typewriter scrolling: keep the caret on a steady line while typing. */

export function typewriter(): Extension {
  return [
    EditorState.transactionExtender.of((tr) => {
      if (!tr.docChanged && !tr.selection) return null;
      if (tr.isUserEvent("select.pointer")) return null;
      const typed =
        tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("select") || tr.isUserEvent("undo") || tr.isUserEvent("redo");
      if (!typed) return null;
      return { effects: EditorView.scrollIntoView(tr.newSelection.main.head, { y: "center" }) };
    }),
    EditorView.editorAttributes.of({ class: "cm-typewriter" }),
  ];
}
