import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight, CornerDownLeft, FileText, Hash, Search, Zap } from "lucide-react";
import { activeDoc, getState, setState, useStore, type PaletteMode } from "../state/store";
import { displayName, openPath, scrollToHeading, setViewMode } from "../state/actions";
import { COMMANDS, formatKeys, type Command } from "../commands";
import { fuzzy, highlightParts } from "../lib/fuzzy";
import { basename, relativeTo, samePath, stripExt, dirname } from "../lib/paths";
import { extractHeadings } from "../lib/text";
import type { FileEntry } from "../lib/platform";
import { bridge } from "../editor/bridge";

interface Item {
  key: string;
  section: string;
  label: string;
  detail?: string;
  keys?: string[];
  icon: React.ReactNode;
  indices: number[];
  score: number;
  indent?: number;
  run: () => void;
}

function flatten(tree: FileEntry[], out: FileEntry[] = []) {
  for (const e of tree) {
    if (e.isDir) flatten(e.children ?? [], out);
    else out.push(e);
  }
  return out;
}

const PREFIX: Record<string, PaletteMode> = { ">": "commands", "#": "headings" };
const PLACEHOLDER: Record<PaletteMode, string> = {
  files: "Search files by name…   (> commands, # headings)",
  commands: "Type a command…",
  headings: "Jump to a heading…",
};

function Highlight({ text, indices }: { text: string; indices: number[] }) {
  return (
    <>
      {highlightParts(text, indices).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

export function CommandPalette({ mode: initialMode }: { mode: PaletteMode }) {
  const [query, setQuery] = useState(initialMode === "commands" ? ">" : initialMode === "headings" ? "#" : "");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const docs = useStore((s) => s.docs);
  const ws = useStore((s) => s.workspace);
  const recent = useStore((s) => s.recentFiles);
  const hasDoc = useStore((s) => !!s.activeId);
  const viewMode = useStore((s) => s.settings.viewMode);

  const mode: PaletteMode = PREFIX[query[0]] ?? "files";
  const q = PREFIX[query[0]] ? query.slice(1).trim() : query.trim();

  const close = () => {
    setState({ palette: null });
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if ((!el || el === document.body) && getState().settings.viewMode !== "read") bridge.focus();
    });
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    if (mode === "commands") {
      const cmds = COMMANDS.filter((c) => !c.hidden && (!c.doc || hasDoc) && (!c.editor || viewMode !== "read"));
      for (const c of cmds) {
        const r = fuzzy(q, c.title) ?? (c.keywords ? fuzzy(q, c.keywords) : null) ?? fuzzy(q, `${c.group} ${c.title}`);
        if (!r) continue;
        const direct = fuzzy(q, c.title);
        out.push({
          key: c.id,
          section: q ? "Commands" : c.group,
          label: c.title,
          keys: formatKeys(c.keys),
          icon: <Zap size={15} strokeWidth={1.8} />,
          indices: direct?.indices ?? [],
          score: r.score - (direct ? 0 : 2),
          run: () => runCmd(c),
        });
      }
      if (q) out.sort((a, b) => b.score - a.score);
      else {
        const order = ["File", "View", "Format", "Insert", "Edit", "Appearance", "Help"];
        out.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section));
      }
      return out;
    }

    if (mode === "headings") {
      const doc = activeDoc();
      if (!doc) return [];
      const hs = extractHeadings(doc.content);
      const min = hs.reduce((m, h) => Math.min(m, h.level), 6);
      for (const h of hs) {
        const r = fuzzy(q, h.text);
        if (!r) continue;
        out.push({
          key: `h${h.from}`,
          section: "Headings",
          label: h.text,
          detail: `H${h.level}`,
          icon: <Hash size={14} strokeWidth={2} />,
          indices: r.indices,
          score: r.score,
          indent: (h.level - min) * 14,
          run: () => {
            if (getState().settings.viewMode === "read") setViewMode("write");
            requestAnimationFrame(() => scrollToHeading(h.from));
          },
        });
      }
      if (q) out.sort((a, b) => b.score - a.score);
      return out;
    }

    // Files: open documents, then workspace files, then recent files.
    const seen = new Set<string>();
    const push = (path: string, section: string, label: string, detail: string, boost: number) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return;
      const r = fuzzy(q, label) ?? fuzzy(q, `${detail} ${label}`);
      if (!r) return;
      seen.add(key);
      const direct = fuzzy(q, label);
      out.push({
        key: path,
        section: q ? "Files" : section,
        label,
        detail,
        icon: <FileText size={15} strokeWidth={1.8} />,
        indices: direct?.indices ?? [],
        score: r.score + boost,
        run: () => void openPath(path),
      });
    };
    for (const d of docs) {
      if (d.id === getState().activeId && !q) continue;
      const label = displayName(d);
      if (!d.path) {
        const r = fuzzy(q, label);
        if (!r) continue;
        out.push({
          key: d.id,
          section: q ? "Files" : "Open",
          label,
          detail: "Draft",
          icon: <FileText size={15} strokeWidth={1.8} />,
          indices: r.indices,
          score: r.score + 2,
          run: () => setState({ activeId: d.id }),
        });
        continue;
      }
      push(d.path, "Open", label, ws ? relativeTo(dirname(d.path), ws.root) : basename(dirname(d.path)), 2);
    }
    if (ws) {
      for (const f of flatten(ws.tree)) {
        const rel = relativeTo(dirname(f.path), ws.root);
        push(f.path, basename(ws.root), stripExt(f.name), rel === dirname(f.path) ? "" : rel, 0);
      }
    }
    for (const p of recent) {
      if (ws && docs.some((d) => samePath(d.path, p))) continue;
      push(p, "Recent", stripExt(basename(p)), basename(dirname(p)), -0.5);
    }
    if (q) out.sort((a, b) => b.score - a.score);
    return out.slice(0, 200);
  }, [mode, q, docs, ws, recent, hasDoc, viewMode]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    input.current?.focus();
    const len = input.current?.value.length ?? 0;
    input.current?.setSelectionRange(len, len);
  }, []);

  useEffect(() => {
    list.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function runCmd(c: Command) {
    close();
    requestAnimationFrame(() => void c.run());
  }

  const choose = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (mode !== "commands") close();
    item.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => Math.min(items.length - 1, a + 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Backspace" && (query === ">" || query === "#")) {
      e.preventDefault();
      setQuery("");
    }
    e.stopPropagation();
  };

  let lastSection = "";
  return (
    <div className="scrim dim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette popover" role="dialog" aria-label="Command palette" onKeyDown={onKey}>
        <div className="palette-field">
          {mode === "commands" ? <ChevronRight size={18} /> : mode === "headings" ? <Hash size={17} /> : <Search size={17} />}
          {mode !== "files" && <span className="palette-mode">{mode === "commands" ? "Commands" : "Headings"}</span>}
          <input
            ref={input}
            value={PREFIX[query[0]] ? query.slice(1).replace(/^\s/, "") : query}
            onChange={(e) => setQuery((PREFIX[query[0]] ? query[0] : "") + e.target.value)}
            placeholder={PLACEHOLDER[mode]}
            spellCheck={false}
            aria-autocomplete="list"
            aria-controls="palette-list"
          />
        </div>
        <div className="palette-list" id="palette-list" ref={list} role="listbox">
          {items.length === 0 && (
            <div className="palette-empty">
              {mode === "files" && !ws && !q ? "Open a folder to search its files — or type > for commands." : "No matches"}
            </div>
          )}
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <div key={item.key}>
                {header && <div className="palette-section">{header}</div>}
                <button
                  role="option"
                  aria-selected={i === active}
                  className={`palette-item${i === active ? " is-active" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => choose(i)}
                >
                  <span className="pi-icon">{item.icon}</span>
                  <span className="pi-label" style={item.indent ? { paddingLeft: item.indent } : undefined}>
                    <Highlight text={item.label} indices={item.indices} />
                  </span>
                  {item.detail && <span className="pi-detail">{item.detail}</span>}
                  {item.keys && item.keys.length > 0 && (
                    <span className="kbds">
                      {item.keys.map((k, j) => (
                        <kbd key={j}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>
              <ArrowUp size={10} />
            </kbd>
            <kbd>
              <ArrowDown size={10} />
            </kbd>
            Navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>
            {mode === "commands" ? "Run" : "Open"}
          </span>
          <span className="grow" />
          <span>
            <kbd>&gt;</kbd> Commands
          </span>
          <span>
            <kbd>#</kbd> Headings
          </span>
        </div>
      </div>
    </div>
  );
}
