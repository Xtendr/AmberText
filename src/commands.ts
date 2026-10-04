import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { bridge } from "./editor/bridge";
import { insertBlock, insertLink, setHeading, toggleInline, toggleLinePrefix } from "./editor/commands";
import { requestReplace } from "./editor/FindPanel";
import { buildStandaloneHtml, copyRichText, renderForOutput } from "./lib/exporter";
import { basename, dirname, sanitizeFileName } from "./lib/paths";
import { dialogs, fileManagerName, fsApi, isMac, printPage } from "./lib/platform";
import {
  adjustFontSize,
  closeActive,
  closeFolder,
  cycleTab,
  cycleTheme,
  displayName,
  insertImageFiles,
  newDoc,
  openFileDialog,
  openFolderDialog,
  openWelcome,
  pickImages,
  saveActive,
  saveActiveAs,
  setViewMode,
  setWordGoal,
  showSidebarTab,
  toast,
  toggleSidebar,
  toggleZen,
} from "./state/actions";
import { activeDoc, getState, setState } from "./state/store";
import { extractHeadings } from "./lib/text";
import { slugify } from "./lib/markdown";
import { DOCUMENT_ACTIONS } from "./ai/actions";
import { openAiMenu, runAction } from "./ai/session";

export interface Command {
  id: string;
  title: string;
  group: "AI" | "File" | "View" | "Format" | "Insert" | "Edit" | "Help" | "Appearance";
  keys?: string;
  /** Needs an open document. */
  doc?: boolean;
  /** Needs the editor (write/split). */
  editor?: boolean;
  /** Not shown in the palette (e.g. raw shortcuts). */
  hidden?: boolean;
  keywords?: string;
  run: () => unknown;
}

const withView = (fn: (v: NonNullable<typeof bridge.view>) => unknown) => () => {
  const v = bridge.view;
  if (!v || !bridge.viewDocId) return;
  if (getState().settings.viewMode === "read") setViewMode("write");
  fn(v);
};

function docTitle() {
  const doc = activeDoc();
  return doc ? displayName(doc) : "Untitled";
}

async function exportHtml() {
  const doc = activeDoc();
  if (!doc) return;
  const title = docTitle();
  const html = await buildStandaloneHtml(doc.content, title, doc.path ? dirname(doc.path) : null);
  const suggested = doc.path ? doc.path.replace(/\.[^.\\/]+$/, "") + ".html" : `${sanitizeFileName(title) || "Untitled"}.html`;
  const path = await dialogs.saveFile(suggested, "html");
  if (!path) return;
  try {
    await fsApi.writeText(path, html);
    toast(`Exported “${basename(path)}”`, "success", { label: `Show in ${fileManagerName}`, run: () => void fsApi.reveal(path) });
  } catch (e) {
    toast(`Export failed — ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function exportPdf() {
  const doc = activeDoc();
  if (!doc) return;
  const root = document.getElementById("print-root");
  if (!root) return;
  root.innerHTML = `<article class="prose">${await renderForOutput(doc.content, { forExport: false, baseDir: doc.path ? dirname(doc.path) : null })}</article>`;
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
  const prev = document.title;
  document.title = docTitle();
  try {
    await printPage();
  } finally {
    document.title = prev;
  }
}

async function copyHtml() {
  const doc = activeDoc();
  if (!doc) return;
  try {
    await copyRichText(doc.content, doc.path ? dirname(doc.path) : null);
    toast("Copied as rich text — paste into email, docs or slides", "success");
  } catch {
    toast("Couldn't access the clipboard", "error");
  }
}

function toggleSetting(key: "focusMode" | "typewriter" | "livePreview" | "spellcheck" | "autosave", label: string) {
  return () => {
    const s = getState();
    const next = !s.settings[key];
    s.setSettings({ [key]: next });
    toast(`${label} ${next ? "on" : "off"}`);
  };
}

function insertToc() {
  const v = bridge.view;
  const doc = activeDoc();
  if (!v || !doc) return;
  const all = extractHeadings(v.state.doc.toString());
  // A lone H1 is the document title, not a section.
  const hs = all.filter((h) => h.level === 1).length <= 1 ? all.filter((h) => h.level > 1) : all;
  if (!hs.length) {
    toast("Add a few headings first — the contents are built from them");
    return;
  }
  const min = Math.min(...hs.map((h) => h.level));
  const lines = hs.map((h) => `${"  ".repeat(h.level - min)}- [${h.text}](#${slugify(h.text)})`);
  withView((view) => insertBlock(view, `**Contents**\n\n${lines.join("\n")}\n‸`))();
}

const AI_COMMANDS: Command[] = [
  { id: "ask-ai", title: "Ask AI…", group: "AI", keys: "Mod+J", doc: true, keywords: "assistant intelligence write edit", run: () => openAiMenu() },
  ...DOCUMENT_ACTIONS.map(
    (a): Command => ({
      id: `ai-${a.id}`,
      title: a.label,
      group: "AI",
      doc: true,
      editor: true,
      keywords: `ai ${a.keywords ?? ""}`,
      run: () => runAction(a),
    }),
  ),
  { id: "ai-settings", title: "AI models & privacy", group: "AI", keywords: "local model download qwen ollama settings", run: () => setState({ settingsOpen: true, settingsSection: "ai" }) },
];

export const COMMANDS: Command[] = [
  ...AI_COMMANDS,
  // File
  { id: "new", title: "New document", group: "File", keys: "Mod+N", run: () => void newDoc() },
  { id: "open", title: "Open file…", group: "File", keys: "Mod+O", run: openFileDialog },
  { id: "open-folder", title: "Open folder…", group: "File", keys: "Mod+Shift+O", run: openFolderDialog },
  { id: "quick-open", title: "Go to file…", group: "File", keys: "Mod+P", run: () => setState({ palette: "files" }) },
  { id: "save", title: "Save", group: "File", keys: "Mod+S", doc: true, run: saveActive },
  { id: "save-as", title: "Save as…", group: "File", keys: "Mod+Shift+S", doc: true, run: saveActiveAs },
  { id: "close-tab", title: "Close tab", group: "File", keys: "Mod+W", doc: true, run: closeActive },
  { id: "export-html", title: "Export as HTML…", group: "File", doc: true, keywords: "web publish", run: exportHtml },
  { id: "export-pdf", title: "Export as PDF / Print…", group: "File", keys: "Mod+Shift+E", doc: true, keywords: "print pdf", run: exportPdf },
  { id: "copy-html", title: "Copy as rich text", group: "File", keys: "Mod+Shift+C", doc: true, keywords: "clipboard html email", run: copyHtml },
  {
    id: "reveal",
    title: `Reveal in ${fileManagerName}`,
    group: "File",
    doc: true,
    run: () => {
      const p = activeDoc()?.path;
      if (p) void fsApi.reveal(p);
      else toast("This draft hasn't been saved yet");
    },
  },
  { id: "close-folder", title: "Close folder", group: "File", run: closeFolder },
  { id: "next-tab", title: "Next tab", group: "View", keys: "Ctrl+Tab", run: () => cycleTab(1) },
  { id: "prev-tab", title: "Previous tab", group: "View", keys: "Ctrl+Shift+Tab", run: () => cycleTab(-1) },

  // View
  { id: "mode-write", title: "Write mode", group: "View", keys: "Mod+1", run: () => setViewMode("write") },
  { id: "mode-split", title: "Split mode", group: "View", keys: "Mod+2", keywords: "preview side by side", run: () => setViewMode("split") },
  { id: "mode-read", title: "Read mode", group: "View", keys: "Mod+3", keywords: "preview", run: () => setViewMode("read") },
  { id: "toggle-sidebar", title: "Toggle sidebar", group: "View", keys: "Mod+\\", run: () => toggleSidebar() },
  { id: "show-files", title: "Show files", group: "View", keys: "Mod+Shift+1", run: () => showSidebarTab("files") },
  { id: "show-outline", title: "Show outline", group: "View", keys: "Mod+Shift+2", keywords: "headings toc", run: () => showSidebarTab("outline") },
  { id: "focus-mode", title: "Toggle focus mode", group: "View", keys: "Mod+Shift+F", keywords: "dim paragraph", run: toggleSetting("focusMode", "Focus mode") },
  { id: "typewriter", title: "Toggle typewriter scrolling", group: "View", keys: "Mod+Shift+T", run: toggleSetting("typewriter", "Typewriter scrolling") },
  { id: "zen", title: "Toggle zen mode", group: "View", keys: "Mod+Shift+Enter", keywords: "fullscreen distraction free", run: () => void toggleZen() },
  { id: "word-goal", title: "Set word goal…", group: "View", doc: true, keywords: "target count progress writing", run: () => void setWordGoal() },
  { id: "live-preview", title: "Toggle live preview", group: "View", keys: "Mod+Shift+M", keywords: "source raw markdown", run: toggleSetting("livePreview", "Live preview") },
  { id: "palette", title: "Command palette", group: "View", keys: "Mod+K", hidden: true, run: () => setState((s) => ({ palette: s.palette ? null : "commands" })) },
  { id: "palette-legacy", title: "Command palette", group: "View", keys: "Mod+Shift+P", hidden: true, run: () => setState({ palette: "commands" }) },
  { id: "goto-heading", title: "Go to heading…", group: "View", keys: "Mod+G", doc: true, keywords: "outline section jump", run: () => setState({ palette: "headings" }) },
  { id: "settings", title: "Settings", group: "Appearance", keys: "Mod+,", keywords: "preferences options", run: () => setState((s) => ({ settingsOpen: !s.settingsOpen })) },
  { id: "theme", title: "Cycle theme (system, light, dark)", group: "Appearance", keys: "Mod+Shift+L", keywords: "dark light mode", run: cycleTheme },
  { id: "font-bigger", title: "Increase text size", group: "Appearance", keys: "Mod+=", run: () => adjustFontSize(1) },
  { id: "font-smaller", title: "Decrease text size", group: "Appearance", keys: "Mod+-", run: () => adjustFontSize(-1) },
  { id: "font-serif", title: "Typeface: Serif", group: "Appearance", run: () => getState().setSettings({ font: "serif" }) },
  { id: "font-sans", title: "Typeface: Sans", group: "Appearance", run: () => getState().setSettings({ font: "sans" }) },
  { id: "font-mono", title: "Typeface: Mono", group: "Appearance", run: () => getState().setSettings({ font: "mono" }) },

  // Edit
  { id: "undo", title: "Undo", group: "Edit", hidden: true, run: () => (isTextField() ? document.execCommand("undo") : withView(undo)()) },
  { id: "redo", title: "Redo", group: "Edit", hidden: true, run: () => (isTextField() ? document.execCommand("redo") : withView(redo)()) },
  { id: "find", title: "Find", group: "Edit", keys: "Mod+F", editor: true, doc: true, run: withView((v) => openSearchPanel(v)) },
  {
    id: "replace",
    title: "Find and replace",
    group: "Edit",
    keys: isMac ? "Mod+Alt+F" : "Mod+H",
    editor: true,
    doc: true,
    run: withView((v) => {
      requestReplace();
      openSearchPanel(v);
    }),
  },

  // Format
  { id: "bold", title: "Bold", group: "Format", keys: "Mod+B", doc: true, run: withView((v) => toggleInline(v, "**")) },
  { id: "italic", title: "Italic", group: "Format", keys: "Mod+I", doc: true, run: withView((v) => toggleInline(v, "_")) },
  { id: "strike", title: "Strikethrough", group: "Format", keys: "Mod+Shift+X", doc: true, run: withView((v) => toggleInline(v, "~~")) },
  { id: "code", title: "Inline code", group: "Format", keys: "Mod+E", doc: true, run: withView((v) => toggleInline(v, "`")) },
  { id: "link", title: "Link", group: "Format", keys: "Mod+Shift+K", doc: true, run: withView(insertLink) },
  { id: "h1", title: "Heading 1", group: "Format", keys: "Mod+Alt+1", doc: true, run: withView((v) => setHeading(v, 1)) },
  { id: "h2", title: "Heading 2", group: "Format", keys: "Mod+Alt+2", doc: true, run: withView((v) => setHeading(v, 2)) },
  { id: "h3", title: "Heading 3", group: "Format", keys: "Mod+Alt+3", doc: true, run: withView((v) => setHeading(v, 3)) },
  { id: "paragraph", title: "Paragraph (remove heading)", group: "Format", keys: "Mod+Alt+0", doc: true, run: withView((v) => setHeading(v, 0)) },
  { id: "bullets", title: "Bulleted list", group: "Format", keys: "Mod+Shift+8", doc: true, run: withView((v) => toggleLinePrefix(v, "bullet")) },
  { id: "numbers", title: "Numbered list", group: "Format", keys: "Mod+Shift+7", doc: true, run: withView((v) => toggleLinePrefix(v, "ordered")) },
  { id: "tasks", title: "To-do list", group: "Format", keys: "Mod+Shift+9", doc: true, run: withView((v) => toggleLinePrefix(v, "task")) },
  { id: "quote", title: "Quote", group: "Format", keys: "Mod+Shift+.", doc: true, run: withView((v) => toggleLinePrefix(v, "quote")) },

  // Insert
  { id: "insert-table", title: "Insert table", group: "Insert", doc: true, run: withView((v) => insertBlock(v, "| ‸Column | Column |\n| --- | --- |\n|  |  |\n|  |  |")) },
  { id: "insert-code", title: "Insert code block", group: "Insert", doc: true, run: withView((v) => insertBlock(v, "```\n‸\n```")) },
  { id: "insert-math", title: "Insert math block", group: "Insert", doc: true, keywords: "katex latex equation", run: withView((v) => insertBlock(v, "$$\n‸\n$$")) },
  {
    id: "insert-diagram",
    title: "Insert diagram (Mermaid)",
    group: "Insert",
    doc: true,
    keywords: "flowchart chart",
    run: withView((v) => insertBlock(v, "```mermaid\nflowchart LR\n  A[Start‸] --> B[Finish]\n```")),
  },
  { id: "insert-callout", title: "Insert callout", group: "Insert", doc: true, keywords: "note tip warning admonition", run: withView((v) => insertBlock(v, "> [!NOTE]\n> ‸")) },
  { id: "insert-hr", title: "Insert divider", group: "Insert", doc: true, keywords: "horizontal rule", run: withView((v) => insertBlock(v, "---\n‸")) },
  { id: "insert-toc", title: "Insert table of contents", group: "Insert", doc: true, keywords: "toc outline headings contents", run: insertToc },
  {
    id: "insert-image",
    title: "Insert image from file…",
    group: "Insert",
    doc: true,
    run: withView(async (v) => {
      const paths = await pickImages();
      if (paths.length) await insertImageFiles(v, paths);
    }),
  },
  {
    id: "insert-date",
    title: "Insert today's date",
    group: "Insert",
    doc: true,
    run: withView((v) => {
      const text = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
    }),
  },

  // Help
  { id: "welcome", title: "Open the welcome guide", group: "Help", keywords: "help tutorial docs", run: openWelcome },
  { id: "shortcuts", title: "Keyboard shortcuts", group: "Help", keywords: "keys hotkeys", run: () => setState({ settingsOpen: true }) },
];

function isTextField() {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && !el.closest(".cm-editor");
}

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

export function runCommand(id: string) {
  const cmd = commandById.get(id);
  if (!cmd) return;
  if (cmd.doc && !activeDoc()) return;
  void cmd.run();
}

/* ------------------------------------------------------------------ */
/* Keyboard handling                                                   */
/* ------------------------------------------------------------------ */

const CODE_KEYS: Record<string, string> = {
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Semicolon: ";",
  Quote: "'",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
  NumpadAdd: "=",
  NumpadSubtract: "-",
};

export function eventCombo(e: KeyboardEvent): string {
  // Letters follow the active layout (AZERTY, Dvorak); physical codes are only the fallback
  // for non-Latin layouts and Option-modified characters.
  let key = /^[a-z]$/i.test(e.key)
    ? e.key
    : e.code.startsWith("Key")
      ? e.code.slice(3)
      : e.code.startsWith("Digit")
        ? e.code.slice(5)
        : (CODE_KEYS[e.code] ?? e.key);
  if (key.length === 1) key = key.toUpperCase();
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push("Mod");
  if (isMac && e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** Commands whose shortcuts the editor already owns while it has focus. */
const EDITOR_OWNED = new Set(["bold", "italic", "strike", "code", "link", "h1", "h2", "h3", "paragraph", "bullets", "numbers", "tasks", "quote", "find", "undo", "redo"]);

const comboMap = new Map<string, Command>();
for (const c of COMMANDS) {
  if (!c.keys) continue;
  const normalized = c.keys.replace(/^Ctrl\+/, isMac ? "Ctrl+" : "Mod+");
  if (!comboMap.has(normalized)) comboMap.set(normalized, c);
}
export function handleGlobalKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return false;
  const combo = eventCombo(e);
  const cmd = comboMap.get(combo);
  if (!cmd) return false;
  const inEditor = !!(e.target as HTMLElement)?.closest?.(".cm-editor");
  if (EDITOR_OWNED.has(cmd.id) && (inEditor || isTextField())) return false;
  if (cmd.doc && !activeDoc()) return false;
  e.preventDefault();
  void cmd.run();
  return true;
}

/** Human-readable shortcut label for the current platform. */
export function formatKeys(keys: string | undefined): string[] {
  if (!keys) return [];
  return keys.split("+").map((k) => {
    switch (k) {
      case "Mod":
        return isMac ? "⌘" : "Ctrl";
      case "Shift":
        return isMac ? "⇧" : "Shift";
      case "Alt":
        return isMac ? "⌥" : "Alt";
      case "Ctrl":
        return isMac ? "⌃" : "Ctrl";
      case "Enter":
        return "↵";
      case "Tab":
        return "Tab";
      case "Escape":
        return "Esc";
      default:
        return k;
    }
  });
}

/** macOS menu-bar item ids → command ids. */
export const MENU_TO_COMMAND: Record<string, string> = {
  settings: "settings",
  new: "new",
  open: "open",
  "open-folder": "open-folder",
  "close-folder": "close-folder",
  "quick-open": "quick-open",
  save: "save",
  "save-as": "save-as",
  "export-html": "export-html",
  "export-pdf": "export-pdf",
  "close-tab": "close-tab",
  undo: "undo",
  redo: "redo",
  find: "find",
  replace: "replace",
  "mode-write": "mode-write",
  "mode-split": "mode-split",
  "mode-read": "mode-read",
  "toggle-sidebar": "toggle-sidebar",
  "focus-mode": "focus-mode",
  typewriter: "typewriter",
  zen: "zen",
  palette: "palette",
  ai: "ask-ai",
};
