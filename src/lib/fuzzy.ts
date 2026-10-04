export interface FuzzyResult {
  score: number;
  indices: number[];
}

const BOUNDARY = /[\s\-_/\\.]/;

function isWordStart(target: string, i: number): boolean {
  if (i === 0) return true;
  const prev = target[i - 1];
  const cur = target[i];
  return BOUNDARY.test(prev) || (cur >= "A" && cur <= "Z" && prev >= "a" && prev <= "z");
}

function match(q: string, t: string, target: string, preferStarts: boolean): FuzzyResult | null {
  const indices: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let pick = t.indexOf(ch, ti);
    if (pick === -1) return null;
    if (preferStarts && pick !== prev + 1) {
      for (let k = pick; k < t.length; k++) {
        if (t[k] === ch && isWordStart(target, k)) {
          pick = k;
          break;
        }
      }
    }
    score += 1;
    if (pick === prev + 1) score += 4;
    if (isWordStart(target, pick)) score += 3;
    score -= Math.min(pick - ti, 8) * 0.12;
    indices.push(pick);
    prev = pick;
    ti = pick + 1;
  }
  score -= t.length * 0.01;
  if (t.startsWith(q)) score += 6;
  return { score, indices };
}

/**
 * Subsequence matcher that rewards consecutive runs, word starts and early
 * matches. Returns null when the query isn't a subsequence of the target.
 */
export function fuzzy(query: string, target: string): FuzzyResult | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, indices: [] };
  const t = target.toLowerCase();
  return match(q, t, target, true) ?? match(q, t, target, false);
}

export function highlightParts(text: string, indices: number[]): { text: string; hit: boolean }[] {
  if (!indices.length) return [{ text, hit: false }];
  const set = new Set(indices);
  const parts: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = parts[parts.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i], hit });
  }
  return parts;
}
