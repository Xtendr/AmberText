const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu;

export function countWords(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, " ") : text;
  const words = rest.match(WORD)?.length ?? 0;
  return words + cjk;
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

export interface Heading {
  level: number;
  text: string;
  line: number; // 1-based
  from: number; // character offset
}

/** Strips inline Markdown for display (outline, tab titles). */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

export function extractHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  let offset = 0;
  const lines = text.split("\n");
  let start = 0;
  if (lines[0] === "---") {
    const end = lines.findIndex((l, i) => i > 0 && (l === "---" || l === "..."));
    if (end > 0) {
      for (let i = 0; i <= end; i++) offset += lines[i].length + 1;
      start = end + 1;
    }
  }
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    } else if (!fence) {
      const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (m) {
        const t = plainInline(m[2]);
        if (t) out.push({ level: m[1].length, text: t, line: i + 1, from: offset });
      }
    }
    offset += line.length + 1;
  }
  return out;
}

/** A human title for a document: first heading, else first line. */
export function inferTitle(text: string): string {
  const h = extractHeadings(text)[0];
  if (h) return h.text.slice(0, 60);
  const first = text.split("\n").find((l) => l.trim() && l.trim() !== "---");
  return first ? plainInline(first.replace(/^[#>\-*+\s\d.]+/, "")).slice(0, 60) : "";
}

export function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}
