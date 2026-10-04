export interface DiffPart {
  type: "same" | "add" | "del";
  text: string;
}

const TOKEN = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu;
const MAX_TOKENS = 2500;

function tokens(s: string) {
  return s.match(TOKEN) ?? [];
}

/** Word-level diff (LCS). Returns null when the texts are too large to diff cheaply. */
export function diffWords(a: string, b: string): DiffPart[] | null {
  const x = tokens(a);
  const y = tokens(b);
  // Trim the common prefix and suffix so the table stays small.
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const mx = x.slice(start, endX);
  const my = y.slice(start, endY);
  if (mx.length * my.length > MAX_TOKENS * MAX_TOKENS / 4) return null;

  const n = mx.length;
  const m = my.length;
  const table = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = mx[i] === my[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (type: DiffPart["type"], text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  if (start) push("same", x.slice(0, start).join(""));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (mx[i] === my[j]) {
      push("same", mx[i]);
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) {
      push("del", mx[i++]);
    } else {
      push("add", my[j++]);
    }
  }
  while (i < n) push("del", mx[i++]);
  while (j < m) push("add", my[j++]);
  if (endX < x.length) push("same", x.slice(endX).join(""));

  // Fold whitespace-only "same" runs sandwiched between changes into the changes,
  // so "foo bar" → "baz qux" reads as one replacement rather than confetti.
  const merged: DiffPart[] = [];
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    const prev = merged[merged.length - 1];
    const next = parts[k + 1];
    if (p.type === "same" && /^\s+$/.test(p.text) && prev && prev.type !== "same" && next && next.type !== "same") {
      merged.push({ type: "del", text: p.text }, { type: "add", text: p.text });
      continue;
    }
    merged.push({ ...p });
  }
  const out: DiffPart[] = [];
  let dels = "";
  let adds = "";
  const flush = () => {
    if (dels) out.push({ type: "del", text: dels });
    if (adds) out.push({ type: "add", text: adds });
    dels = adds = "";
  };
  for (const p of merged) {
    if (p.type === "del") dels += p.text;
    else if (p.type === "add") adds += p.text;
    else {
      flush();
      out.push(p);
    }
  }
  flush();
  return out;
}

export function changeRatio(parts: DiffPart[]): number {
  let changed = 0;
  let total = 0;
  for (const p of parts) {
    const len = p.text.trim().length;
    total += len;
    if (p.type !== "same") changed += len;
  }
  return total ? changed / total : 0;
}
