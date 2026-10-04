import type { LucideIcon } from "lucide-react";
import {
  AudioLines,
  Briefcase,
  CircleHelp,
  Expand,
  Feather,
  Glasses,
  Heading,
  Languages,
  LayoutList,
  Lightbulb,
  List,
  ListChecks,
  ListTodo,
  ListTree,
  Megaphone,
  PenLine,
  Pilcrow,
  ScrollText,
  Shrink,
  Smile,
  SpellCheck2,
  Table,
  Tags,
  Telescope,
  TextQuote,
  Type,
  WandSparkles,
  Brush,
} from "lucide-react";
import type { ChatMessage } from "./engine";

/**
 * rewrite — replaces the target text (shown as a diff).
 * insert  — new text that lands somewhere in the document.
 * answer  — information for the writer; copied or inserted on request.
 * titles  — a short list of options the writer picks from.
 */
export type AiKind = "rewrite" | "insert" | "answer" | "titles";
export type AiScope = "selection" | "document" | "cursor";
/** Where document-level results land. */
export type Placement = "target" | "top" | "cursor" | "frontmatter";

export interface AiAction {
  id: string;
  label: string;
  /** Shorter label for the result card header. */
  verb?: string;
  group: string;
  icon: LucideIcon;
  scope: AiScope;
  kind: AiKind;
  task: string;
  keywords?: string;
  /** Submenu this action lives in. */
  parent?: string;
  placement?: Placement;
  /** Check that links, code and images survive the edit. */
  preserve?: boolean;
  maxTokens?: number;
  /** Compact models do poorly at this; hint toward a larger tier. */
  demanding?: boolean;
}

export interface AiSubmenu {
  id: string;
  label: string;
  group: string;
  icon: LucideIcon;
  keywords?: string;
}

const KEEP = "Keep every Markdown link, image, **bold**, _italic_ and `code` span from the original.";

const TONES: [string, string, string][] = [
  ["professional", "Professional", "polished, professional"],
  ["friendly", "Friendly", "warm, friendly"],
  ["confident", "Confident", "confident, assertive"],
  ["casual", "Casual", "relaxed, casual"],
  ["direct", "Direct", "direct, no-nonsense"],
];

const LANGUAGES = ["English", "Danish", "German", "French", "Spanish", "Swedish", "Norwegian", "Dutch", "Italian", "Portuguese", "Japanese", "Chinese"];

export const SUBMENUS: AiSubmenu[] = [
  { id: "tone", label: "Change tone", group: "Edit", icon: AudioLines, keywords: "voice style formal" },
  { id: "translate", label: "Translate", group: "Edit", icon: Languages, keywords: "language" },
];

export const SELECTION_ACTIONS: AiAction[] = [
  { id: "improve", label: "Improve writing", group: "Edit", icon: WandSparkles, scope: "selection", kind: "rewrite", preserve: true, keywords: "better polish rewrite clarity", task: `Improve the writing: make it clearer and more polished while keeping the meaning, tone and length roughly the same. ${KEEP}` },
  { id: "proofread", label: "Fix spelling & grammar", verb: "Proofread", group: "Edit", icon: SpellCheck2, scope: "selection", kind: "rewrite", preserve: true, keywords: "proofread typos punctuation correct", task: `Fix spelling, grammar and punctuation. Change as little as possible. ${KEEP}` },
  { id: "shorten", label: "Make shorter", group: "Edit", icon: Shrink, scope: "selection", kind: "rewrite", keywords: "concise condense trim brief", task: "Make this shorter — about half the length — keeping the key points. Keep Markdown links that matter." },
  { id: "expand", label: "Make longer", group: "Edit", icon: Expand, scope: "selection", kind: "rewrite", preserve: true, demanding: true, keywords: "elaborate expand detail", task: `Expand this with more detail and explanation, about twice as long. Don't invent facts, figures or names. ${KEEP}` },
  { id: "simplify", label: "Simplify language", group: "Edit", icon: Feather, scope: "selection", kind: "rewrite", preserve: true, keywords: "plain easy readable simple", task: `Rewrite this in plain, simple language that anyone can understand. Use short sentences. ${KEEP}` },
  ...TONES.map(
    ([id, label, desc]): AiAction => ({
      id: `tone-${id}`,
      label,
      verb: `${label} tone`,
      group: "Tone",
      parent: "tone",
      icon: id === "professional" ? Briefcase : id === "friendly" ? Smile : id === "confident" ? Megaphone : id === "casual" ? AudioLines : Glasses,
      scope: "selection",
      kind: "rewrite",
      preserve: true,
      keywords: `tone ${id}`,
      task: `Rewrite this in a more ${desc} tone. Keep the meaning. ${KEEP}`,
    }),
  ),
  ...LANGUAGES.map(
    (lang): AiAction => ({
      id: `translate-${lang.toLowerCase()}`,
      label: lang,
      verb: `Translate to ${lang}`,
      group: "Translate",
      parent: "translate",
      icon: Languages,
      scope: "selection",
      kind: "rewrite",
      preserve: true,
      keywords: `translate ${lang}`,
      task: `Translate this into ${lang}. Keep all Markdown formatting, links and code unchanged.`,
    }),
  ),
  { id: "bullets", label: "Turn into bullet list", verb: "Bullet list", group: "Transform", icon: List, scope: "selection", kind: "rewrite", keywords: "list points ul summarise", task: "Turn this into a concise bulleted list. Use '- ' for each bullet. Keep links." },
  { id: "prose", label: "Turn into paragraph", verb: "Paragraph", group: "Transform", icon: Pilcrow, scope: "selection", kind: "rewrite", demanding: true, keywords: "prose flowing sentences", task: "Turn this into one flowing paragraph of prose. Use only the information given — add nothing new." },
  { id: "checklist", label: "Turn into checklist", verb: "Checklist", group: "Transform", icon: ListChecks, scope: "selection", kind: "rewrite", keywords: "todo tasks checkbox", task: "Turn this into a Markdown task list where each line starts with '- [ ] '. One task per line, short and actionable." },
  { id: "table", label: "Turn into table", verb: "Table", group: "Transform", icon: Table, scope: "selection", kind: "rewrite", demanding: true, keywords: "grid columns rows", task: "Turn this into a Markdown table with a header row. Choose sensible columns. Reply with only the table." },
  { id: "tidy", label: "Tidy Markdown", group: "Transform", icon: Brush, scope: "selection", kind: "rewrite", preserve: true, keywords: "format clean fix repair markdown syntax", task: "Clean up the Markdown formatting: fix broken lists, headings, emphasis, links and spacing. Do not change the wording." },
  { id: "continue-sel", label: "Continue writing", verb: "Continue", group: "Write", icon: PenLine, scope: "selection", kind: "insert", keywords: "next more extend", task: "Continue writing from where this text stops. Write one or two new paragraphs that follow naturally, in the same style and language. Reply with only the new text — do not repeat the given text." },
  { id: "heading", label: "Suggest a heading", verb: "Heading", group: "Write", icon: Heading, scope: "selection", kind: "insert", keywords: "title name section", maxTokens: 40, task: "Write one short, specific heading (3–7 words) for this section. Reply with only the heading text, no # and no quotes." },
  { id: "summarize-sel", label: "Summarize", group: "Write", icon: ScrollText, scope: "selection", kind: "answer", keywords: "tldr summary gist", task: "Summarize this in 1–3 sentences." },
  { id: "explain", label: "Explain", group: "Write", icon: CircleHelp, scope: "selection", kind: "answer", keywords: "meaning what why understand", task: "Explain what this means in plain language, in 2–4 sentences." },
  { id: "actions-sel", label: "Extract action items", verb: "Action items", group: "Write", icon: ListTodo, scope: "selection", kind: "answer", keywords: "todo tasks next steps", task: "List every action item in this text as a Markdown task list. Format each line exactly like: - [ ] Do the thing (Owner, deadline). Leave out owner or deadline when not mentioned. If there are none, reply with: No action items found." },
];

export const DOCUMENT_ACTIONS: AiAction[] = [
  { id: "continue", label: "Continue writing", verb: "Continue", group: "Write", icon: PenLine, scope: "cursor", kind: "insert", placement: "cursor", keywords: "next more draft", task: "Continue writing the document from where it stops (marked ⟨here⟩). Write one or two new paragraphs — or more list items if it stops in a list — that follow naturally, matching the style and language. Reply with only the new text. Do not repeat anything already written." },
  { id: "summarize", label: "Summarize document", verb: "Summary", group: "Document", icon: ScrollText, scope: "document", kind: "insert", placement: "top", keywords: "tldr summary abstract overview", task: "Write a 2–3 sentence summary of this document. Reply with only the summary." },
  { id: "titles", label: "Suggest titles", verb: "Titles", group: "Document", icon: Type, scope: "document", kind: "titles", keywords: "name heading h1 title", maxTokens: 160, task: "Suggest 5 short, specific titles for this document. Reply with a Markdown bulleted list only." },
  { id: "key-points", label: "Extract key points", verb: "Key points", group: "Document", icon: TextQuote, scope: "document", kind: "answer", keywords: "highlights takeaways main ideas", task: "List the 3–7 most important points of this document as a short Markdown bulleted list." },
  { id: "actions", label: "Extract action items", verb: "Action items", group: "Document", icon: ListTodo, scope: "document", kind: "answer", keywords: "todo tasks next steps owners", task: "List every action item in this document as a Markdown task list. Format each line exactly like: - [ ] Do the thing (Owner, deadline). Leave out owner or deadline when not mentioned. If there are none, reply with: No action items found." },
  { id: "frontmatter", label: "Suggest tags & description", verb: "Metadata", group: "Document", icon: Tags, scope: "document", kind: "insert", placement: "frontmatter", keywords: "frontmatter metadata yaml keywords seo", maxTokens: 200, task: "Write YAML front matter for this document with exactly these keys: title, description (one sentence), tags (3–6 lowercase tags as a YAML list). Reply with only the YAML lines, without the --- fences." },
  { id: "outline", label: "Suggest next sections", verb: "Ideas", group: "Review", icon: Lightbulb, scope: "document", kind: "answer", demanding: true, keywords: "missing what to write next ideas gaps", task: "Suggest 3–5 sections or topics this document is missing or could cover next. For each, give a short heading and one sentence on what it should contain. Use a Markdown bulleted list." },
  { id: "review", label: "Review writing", verb: "Review", group: "Review", icon: Telescope, scope: "document", kind: "answer", demanding: true, keywords: "feedback unclear repetition tone critique", task: "Review this document as a careful editor. Point out up to 6 specific issues: unclear sentences, repetition, inconsistent tone or terminology. For each, quote the passage briefly and suggest a fix. Use a Markdown bulleted list. If the writing is already clear, say so briefly." },
  { id: "structure", label: "Check structure & headings", verb: "Structure", group: "Review", icon: ListTree, scope: "document", kind: "answer", demanding: true, keywords: "organization hierarchy order sections reorganize", task: "Assess the structure of this document: heading hierarchy, section order, and whether any sections overlap or should be split or merged. Give up to 5 concrete suggestions as a Markdown bulleted list." },
  { id: "restructure", label: "Turn notes into a document", verb: "Structured", group: "Rewrite", icon: LayoutList, scope: "document", kind: "rewrite", placement: "target", demanding: true, keywords: "organize rough notes structure reformat", maxTokens: 2400, task: "Turn these rough notes into a well-structured Markdown document: add a title, group related points under clear headings, and use lists where they help. Keep all the information and the original language. Don't add new facts." },
  { id: "proofread-doc", label: "Fix spelling & grammar", verb: "Proofread", group: "Rewrite", icon: SpellCheck2, scope: "document", kind: "rewrite", placement: "target", preserve: true, keywords: "proofread typos whole document", maxTokens: 2400, task: `Fix spelling, grammar and punctuation throughout. Change as little as possible and keep all formatting, headings, lists, code and front matter exactly as they are. ${KEEP}` },
  { id: "tidy-doc", label: "Tidy Markdown", group: "Rewrite", icon: Brush, scope: "document", kind: "rewrite", placement: "target", preserve: true, keywords: "format clean fix repair markdown syntax whole", maxTokens: 2400, task: "Clean up the Markdown formatting of this document: consistent heading levels, list markers, spacing and emphasis; fix broken syntax. Do not change the wording." },
];

export const ALL_ACTIONS = [...SELECTION_ACTIONS, ...DOCUMENT_ACTIONS];
export const actionById = new Map(ALL_ACTIONS.map((a) => [a.id, a]));

const SYSTEM_EDIT = `You are the writing assistant inside Margin, a Markdown editor. You work directly on the user's text.
Rules:
- Reply with the result only. No preamble, no explanation, no closing remarks, no surrounding quotes or code fences.
- Write valid Markdown. Keep links, images, inline code, code blocks and math exactly as they are. Keep headings, list markers and checkboxes unless the task is to change the structure.
- Reply in the same language as the text unless the task says otherwise. Keep the author's voice.
- Never invent facts, names, numbers, quotes or links.`;

const SYSTEM_ANSWER = `You are the writing assistant inside Margin, a Markdown editor. You help the writer understand and improve their document.
Rules:
- Be clear, specific and brief. Use Markdown lists where they help.
- Base everything on the given text. Never invent facts. If the text doesn't contain the answer, say so.
- Reply in the same language as the text unless asked otherwise.`;

/** Rough budget so prompts fit in the 16k-token context with room to reply. */
export const MAX_DOC_CHARS = 36000;

export interface ActionContext {
  text: string;
  /** For cursor actions: text before the caret. */
  before?: string;
  after?: string;
  title?: string;
}

export function buildMessages(action: AiAction, ctx: ActionContext): ChatMessage[] {
  let system = action.kind === "answer" || action.kind === "titles" ? SYSTEM_ANSWER : SYSTEM_EDIT;
  if (action.kind === "answer" && action.scope === "selection" && ctx.title) system += `\nThe text comes from a document titled “${ctx.title}”.`;
  let user: string;
  if (action.scope === "cursor") {
    const before = (ctx.before ?? "").slice(-8000);
    const after = (ctx.after ?? "").slice(0, 1500);
    user = `<document>\n${before}⟨here⟩${after}\n</document>\n\nTask: ${action.task}`;
  } else if (action.scope === "document") {
    user = `<document>\n${ctx.text.slice(0, MAX_DOC_CHARS)}\n</document>\n\nTask: ${action.task}`;
  } else {
    user = `<text>\n${ctx.text}\n</text>\n\nTask: ${action.task}`;
  }
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const QUESTION = /\?\s*$|^(what|why|how|who|when|where|which|is|are|does|do|can|could|should|explain|tell me|summari[sz]e|list|find|give me)\b/i;

/** A free-form instruction typed by the writer. */
export function customAction(instruction: string, scope: AiScope): AiAction {
  const answer = scope !== "selection" || QUESTION.test(instruction.trim());
  return {
    id: "custom",
    label: instruction,
    verb: instruction.length > 48 ? instruction.slice(0, 46).trimEnd() + "…" : instruction,
    group: "Custom",
    icon: WandSparkles,
    scope: scope === "cursor" ? "document" : scope,
    kind: answer ? "answer" : "rewrite",
    placement: answer ? "cursor" : "target",
    preserve: !answer,
    task: answer ? instruction : `${instruction}\n(Reply with only the rewritten text.)`,
  };
}

/** Cleans up the typical small-model wrappers around an answer. */
export function cleanOutput(raw: string, original: string, kind: AiKind): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^<think>[\s\S]*$/, "");
  s = s.replace(/^\s*<\/?(text|document)>\s*$/gm, "");
  s = s.replace(/^\s*\(?from the document\b[^\n]*\n/i, "");
  s = s.trim();
  const fence = /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i.exec(s);
  if (fence && !original.trimStart().startsWith("```")) s = fence[1].trim();
  s = s.replace(/^(?:sure|certainly|of course|here(?:'s| is| are)\b)[^\n]*:\s*\n+/i, "");
  if (kind !== "answer" && /^["“].*["”]$/s.test(s) && !/^["“]/.test(original.trim())) s = s.slice(1, -1).trim();
  return s;
}

const URL_RE = /\]\(([^)\s]+)[^)]*\)|<(https?:\/\/[^>]+)>/g;
const CODE_RE = /`[^`\n]+`/g;

/** Markdown that was in the original but is missing from the result. */
export function preservationWarnings(original: string, result: string): string[] {
  const out: string[] = [];
  const urls = [...original.matchAll(URL_RE)].map((m) => m[1] ?? m[2]);
  const lost = urls.filter((u) => !result.includes(u));
  if (lost.length) out.push(lost.length === 1 ? "A link from the original is missing" : `${lost.length} links from the original are missing`);
  const codes = original.match(CODE_RE) ?? [];
  const lostCode = codes.filter((c) => !result.includes(c));
  if (lostCode.length) out.push(lostCode.length === 1 ? "An inline code span changed" : `${lostCode.length} inline code spans changed`);
  const fences = (original.match(/^\s*```/gm) ?? []).length;
  if (fences && (result.match(/^\s*```/gm) ?? []).length < fences) out.push("A code block changed");
  return out;
}

export function parseTitles(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").replace(/^\*\*(.*)\*\*$/, "$1").replace(/^["“](.*)["”]$/, "$1").replace(/^#+\s*/, "").trim())
    .filter((l) => l && l.length < 120)
    .slice(0, 6);
}
