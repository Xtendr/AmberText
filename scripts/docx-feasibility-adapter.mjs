// Research only. No production dependency, command, filesystem or network access.
// The caller supplies the exact candidate API and explicitly selected fixture bytes.
export function buildFixtureDocument(api, tokens, assets, { direction = "ltr" } = {}) {
  const { Document, Paragraph, TextRun, Bookmark, InternalHyperlink, ExternalHyperlink,
    ImageRun, Table, TableRow, TableCell, HeadingLevel, LevelFormat, BorderStyle, WidthType } = api;
  if (!["ltr", "rtl"].includes(direction)) throw new Error("Unknown fixture direction");
  const warnings = [], numbering = [], anchors = new Map();
  const warn = (kind, token) => warnings.push({ kind, type: token.type, line: token.map?.[0] ?? null, content: token.content?.slice(0, 200) ?? "" });
  for (const token of tokens) if (token.type === "heading_open") {
    const id = token.attrs?.find(([name]) => name === "id")?.[1];
    if (id && !anchors.has(id)) anchors.set(id, `heading_${anchors.size + 1}`);
  }
  const attr = (token, name) => token.attrs?.find(([key]) => key === name)?.[1] ?? "";
  const text = (content, style = {}) => new TextRun({ text: content, ...style });
  function inline(children = []) {
    const out = [], style = {}, links = [];
    const add = run => (links.length ? links.at(-1).runs : out).push(run);
    for (const token of children) {
      const type = token.type;
      if (["strong_open", "em_open", "s_open", "mark_open"].includes(type)) {
        style[{strong_open:"bold", em_open:"italics", s_open:"strike", mark_open:"highlight"}[type]] = type === "mark_open" ? "yellow" : true;
      } else if (["strong_close", "em_close", "s_close", "mark_close"].includes(type)) {
        delete style[{strong_close:"bold", em_close:"italics", s_close:"strike", mark_close:"highlight"}[type]];
      } else if (type === "text") add(text(token.content, style));
      else if (type === "softbreak") add(text(" ", style));
      else if (type === "hardbreak") add(new TextRun({ break: 1 }));
      else if (type === "code_inline") add(text(token.content, { ...style, font: "Consolas", rightToLeft: false }));
      else if (type === "link_open") links.push({ href: attr(token, "href"), runs: [] });
      else if (type === "link_close") {
        const link = links.pop();
        if (!link) throw new Error("Unbalanced link tokens");
        let anchor;
        try { anchor = anchors.get(decodeURIComponent(link.href.slice(1))); } catch { /* explicit unsupported below */ }
        if (link.href.startsWith("#") && anchor) add(new InternalHyperlink({ anchor, children: link.runs }));
        else if (/^https?:\/\//i.test(link.href) || /^mailto:/i.test(link.href)) add(new ExternalHyperlink({ link: link.href, children: link.runs }));
        else { warn("unresolved-or-file-link", { ...token, content: link.href }); for (const run of link.runs) add(run); add(text(` (${link.href})`)); }
      } else if (type === "image") {
        const src = attr(token, "src"), asset = assets.get(src), alt = token.content || "Image";
        if (asset) add(new ImageRun({ type: asset.type, data: asset.bytes, transformation: { width: asset.width, height: asset.height }, altText: { name: alt, description: alt } }));
        else { warn(/^https?:|^\/\//i.test(src) ? "remote-image-not-fetched" : "unavailable-image", { ...token, content: src }); add(text(`[Image: ${alt}; ${src}]`)); }
      } else if (type === "html_inline" && /^<input type="checkbox" class="task-check" data-line="\d+" aria-label="[^"]*"(?: checked)?>$/.test(token.content)) {
        add(text(token.content.includes(" checked") ? "☑ " : "☐ "));
        warn("task-rendered-as-text", token);
      } else {
        warn(type.startsWith("math") ? "math-source-fallback" : type.startsWith("footnote") ? "footnote-fallback" : "unsupported-inline", token);
        add(text(token.content || `[${type}${token.meta?.id !== undefined ? ` ${token.meta.id + 1}` : ""}]`, { font: "Consolas" }));
      }
    }
    if (links.length) throw new Error("Unclosed link tokens");
    return out;
  }
  const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
  const paragraph = (runs, extra = {}) => new Paragraph({ children: runs, bidirectional: direction === "rtl", spacing: { after: 120 }, ...extra });
  let cursor = 0, listCount = 0;
  function blocks(stop, context = {}) {
    const out = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor++], type = token.type;
      if (type === stop) return out;
      if (type === "heading_open" || type === "paragraph_open") {
        const content = tokens[cursor++];
        if (content?.type !== "inline") throw new Error(`Unexpected ${type} content`);
        // The existing footnote plugin emits backlink anchors before paragraph_close.
        while (tokens[cursor]?.type === "footnote_anchor") warn("footnote-anchor-fallback", tokens[cursor++]);
        if (tokens[cursor++]?.type !== type.replace("open", "close")) throw new Error("Unbalanced paragraph");
        let runs = inline(content.children), extra = {};
        if (type === "heading_open") {
          const anchor = anchors.get(attr(token, "id"));
          if (anchor) runs = [new Bookmark({ id: anchor, children: runs })];
          extra = { heading: HeadingLevel[`HEADING_${token.tag.slice(1)}`], keepNext: true };
        } else if (context.list) {
          extra = { numbering: { reference: context.list.reference, level: context.list.level } };
          // Only the first paragraph of a list item carries its number.
          context.list = null;
        }
        if (context.quote) extra.indent = { left: 360 };
        out.push(paragraph(runs, extra));
      } else if (type === "bullet_list_open" || type === "ordered_list_open") {
        const ordered = type === "ordered_list_open", reference = `list_${++listCount}`;
        const depth = (context.depth ?? -1) + 1;
        if (depth > 8) throw new Error("Fixture nesting exceeds Word levels");
        numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
          level, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${level + 1}.` : "•", start: Number(attr(token, "start") || 1),
          style: { paragraph: { indent: { left: (level + 1) * 360, hanging: 180 } } },
        })) });
        while (tokens[cursor]?.type !== type.replace("open", "close")) {
          if (tokens[cursor++]?.type !== "list_item_open") throw new Error("Unbalanced list item");
          out.push(...blocks("list_item_close", { ...context, depth, list: { reference, level: depth } }));
        }
        cursor++;
      } else if (type === "blockquote_open") out.push(...blocks("blockquote_close", { ...context, quote: true }));
      else if (type === "table_open") {
        const rows = []; let row = [], header = false;
        while (cursor < tokens.length && tokens[cursor].type !== "table_close") {
          const cell = tokens[cursor++];
          if (cell.type === "thead_open") header = true;
          if (cell.type === "thead_close") header = false;
          if (cell.type === "tr_open") row = [];
          if (["th_open", "td_open"].includes(cell.type)) {
            const content = tokens[cursor++];
            if (content?.type !== "inline") throw new Error("Unexpected table cell content");
            if (tokens[cursor++]?.type !== cell.type.replace("open", "close")) throw new Error("Unbalanced table cell");
            row.push(new TableCell({ children: [paragraph(inline(content.children))], shading: header ? { fill: "E8EDF2" } : undefined }));
          }
          if (cell.type === "tr_close") rows.push(new TableRow({ children: row, tableHeader: header }));
        }
        if (tokens[cursor++]?.type !== "table_close") throw new Error("Unclosed table");
        out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, margins: { top: 100, bottom: 100, left: 120, right: 120 }, borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border } }));
      } else if (type === "fence" || type === "code_block") {
        if (token.info?.trim().toLowerCase() === "mermaid") warn("diagram-source-fallback", token);
        for (const line of token.content.replace(/\n$/, "").split("\n")) out.push(paragraph([text(line, { font: "Consolas", rightToLeft: false })], { bidirectional: false, spacing: { after: 0 } }));
      } else if (type === "hr") out.push(paragraph([], { border: { bottom: border } }));
      else if (type === "footnote_block_open") { warn("footnote-block-fallback", token); out.push(...blocks("footnote_block_close", context)); }
      else if (type === "footnote_open") out.push(...blocks("footnote_close", context));
      else if (type === "footnote_anchor") warn("footnote-anchor-fallback", token);
      else { warn("unsupported-block", token); if (token.content) out.push(paragraph([text(token.content, { font: "Consolas" })])); }
    }
    if (stop) throw new Error(`Missing ${stop}`);
    return out;
  }
  const children = blocks();
  const document = new Document({ creator: "AmberText fixture", title: "AmberText export feasibility", numbering: { config: numbering },
    styles: { default: { document: { run: { font: "Arial", size: 24, color: "000000" } } } },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children }] });
  return { document, warnings, anchors: [...anchors] };
}
