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

/** Resolves a relative reference (as written in Markdown) against a directory. */
export function resolvePath(baseDir: string, ref: string): string {
  let target = ref;
  try {
    target = decodeURI(ref);
  } catch {
    /* keep as-is */
  }
  target = target.split("#")[0].split("?")[0];
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

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return norm(a) === norm(b);
}

export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
  return norm(child).startsWith(norm(parent) + "/");
}

/** Path relative to `root` using forward slashes, for display. */
export function relativeTo(path: string, root: string): string {
  if (!isInside(path, root)) return path;
  return path.slice(root.replace(/[\\/]+$/, "").length + 1).replace(/\\/g, "/");
}

/** Relative path from a directory to a file, using forward slashes (for Markdown links). */
export function relativeLink(fromDir: string, toPath: string): string {
  const a = fromDir.replace(/[\\/]+$/, "").split(SPLIT);
  const b = toPath.split(SPLIT);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  const ups = a.slice(i).map(() => "..");
  return [...ups, ...b.slice(i)].map((s) => encodeURI(s)).join("/");
}

export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
