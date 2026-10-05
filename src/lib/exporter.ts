import proseCss from "../styles/prose.css?raw";
import { escapeHtml, renderMarkdown } from "./markdown";
import { renderMermaid } from "./mermaid";
import { getState } from "../state/store";

const EXPORT_FONTS = {
  serif: `"Newsreader", "Iowan Old Style", "Palatino Linotype", Georgia, serif`,
  sans: `"Inter", "Segoe UI", -apple-system, system-ui, sans-serif`,
  mono: `"JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace`,
};

const EXPORT_VARS = `
:root {
  --text: #1f1e1b; --text-2: #5e5b54; --text-3: #8f8b82; --text-4: #b5b1a8;
  --line: rgba(30,25,15,.09); --line-strong: rgba(30,25,15,.16);
  --surface-1: #faf9f6; --surface-2: #f3f1ec; --sheet: #ffffff;
  --accent: #b06a08; --accent-soft: rgba(176,106,8,.12);
  --accent-fill: #f0a830; --on-accent-fill: #1f1e1b;
  --code-bg: #f4f2ed;
  --font-ui: "Inter", "Segoe UI", -apple-system, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", ui-monospace, Consolas, monospace;
  --writing-size: 18px; --writing-lh: 1.7;
  --tok-keyword: #a2410f; --tok-string: #3f7d58; --tok-number: #8e4ec6; --tok-comment: #9a968c;
  --tok-function: #1e6fa8; --tok-type: #9a6a00; --tok-property: #5e5b54; --tok-tag: #b4432b;
}
html { background: #fff; }
body { margin: 0; padding: 64px 24px 96px; color: var(--text); }
.prose { max-width: 70ch; margin: 0 auto; }
@media print { body { padding: 0; } }
`;

/** Renders Markdown to HTML with Mermaid diagrams resolved to inline SVG. */
export async function renderForOutput(content: string, opts: { forExport: boolean; baseDir: string | null; dark?: boolean }): Promise<string> {
  const html = renderMarkdown(content, { forExport: opts.forExport, baseDir: opts.baseDir });
  if (!html.includes("mermaid-block")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const block of tpl.content.querySelectorAll<HTMLElement>(".mermaid-block")) {
    const code = block.querySelector(".mermaid-src")?.textContent ?? "";
    const r = await renderMermaid(code, !!opts.dark);
    if (r.svg) block.innerHTML = r.svg;
  }
  return tpl.innerHTML;
}

export async function buildStandaloneHtml(content: string, title: string, baseDir: string | null): Promise<string> {
  const body = await renderForOutput(content, { forExport: true, baseDir });
  const katex = body.includes('class="katex')
    ? `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css">\n`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="AmberText">
<title>${escapeHtml(title)}</title>
${katex}<style>${EXPORT_VARS}
:root { --font-writing: ${EXPORT_FONTS[getState().settings.font]}; }
${proseCss}</style>
</head>
<body>
<article class="prose">
${body}
</article>
</body>
</html>
`;
}

export async function copyRichText(content: string, baseDir: string | null) {
  const html = await renderForOutput(content, { forExport: true, baseDir });
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([content], { type: "text/plain" }),
  });
  await navigator.clipboard.write([item]);
}
