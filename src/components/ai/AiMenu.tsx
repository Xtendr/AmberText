import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CornerDownLeft, Lock, Sparkles } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { bridge } from "../../editor/bridge";
import { closeAiMenu, runAction, runCustom, useAiSession } from "../../ai/session";
import { DOCUMENT_ACTIONS, SELECTION_ACTIONS, SUBMENUS, type AiAction } from "../../ai/actions";
import { activeModelLabel } from "../../ai/engine";
import { fuzzy, highlightParts } from "../../lib/fuzzy";
import { useStore } from "../../state/store";

interface Entry {
  key: string;
  label: string;
  group: string;
  icon: LucideIcon;
  indices: number[];
  submenu?: string;
  action?: AiAction;
  custom?: string;
}

const CURSOR_IDS = ["continue", "summarize", "titles", "key-points", "actions", "frontmatter", "outline", "review", "structure"];

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  return (
    <>
      {highlightParts(text, indices).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function AiMenu() {
  const menu = useAiSession((s) => s.menu);
  const [query, setQuery] = useState("");
  const [sub, setSub] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const providerLabel = useStore((s) => (s.settings.aiProvider === "local" ? "On this computer" : "Your local server"));

  useEffect(() => {
    setQuery(menu?.initial ?? "");
    setSub(null);
    setActive(0);
  }, [menu]);

  // Position under the selection (or caret), flipping above when there's no room.
  useLayoutEffect(() => {
    if (!menu) return;
    const place = () => {
      const view = bridge.view;
      if (!view) return;
      const host = view.dom.parentElement!.getBoundingClientRect();
      const start = view.coordsAtPos(menu.from);
      const end = view.coordsAtPos(menu.to, -1) ?? start;
      if (!start || !end) return;
      const content = view.contentDOM.getBoundingClientRect();
      const left = Math.min(Math.max(start.left, content.left), host.right - 360);
      const height = box.current?.offsetHeight ?? 380;
      const spaceBelow = host.bottom - end.bottom;
      const above = spaceBelow < Math.min(height, 300) + 16 && start.top - host.top > spaceBelow;
      setPos({ x: left - host.left, y: above ? start.top - host.top - 8 : end.bottom - host.top + 8, above });
    };
    place();
    const off = bridge.onScroll(place);
    window.addEventListener("resize", place);
    return () => {
      off();
      window.removeEventListener("resize", place);
    };
  }, [menu]);

  useEffect(() => {
    if (menu) requestAnimationFrame(() => input.current?.focus());
  }, [menu, sub]);

  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) closeAiMenu(false);
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [menu]);

  const entries = useMemo<Entry[]>(() => {
    if (!menu) return [];
    const q = query.trim();
    const base = menu.scope === "selection" ? SELECTION_ACTIONS : CURSOR_IDS.map((id) => DOCUMENT_ACTIONS.find((a) => a.id === id)!);
    const out: Entry[] = [];
    if (!q) {
      if (sub) {
        for (const a of base.filter((x) => x.parent === sub)) out.push({ key: a.id, label: a.label, group: a.group, icon: a.icon, indices: [], action: a });
        return out;
      }
      const seen = new Set<string>();
      for (const a of base) {
        if (a.parent) {
          if (seen.has(a.parent)) continue;
          seen.add(a.parent);
          const m = SUBMENUS.find((s) => s.id === a.parent)!;
          out.push({ key: `sub-${m.id}`, label: m.label, group: m.group, icon: m.icon, indices: [], submenu: m.id });
          continue;
        }
        out.push({ key: a.id, label: a.label, group: a.group, icon: a.icon, indices: [], action: a });
      }
      return out;
    }
    const scored: (Entry & { score: number })[] = [];
    for (const a of base) {
      if (sub && a.parent !== sub) continue;
      const parent = a.parent ? SUBMENUS.find((s) => s.id === a.parent) : null;
      const label = parent && !sub ? `${parent.label}: ${a.label}` : a.label;
      const direct = fuzzy(q, label);
      const r = direct ?? (a.keywords ? fuzzy(q, a.keywords) : null);
      if (!r) continue;
      scored.push({ key: a.id, label, group: "Actions", icon: a.icon, indices: direct?.indices ?? [], action: a, score: r.score - (direct ? 0 : 2) });
    }
    scored.sort((a, b) => b.score - a.score);
    const good = scored.filter((x) => x.score > -1.5).slice(0, 8);
    const custom: Entry = { key: "custom", label: q, group: menu.scope === "selection" ? "Ask AI" : "Ask about this document", icon: Sparkles, indices: [], custom: q };
    // A long, sentence-like query is an instruction, not a search.
    if (q.split(/\s+/).length >= 3 || !good.length) return [custom, ...good];
    return [...good, custom];
  }, [menu, query, sub]);

  useEffect(() => setActive(0), [query, sub]);
  useEffect(() => {
    list.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!menu || !pos) return null;

  const choose = (e: Entry | undefined) => {
    if (!e) return;
    if (e.submenu) {
      setSub(e.submenu);
      setQuery("");
      return;
    }
    if (e.custom) runCustom(e.custom, menu.scope);
    else if (e.action) runAction(e.action);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(entries.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "ArrowRight" && entries[active]?.submenu && !query) {
      e.preventDefault();
      choose(entries[active]);
    } else if ((e.key === "ArrowLeft" || e.key === "Backspace") && sub && !query) {
      e.preventDefault();
      setSub(null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(entries[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (sub) setSub(null);
      else closeAiMenu();
    }
  };

  const subLabel = sub ? SUBMENUS.find((s) => s.id === sub)?.label : null;
  const model = activeModelLabel();
  let lastGroup = "";

  return (
    <div
      ref={box}
      className={`ai-menu popover${pos.above ? " is-above" : ""}`}
      style={{ left: pos.x, top: pos.y, transform: pos.above ? "translateY(-100%)" : undefined }}
      onKeyDown={onKey}
      role="dialog"
      aria-label="Ask AI"
    >
      <div className="ai-menu-field">
        {sub ? (
          <button className="ai-menu-back" onClick={() => setSub(null)} aria-label="Back">
            <ChevronLeft size={15} />
          </button>
        ) : (
          <Sparkles size={15} className="ai-menu-spark" />
        )}
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={subLabel ? `${subLabel}…` : menu.scope === "selection" ? "Ask AI to edit or explain…" : "Ask AI to write or review…"}
          spellCheck={false}
          aria-autocomplete="list"
        />
        {query.trim() && (
          <kbd className="ai-menu-enter">
            <CornerDownLeft size={10} />
          </kbd>
        )}
      </div>
      <div className="ai-menu-list" ref={list} role="listbox">
        {entries.map((e, i) => {
          const header = e.group !== lastGroup ? e.group : null;
          lastGroup = e.group;
          return (
            <div key={e.key}>
              {header && !sub && <div className="ai-menu-section">{header}</div>}
              <button
                role="option"
                aria-selected={i === active}
                className={`ai-menu-item${i === active ? " is-active" : ""}${e.custom ? " is-custom" : ""}`}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose(e)}
              >
                <span className="ami-icon">
                  <e.icon size={15} strokeWidth={1.8} />
                </span>
                <span className="ami-label">{e.custom ? <>“{e.label}”</> : <Highlight text={e.label} indices={e.indices} />}</span>
                {e.submenu && <ChevronRight size={14} className="ami-chev" />}
              </button>
            </div>
          );
        })}
      </div>
      <div className="ai-menu-foot">
        <Lock size={10} strokeWidth={2.4} />
        <span>{model ? `${providerLabel} · ${model}` : "Private, on-device AI — set up in a moment"}</span>
      </div>
    </div>
  );
}
