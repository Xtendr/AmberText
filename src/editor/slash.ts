import {
  autocompletion,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSection,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CalendarDays,
  CircleAlert,
  Code,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Image as ImageIcon,
  Info,
  Lightbulb,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Sigma,
  Table,
  TriangleAlert,
  Workflow,
  Sparkles,
  PenLine,
} from "lucide-react";
import { fuzzy } from "../lib/fuzzy";
import { getState } from "../state/store";
import { openAiMenu, runAction } from "../ai/session";
import { actionById } from "../ai/actions";

export interface SlashItem {
  id: string;
  title: string;
  hint: string;
  keywords: string;
  section: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  template?: string;
  run?: (view: EditorView, from: number, to: number) => void;
}

let imagePicker: ((view: EditorView, from: number, to: number) => void) | null = null;
export function setImagePicker(fn: typeof imagePicker) {
  imagePicker = fn;
}

const BASIC = "Basic blocks";
const RICH = "Rich content";
const CALLOUT = "Callouts";
const INSERT = "Insert";
const AI = "AI";
const SECTIONS: Record<string, CompletionSection> = {
  [AI]: { name: AI, rank: -1 },
  [BASIC]: { name: BASIC, rank: 0 },
  [RICH]: { name: RICH, rank: 1 },
  [CALLOUT]: { name: CALLOUT, rank: 2 },
  [INSERT]: { name: INSERT, rank: 3 },
};

export const SLASH_ITEMS: SlashItem[] = [
  { id: "ai-ask", title: "Ask AI", hint: "Write, review or ask about this page", keywords: "ai assistant write help generate", section: AI, icon: Sparkles, run: () => requestAnimationFrame(() => openAiMenu()) },
  {
    id: "ai-continue",
    title: "Continue writing",
    hint: "Let AI draft what comes next",
    keywords: "ai continue next draft autocomplete",
    section: AI,
    icon: PenLine,
    run: () => requestAnimationFrame(() => runAction(actionById.get("continue")!)),
  },
  { id: "text", title: "Text", hint: "Plain paragraph", keywords: "paragraph body p", section: BASIC, icon: Pilcrow, template: "${}" },
  { id: "h1", title: "Heading 1", hint: "Large section title", keywords: "title h1 #", section: BASIC, icon: Heading1, template: "# ${}" },
  { id: "h2", title: "Heading 2", hint: "Medium section title", keywords: "subtitle h2 ##", section: BASIC, icon: Heading2, template: "## ${}" },
  { id: "h3", title: "Heading 3", hint: "Small section title", keywords: "h3 ###", section: BASIC, icon: Heading3, template: "### ${}" },
  { id: "bullet", title: "Bulleted list", hint: "Simple list", keywords: "ul unordered bullets -", section: BASIC, icon: List, template: "- ${}" },
  { id: "ordered", title: "Numbered list", hint: "Ordered steps", keywords: "ol ordered numbers 1.", section: BASIC, icon: ListOrdered, template: "1. ${}" },
  { id: "task", title: "To-do list", hint: "Track tasks with checkboxes", keywords: "task todo checkbox check", section: BASIC, icon: ListChecks, template: "- [ ] ${}" },
  { id: "quote", title: "Quote", hint: "Capture a quotation", keywords: "blockquote cite >", section: BASIC, icon: Quote, template: "> ${}" },
  { id: "divider", title: "Divider", hint: "Visually separate sections", keywords: "hr rule line separator ---", section: BASIC, icon: Minus, template: "---\n${}" },
  { id: "code", title: "Code block", hint: "Syntax-highlighted code", keywords: "fence snippet ``` pre", section: RICH, icon: Code, template: "```${lang}\n${}\n```" },
  {
    id: "table",
    title: "Table",
    hint: "Rows and columns",
    keywords: "grid columns rows",
    section: RICH,
    icon: Table,
    template: "| ${Column} | Column |\n| --- | --- |\n| ${} |  |\n|  |  |",
  },
  { id: "math", title: "Math block", hint: "LaTeX equation", keywords: "katex latex equation formula tex $$", section: RICH, icon: Sigma, template: "$$\n${}\n$$" },
  {
    id: "mermaid",
    title: "Diagram",
    hint: "Flowchart from text (Mermaid)",
    keywords: "mermaid flowchart chart graph sequence",
    section: RICH,
    icon: Workflow,
    template: "```mermaid\nflowchart LR\n  A[${Start}] --> B[Finish]\n```",
  },
  { id: "note", title: "Note", hint: "Highlight useful information", keywords: "callout info alert admonition", section: CALLOUT, icon: Info, template: "> [!NOTE]\n> ${}" },
  { id: "tip", title: "Tip", hint: "Helpful advice", keywords: "callout hint", section: CALLOUT, icon: Lightbulb, template: "> [!TIP]\n> ${}" },
  { id: "important", title: "Important", hint: "Key information", keywords: "callout", section: CALLOUT, icon: CircleAlert, template: "> [!IMPORTANT]\n> ${}" },
  { id: "warning", title: "Warning", hint: "Needs attention", keywords: "callout caution danger", section: CALLOUT, icon: TriangleAlert, template: "> [!WARNING]\n> ${}" },
  { id: "link", title: "Link", hint: "Link to a page", keywords: "url href anchor", section: INSERT, icon: Link, template: "[${text}](${url})" },
  { id: "image", title: "Image from URL", hint: "Embed by address", keywords: "picture img photo", section: INSERT, icon: ImageIcon, template: "![${alt}](${url})" },
  {
    id: "image-file",
    title: "Image from file…",
    hint: "Copy into the assets folder",
    keywords: "picture img photo upload attach",
    section: INSERT,
    icon: ImagePlus,
    run: (view, from, to) => imagePicker?.(view, from, to),
  },
  {
    id: "date",
    title: "Today's date",
    hint: new Date().toLocaleDateString(undefined, { dateStyle: "long" }),
    keywords: "today now time calendar",
    section: INSERT,
    icon: CalendarDays,
    run: (view, from, to) => {
      const text = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    },
  },
];

const BLOCK_IDS = new Set(["h1", "h2", "h3", "bullet", "ordered", "task", "quote", "divider", "code", "table", "math", "mermaid", "note", "tip", "important", "warning", "text"]);

const iconCache = new Map<string, string>();
function iconSvg(item: SlashItem): string {
  let svg = iconCache.get(item.id);
  if (!svg) {
    svg = renderToStaticMarkup(createElement(item.icon, { size: 16, strokeWidth: 1.75 }));
    iconCache.set(item.id, svg);
  }
  return svg;
}

function inCode(node: SyntaxNode | null): boolean {
  for (let n = node; n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "InlineCode" || n.name === "CodeText" || n.name === "HTMLBlock") return true;
  }
  return false;
}

type SlashCompletion = Completion & { item: SlashItem };

function applyItem(item: SlashItem) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    if (item.run) {
      view.dispatch({ changes: { from, to, insert: "" } });
      item.run(view, from, from);
      return;
    }
    let template = item.template ?? "";
    if (BLOCK_IDS.has(item.id)) {
      const line = view.state.doc.lineAt(from);
      const before = view.state.sliceDoc(line.from, from);
      if (before.trim()) template = "\n\n" + template;
      else if (item.id === "divider" && line.number > 1 && view.state.doc.line(line.number - 1).text.trim()) template = "\n" + template;
    }
    snippet(template)(view, completion, from, to);
  };
}

function slashSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(/\/[\w-]*$/);
  if (!match) return null;
  const charBefore = context.state.sliceDoc(match.from - 1, match.from);
  if (match.from > 0 && charBefore && !/\s/.test(charBefore)) return null;
  if (inCode(syntaxTree(context.state).resolveInner(match.from, -1))) return null;
  const query = match.text.slice(1);
  const aiOn = getState().settings.aiEnabled;
  const items = SLASH_ITEMS.filter((item) => aiOn || item.section !== AI).map((item) => {
    if (!query) return { item, score: 0 };
    const r = fuzzy(query, item.title) ?? fuzzy(query, item.keywords);
    return r ? { item, score: r.score } : null;
  }).filter((x): x is { item: SlashItem; score: number } => !!x);
  if (!items.length) return null;
  if (query) items.sort((a, b) => b.score - a.score);
  const options: SlashCompletion[] = items.map(({ item }, i) => ({
    label: item.title,
    detail: item.hint,
    item,
    apply: applyItem(item),
    section: query ? undefined : SECTIONS[item.section],
    boost: query ? 100 - i : undefined,
  }));
  return { from: match.from, to: context.pos, options, filter: false };
}

export function slashCommands() {
  return autocompletion({
    override: [slashSource],
    icons: false,
    closeOnBlur: true,
    maxRenderedOptions: 40,
    tooltipClass: () => "slash-menu",
    optionClass: () => "slash-option",
    addToOptions: [
      {
        position: 10,
        render: (completion) => {
          const el = document.createElement("span");
          el.className = "slash-icon";
          const item = (completion as SlashCompletion).item;
          if (item) el.innerHTML = iconSvg(item);
          return el;
        },
      },
    ],
  });
}
