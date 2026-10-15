const SPLIT = /[\\/]/;

export function sepOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

export function basename(path: string): string {
  const parts = path.split(SPLIT).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (idx <= 0) return path.slice(0, idx + 1) || path;
  // Keep the trailing separator for drive roots like "C:\".
  if (/^[A-Za-z]:$/.test(path.slice(0, idx))) return path.slice(0, idx + 1);
  return path.slice(0, idx);
}

export function join(dir: string, ...names: string[]): string {
  const sep = sepOf(dir);
  let out = dir.replace(/[\\/]+$/, "");
  for (const n of names) out += sep + n.replace(/^[\\/]+/, "");
  return out;
}

export function extname(path: string): string {
  const base = basename(path);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:[\\/]|[\\/]{1,2})/.test(path);
}

export function isExternalUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href);
}

/** The file part of a link target, decoded once the way the rendered preview does. */
export function linkFilePath(ref: string): string {
  // Split URL suffixes before decoding: %23/%3F are filename characters,
  // while raw #/? start a fragment/query. Decode exactly once, including %25.
  // A lone % stays literal, as markdown-it's link normalisation leaves it.
  const target = ref.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(target.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    return target;
  }
}

/** Resolves a relative reference (as written in Markdown) against a directory. */
export function resolvePath(baseDir: string, ref: string): string {
  const target = linkFilePath(ref);
  if (isAbsolute(target)) return target;
  const sep = sepOf(baseDir);
  const parts = baseDir.split(SPLIT);
  for (const seg of target.split(SPLIT)) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else parts.push(seg);
  }
  return parts.join(sep);
}

/** Drops the Windows extended-length prefix so one file has one path everywhere. */
export function plainPath(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return "\\\\" + path.slice(8);
  return /^\\\\\?\\[A-Za-z]:/.test(path) ? path.slice(4) : path;
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  // Lexical UI paths must never merge case-distinct entries. Physical aliases
  // are resolved by the native canonical revision, not by guessing from the OS.
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return norm(a) === norm(b);
}

export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return norm(child).startsWith(norm(parent) + "/");
}

/** Path relative to `root` using forward slashes, for display. */
export function relativeTo(path: string, root: string): string {
  if (!isInside(path, root)) return path;
  return path.slice(root.replace(/[\\/]+$/, "").length + 1).replace(/\\/g, "/");
}

/** Relative path from a directory to a file, using forward slashes (for Markdown links). */
export function relativeLink(fromDir: string, toPath: string, encodeSegment: (segment: string) => string = encodeURI): string {
  const a = fromDir.replace(/[\\/]+$/, "").split(SPLIT);
  const b = toPath.split(SPLIT);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ups = a.slice(i).map(() => "..");
  return [...ups, ...b.slice(i)].map(encodeSegment).join("/");
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
