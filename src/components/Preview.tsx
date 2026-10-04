import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { activeDoc, useStore, type ViewMode } from "../state/store";
import { renderMarkdown } from "../lib/markdown";
import { cachedMermaid, renderMermaid } from "../lib/mermaid";
import { dirname } from "../lib/paths";
import { bridge } from "../editor/bridge";
import { toggleTaskOnLine } from "../editor/commands";
import { followLink } from "../state/actions";

function hydrateMermaid(root: HTMLElement, dark: boolean) {
  for (const block of root.querySelectorAll<HTMLElement>(".mermaid-block")) {
    const code = block.querySelector(".mermaid-src")?.textContent ?? "";
    const apply = (r: { svg?: string; error?: string }) => {
      if (!block.isConnected) return;
      if (r.svg) block.innerHTML = r.svg;
      else block.innerHTML = `<div class="mermaid-error">Diagram error: ${r.error ?? "unknown"}</div>`;
    };
    const hit = cachedMermaid(code, dark);
    if (hit) apply(hit);
    else void renderMermaid(code, dark).then(apply);
  }
}

/** Scrolls the preview so the block for `line` (0-based) sits at the top. */
function syncTo(scroller: HTMLElement, body: HTMLElement, line: number, fraction: number) {
  const blocks = [...body.querySelectorAll<HTMLElement>("[data-line]")];
  if (!blocks.length) return;
  let prev: HTMLElement | null = null;
  let next: HTMLElement | null = null;
  for (const b of blocks) {
    const l = Number(b.dataset.line);
    if (l <= line) prev = b;
    else {
      next = b;
      break;
    }
  }
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const top = (el: HTMLElement) => el.getBoundingClientRect().top - base;
  let y = 0;
  if (prev) {
    const pl = Number(prev.dataset.line);
    const nl = next ? Number(next.dataset.line) : pl + 1;
    const pt = top(prev);
    const nt = next ? top(next) : pt + prev.offsetHeight;
    const t = (line - pl + fraction) / Math.max(1, nl - pl);
    y = pt + (nt - pt) * Math.min(1, t);
  }
  scroller.scrollTop = Math.max(0, y - 56);
}

export function Preview({ mode }: { mode: ViewMode }) {
  const content = useStore((s) => activeDoc(s)?.content ?? "");
  const path = useStore((s) => activeDoc(s)?.path ?? null);
  const id = useStore((s) => s.activeId);
  const dark = useStore((s) => s.dark);
  const deferred = useDeferredValue(content);
  const baseDir = path ? dirname(path) : null;
  const html = useMemo(() => renderMarkdown(deferred, { baseDir }), [deferred, baseDir]);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = html;
    hydrateMermaid(el, dark);
  }, [html, dark]);

  useEffect(() => {
    if (scroller.current && mode === "read") scroller.current.scrollTop = 0;
  }, [id, mode]);

  // Follow the editor in split mode.
  useEffect(() => {
    if (mode !== "split") return;
    let raf = 0;
    const follow = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const view = bridge.view;
        const sc = scroller.current;
        const b = body.current;
        if (!view || !sc || !b) return;
        const height = view.scrollDOM.getBoundingClientRect().top - view.documentTop + 1;
        const block = view.lineBlockAtHeight(Math.max(0, height));
        const line = view.state.doc.lineAt(block.from).number - 1;
        const fraction = block.height ? Math.max(0, Math.min(1, (height - block.top) / block.height)) : 0;
        if (view.scrollDOM.scrollTop < 4) sc.scrollTop = 0;
        else syncTo(sc, b, line, fraction);
      });
    };
    const off = bridge.onScroll(follow);
    const onJump = (e: Event) => {
      const sc = scroller.current;
      const b = body.current;
      if (sc && b) syncTo(sc, b, (e as CustomEvent<number>).detail, 0);
    };
    window.addEventListener("margin:scroll-to-line", onJump);
    follow();
    return () => {
      off();
      cancelAnimationFrame(raf);
      window.removeEventListener("margin:scroll-to-line", onJump);
    };
  }, [mode, html]);

  useEffect(() => {
    if (mode !== "read") return;
    const onJump = (e: Event) => {
      const sc = scroller.current;
      const b = body.current;
      if (sc && b) syncTo(sc, b, (e as CustomEvent<number>).detail, 0);
    };
    window.addEventListener("margin:scroll-to-line", onJump);
    return () => window.removeEventListener("margin:scroll-to-line", onJump);
  }, [mode]);

  const onClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const copy = target.closest(".code-copy");
    if (copy) {
      const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        copy.textContent = "Copied";
        window.setTimeout(() => (copy.textContent = "Copy"), 1400);
      });
      return;
    }
    const box = target.closest<HTMLInputElement>("input.task-check");
    if (box) {
      e.preventDefault();
      const view = bridge.view;
      if (view && bridge.viewDocId === id) toggleTaskOnLine(view, Number(box.dataset.line));
      return;
    }
    const link = target.closest("a");
    if (link) {
      e.preventDefault();
      const href = link.getAttribute("href");
      if (href) followLink(href);
    }
  };

  return (
    <div className="pane pane-preview" ref={scroller}>
      <article className="prose preview-body" ref={body} onClick={onClick} />
    </div>
  );
}
