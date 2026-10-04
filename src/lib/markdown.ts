import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import katexPlugin from "@vscode/markdown-it-katex";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { fileSrc } from "./platform";
import { isExternalUrl, resolvePath } from "./paths";

export interface RenderEnv {
  baseDir?: string | null;
  forExport?: boolean;
  [key: string | symbol]: unknown;
}

const CALLOUTS: Record<string, string> = {
  NOTE: "Note",
  TIP: "Tip",
  IMPORTANT: "Important",
  WARNING: "Warning",
  CAUTION: "Caution",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function highlight(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(code);
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: false });

md.renderer.rules.fence = (tokens, idx, _opts, renderEnv) => {
  const env = renderEnv as RenderEnv | undefined;
  const token = tokens[idx];
  const info = token.info.trim();
  const lang = info.split(/\s+/)[0]?.toLowerCase() ?? "";
  const line = token.map ? ` data-line="${token.map[0]}"` : "";
  if (lang === "mermaid") {
    return `<div class="mermaid-block"${line}><pre class="mermaid-src">${escapeHtml(token.content)}</pre></div>`;
  }
  const head = env?.forExport
    ? ""
    : `<div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span><button class="code-copy" type="button">Copy</button></div>`;
  return `<div class="code-block"${line}>${head}<pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ""}">${highlight(token.content, lang)}</code></pre></div>`;
};

md.renderer.rules.image = (tokens, idx, opts, renderEnv, self) => {
  const env = renderEnv as RenderEnv | undefined;
  const token = tokens[idx];
  const src = String(token.attrGet("src") ?? "");
  if (!env?.forExport && env?.baseDir && src && !isExternalUrl(src) && !src.startsWith("data:")) {
    token.attrSet("src", fileSrc(resolvePath(env.baseDir, src)));
  }
  token.attrSet("loading", "lazy");
  token.attrSet("alt", self.renderInlineAsText(token.children ?? [], opts, env));
  return self.renderToken(tokens, idx, opts);
};

/** Tags block tokens with their source line so the preview can follow the editor. */
md.core.ruler.push("source_lines", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.block && token.nesting !== -1 && token.type !== "fence") {
      token.attrSet("data-line", String(token.map[0]));
    }
  }
});

/** GitHub-style task lists: `- [ ] item` / `- [x] item`. */
md.core.ruler.before("inline", "task_lists", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX])\](?=\s|$)\s*/.exec(t.content);
    if (!m) continue;
    const checked = m[1] !== " ";
    const line = t.map ? t.map[0] : tokens[i - 2].map?.[0] ?? 0;
    t.content = `<input type="checkbox" class="task-check" data-line="${line}"${checked ? " checked" : ""}> ` + t.content.slice(m[0].length);
    tokens[i - 2].attrJoin("class", checked ? "task-item done" : "task-item");
    for (let j = i - 3; j >= 0; j--) {
      const open = tokens[j];
      if ((open.type === "bullet_list_open" || open.type === "ordered_list_open") && open.level === tokens[i - 2].level - 1) {
        open.attrJoin("class", "task-list");
        break;
      }
    }
  }
});

/** GitHub alerts: `> [!NOTE]` blockquotes become callouts. */
md.core.ruler.before("inline", "callouts", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type !== "blockquote_open") continue;
    const p = tokens[i + 1];
    const inline = tokens[i + 2];
    if (p.type !== "paragraph_open" || inline.type !== "inline") continue;
    const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][+-]?[ \t]*([^\n]*)\n?/i.exec(inline.content);
    if (!m) continue;
    const kind = m[1].toUpperCase();
    const title = m[2].trim() || CALLOUTS[kind];
    tokens[i].attrJoin("class", `callout callout-${kind.toLowerCase()}`);
    inline.content = inline.content.slice(m[0].length);
    const titleToken = new state.Token("html_block", "", 0);
    titleToken.content = `<div class="callout-title">${escapeHtml(title)}</div>`;
    tokens.splice(i + 1, 0, titleToken);
    if (!inline.content.trim()) {
      p.hidden = true;
      tokens[i + 4].hidden = true;
    }
  }
});

/** Stable heading ids for in-document links. */
md.core.ruler.push("heading_ids", (state) => {
  const seen = new Map<string, number>();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading_open") continue;
    const inline = tokens[i + 1];
    const base = slugify(inline.children?.map((c) => c.content).join("") ?? inline.content) || "section";
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    tokens[i].attrSet("id", n ? `${base}-${n}` : base);
  }
});

md.use(footnote);
// CJS package: the dev server hands us the module object, the production build the function.
const katex = ((katexPlugin as unknown as { default?: typeof katexPlugin }).default ?? katexPlugin) as typeof katexPlugin;
md.use(katex, { enableFencedBlocks: true, throwOnError: false });

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\r?\n?/;

export function splitFrontmatter(src: string): { data: [string, string][]; body: string; lines: number } | null {
  const m = FRONTMATTER.exec(src);
  if (!m) return null;
  const data: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w.-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) data.push([kv[1], kv[2].replace(/^["']|["']$/g, "")]);
  }
  const lines = m[0].split("\n").length - 1;
  return { data, body: "\n".repeat(lines) + src.slice(m[0].length), lines };
}

let purifyConfigured = false;
function sanitize(html: string): string {
  if (!purifyConfigured) {
    DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "A") {
        const href = node.getAttribute("href") ?? "";
        if (/^\s*javascript:/i.test(href)) node.removeAttribute("href");
      }
    });
    purifyConfigured = true;
  }
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "loading"],
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
}

export function renderMarkdown(src: string, env: RenderEnv = {}): string {
  const fm = splitFrontmatter(src);
  let prefix = "";
  let body = src;
  if (fm) {
    body = fm.body;
    if (fm.data.length) {
      prefix =
        `<dl class="frontmatter">` +
        fm.data.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("") +
        `</dl>`;
    }
  }
  return sanitize(prefix + md.render(body, env));
}

/** Renders a fragment (e.g. a single table) for in-editor widgets. */
export function renderFragment(src: string, env: RenderEnv = {}): string {
  return sanitize(md.render(src, env));
}
