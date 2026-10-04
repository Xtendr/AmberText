type Mermaid = typeof import("mermaid").default;

let loader: Promise<Mermaid> | null = null;
let configuredFor = "";
let counter = 0;
const cache = new Map<string, { svg?: string; error?: string }>();

function load(): Promise<Mermaid> {
  loader ??= import("mermaid").then((m) => m.default);
  return loader;
}

function themeKey(dark: boolean) {
  return dark ? "dark" : "light";
}

function computedColor(name: string, fallback: string): string {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name}, ${fallback})`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return computed;
}

/**
 * Resolves a CSS custom property to an opaque #rrggbb colour, composited over the sheet
 * (mermaid can't parse color-mix/oklab or reason about translucent colours).
 */
function resolveColor(name: string, fallback: string): string {
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;
  ctx.fillStyle = "#ffffff";
  ctx.fillStyle = computedColor("--sheet", "#ffffff");
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = fallback;
  ctx.fillStyle = computedColor(name, fallback);
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function configure(mermaid: Mermaid, dark: boolean) {
  const key = themeKey(dark);
  if (configuredFor === key) return;
  const v = resolveColor;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: "Inter Variable, Segoe UI, system-ui, sans-serif",
    themeCSS: `
      .node rect, .node polygon, .node circle, .node path, .cluster rect { filter: none !important; stroke-width: 1px !important; }
      .node rect, .cluster rect { rx: 9px; ry: 9px; }
      .nodeLabel, .edgeLabel { font-weight: 500; }
      .edgePath path, .flowchart-link { stroke-width: 1.25px !important; }
      .actor { filter: none !important; }
    `,
    themeVariables: {
      darkMode: dark,
      fontSize: "14px",
      background: "transparent",
      primaryColor: v("--surface-2", dark ? "#2a2a28" : "#f4f2ed"),
      primaryBorderColor: v("--line-strong", dark ? "#4a4844" : "#d6d2c8"),
      primaryTextColor: v("--text", dark ? "#ecebe6" : "#1f1e1b"),
      lineColor: v("--text-3", dark ? "#7a776f" : "#8f8b82"),
      secondaryColor: v("--accent-soft-solid", dark ? "#3a2a24" : "#fbe6df"),
      tertiaryColor: v("--surface-1", dark ? "#242423" : "#faf9f6"),
      clusterBkg: v("--surface-1", dark ? "#242423" : "#faf9f6"),
      edgeLabelBackground: v("--sheet", dark ? "#1f1f1e" : "#fdfcf9"),
    },
  });
  configuredFor = key;
}

export function cachedMermaid(code: string, dark: boolean) {
  return cache.get(themeKey(dark) + "\u0000" + code);
}

export async function renderMermaid(code: string, dark: boolean): Promise<{ svg?: string; error?: string }> {
  const key = themeKey(dark) + "\u0000" + code;
  const hit = cache.get(key);
  if (hit) return hit;
  const mermaid = await load();
  configure(mermaid, dark);
  const id = `mmd-${Date.now().toString(36)}-${++counter}`;
  let result: { svg?: string; error?: string };
  try {
    const { svg } = await mermaid.render(id, code);
    result = { svg };
  } catch (e) {
    result = { error: e instanceof Error ? e.message.split("\n")[0] : "Could not render diagram" };
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, result);
  return result;
}

export function resetMermaidTheme() {
  configuredFor = "";
  cache.clear();
}
