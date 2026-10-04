import type { MarkdownConfig } from "@lezer/markdown";

const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };

/** `==highlighted==` text, as in Obsidian, iA Writer and Typora. */
export const Highlight: MarkdownConfig = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
      },
      after: "Emphasis",
    },
  ],
};
