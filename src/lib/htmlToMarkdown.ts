import TurndownService from "turndown";
import { gfm } from "@joplin/turndown-plugin-gfm";

/** Tags worth converting; HTML without any of them pastes as plain text. */
const MEANINGFUL = /<(h[1-6]|strong|b|em|i|a\s|ul|ol|li|table|pre|blockquote|img|hr|del|s|code)\b|font-weight:\s*(bold|[6-9]00)|font-style:\s*italic/i;

/** HTML copied from code editors (VS Code, Xcode, our own editor) is styled spans, not prose. */
const FROM_CODE_EDITOR = /<meta[^>]+vscode|class="cm-line|white-space:\s*pre[^"]*"[^>]*><(div|span)/i;

export function isConvertibleHtml(html: string): boolean {
  return MEANINGFUL.test(html) && !FROM_CODE_EDITOR.test(html);
}

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
    strongDelimiter: "**",
    hr: "---",
    linkStyle: "inlined",
  });
  td.use(gfm);
  td.remove(["style", "script", "meta", "title", "head", "noscript"]);

  // Google Docs wraps the whole selection in a "bold" tag that isn't bold.
  td.addRule("gdocsWrapper", {
    filter: (n) => n.nodeName === "B" && /^docs-internal-guid/.test((n as HTMLElement).id),
    replacement: (content) => content,
  });
  // Google Docs and Word express emphasis with inline styles.
  td.addRule("styledStrong", {
    filter: (n) => n.nodeName === "SPAN" && /font-weight:\s*(bold|[6-9]00)/i.test((n as HTMLElement).getAttribute("style") ?? ""),
    replacement: (content) => (content.trim() ? wrap(content, "**") : content),
  });
  td.addRule("styledEm", {
    filter: (n) => n.nodeName === "SPAN" && /font-style:\s*italic/i.test((n as HTMLElement).getAttribute("style") ?? ""),
    replacement: (content) => (content.trim() ? wrap(content, "_") : content),
  });
  // Inline images as data URLs bloat the file; pasted image files are handled separately.
  td.addRule("dataImages", {
    filter: (n) => n.nodeName === "IMG" && /^data:/i.test((n as HTMLElement).getAttribute("src") ?? ""),
    replacement: () => "",
  });
  // Single space after list markers, matching what the editor itself inserts.
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node, options) => {
      content = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n  ");
      const parent = node.parentNode as HTMLElement | null;
      let prefix = `${options.bulletListMarker} `;
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? 1);
        prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
      }
      const task = /^\[[ xX]\]\s/.test(content);
      if (task) prefix = `${options.bulletListMarker} `;
      return prefix + content + (node.nextSibling && !/\n$/.test(content) ? "\n" : "");
    },
  });
  service = td;
  return td;
}

function wrap(content: string, marker: string) {
  const lead = /^\s*/.exec(content)![0];
  const trail = /\s*$/.exec(content)![0];
  return `${lead}${marker}${content.trim()}${marker}${trail}`;
}

export function htmlToMarkdown(html: string): string {
  const body = html.replace(/<!--(?:StartFragment|EndFragment)-->/g, "");
  return turndown()
    .turndown(body)
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
