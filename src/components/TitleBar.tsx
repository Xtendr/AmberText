import { useLayoutEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, Columns2, PanelLeft, PenLine, Plus, Search, X } from "lucide-react";
import { getState, isDirty, setState, useStore, type ViewMode } from "../state/store";
import { closeDoc, closeOthers, displayName, activate, moveTab, newDoc, openContextMenu, setViewMode, toggleSidebar } from "../state/actions";
import { commandById, formatKeys, runCommand } from "../commands";
import { fileManagerName, isMac, isTauri, win } from "../lib/platform";
import { fsApi } from "../lib/platform";
import type { MenuItem } from "../state/store";

function keysFor(id: string) {
  return formatKeys(commandById.get(id)?.keys).join(isMac ? "" : "+");
}

function AppMenuButton() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const item = (id: string, label?: string): MenuItem => ({
    label: label ?? commandById.get(id)?.title,
    shortcut: keysFor(id),
    run: () => runCommand(id),
  });
  const show = () => {
    const r = ref.current!.getBoundingClientRect();
    setOpen(true);
    openContextMenu(r.left, r.bottom + 6, [
      item("new"),
      item("open"),
      item("open-folder"),
      ...(getState().workspace ? [item("close-folder")] : []),
      item("quick-open"),
      item("workspace-search"),
      { separator: true },
      item("save"),
      item("save-as"),
      item("history"),
      { separator: true },
      item("export-pdf", "Export as PDF…"),
      item("export-html"),
      item("copy-html"),
      { separator: true },
      item("palette", "Command palette…"),
      item("settings", "Settings…"),
      item("welcome", "Welcome guide"),
      ...(isTauri ? [{ separator: true as const }, { label: "Quit AmberText", shortcut: isMac ? "⌘Q" : "Alt+F4", run: () => void win.close() }] : []),
    ]);
    const unsub = useStore.subscribe((s) => {
      if (!s.contextMenu) {
        setOpen(false);
        unsub();
      }
    });
  };
  return (
    <button ref={ref} className="brand-btn" onClick={show} aria-expanded={open} aria-haspopup="menu" data-tip="Menu">
      <span className="brand-mark" aria-hidden="true" />
      AmberText
      <ChevronDown size={13} className="chev" />
    </button>
  );
}

function Tabs() {
  const docs = useStore((s) => s.docs);
  const activeId = useStore((s) => s.activeId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; x: number; active: boolean; index: number | null } | null>(null);

  const dropIndexAt = (x: number) => {
    const tabs = [...(strip.current?.querySelectorAll<HTMLElement>(".tab") ?? [])];
    return tabs.filter((t) => {
      const r = t.getBoundingClientRect();
      return r.left + r.width / 2 < x;
    }).length;
  };

  const onContext = (x: number, y: number, id: string) => {
    const doc = docs.find((d) => d.id === id);
    openContextMenu(x, y, [
      { label: "Close", shortcut: keysFor("close-tab"), run: () => void closeDoc(id) },
      { label: "Close others", disabled: docs.length < 2, run: () => void closeOthers(id) },
      { separator: true },
      {
        label: `Reveal in ${fileManagerName}`,
        disabled: !doc?.path || !isTauri,
        run: () => doc?.path && void fsApi.reveal(doc.path),
      },
      {
        label: "Copy path",
        disabled: !doc?.path,
        run: () => doc?.path && void navigator.clipboard.writeText(doc.path),
      },
    ]);
  };

  return (
    <div className="tb-tabs fade-on-type" role="tablist" aria-label="Open documents" ref={strip} data-tauri-drag-region>
      {docs.map((d, i) => {
        const dirty = isDirty(d);
        const draft = !d.path;
        const showDrop = dragId && dropIndex === i && dragId !== d.id && docs[i - 1]?.id !== dragId;
        return (
          <div
            key={d.id}
            className={`tab${d.id === activeId ? " is-active" : ""}${dragId === d.id ? " is-dragging" : ""}${showDrop ? " drop-before" : ""}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              activate(d.id);
              drag.current = { id: d.id, x: e.clientX, active: false, index: null };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const g = drag.current;
              if (!g) return;
              if (!g.active && Math.abs(e.clientX - g.x) > 6) {
                g.active = true;
                setDragId(g.id);
              }
              if (g.active) {
                g.index = dropIndexAt(e.clientX);
                setDropIndex(g.index);
              }
            }}
            onPointerUp={() => {
              const g = drag.current;
              drag.current = null;
              if (g?.active && g.index != null) {
                const from = docs.findIndex((x) => x.id === g.id);
                moveTab(g.id, g.index > from ? g.index - 1 : g.index);
              }
              setDragId(null);
              setDropIndex(null);
            }}
            onPointerCancel={() => {
              drag.current = null;
              setDragId(null);
              setDropIndex(null);
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeDoc(d.id);
            }}
            onContextMenu={(e) => { e.preventDefault(); if (e.button !== 2) return; /* keyboard opens it from onKeyDown */ onContext(e.clientX, e.clientY, d.id); }}
            data-tip={d.path ?? "Unsaved draft"}
          >
            <button role="tab" tabIndex={d.id === activeId ? 0 : -1} aria-selected={d.id === activeId} aria-label={`${displayName(d)}${dirty ? ", unsaved changes" : ""}${d.conflict ? ", changed on disk" : ""}`} className={`tab-label${draft ? " is-draft" : ""}`} onClick={() => activate(d.id)} onKeyDown={(e) => {
              const tabs = [...(strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
              const next = e.key === "Home" ? 0 : e.key === "End" ? docs.length - 1 : e.key === "ArrowLeft" ? (i + docs.length - 1) % docs.length : e.key === "ArrowRight" ? (i + 1) % docs.length : null;
              if (next !== null) { e.preventDefault(); activate(docs[next].id, false); tabs[next]?.focus(); }
              else if (e.key === "Delete") { e.preventDefault(); void closeDoc(d.id); }
              else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                e.preventDefault(); const rect = e.currentTarget.getBoundingClientRect(); onContext(rect.left, rect.bottom, d.id);
              }
            }}>{displayName(d)}</button>
            <span className="tab-end">
              {dirty && <span className="tab-dot" />}
              <button
                className="tab-close"
                tabIndex={d.id === activeId ? 0 : -1}
                aria-label={`Close ${displayName(d)}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeDoc(d.id);
                }}
              >
                <X size={13} strokeWidth={2} />
              </button>
            </span>
          </div>
        );
      })}
      <button aria-label="New document" className="icon-btn sm tab-new" onClick={() => newDoc()} data-tip="New document" data-kbd={keysFor("new")}>
        <Plus size={15} />
      </button>
    </div>
  );
}

const MODES: { id: ViewMode; label: string; icon: typeof PenLine; cmd: string }[] = [
  { id: "write", label: "Write", icon: PenLine, cmd: "mode-write" },
  { id: "split", label: "Split", icon: Columns2, cmd: "mode-split" },
  { id: "read", label: "Read", icon: BookOpen, cmd: "mode-read" },
];

function ViewSwitch() {
  const mode = useStore((s) => s.settings.viewMode);
  const hasDoc = useStore((s) => !!s.activeId);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [thumb, setThumb] = useState({ x: 0, w: 0 });
  useLayoutEffect(() => {
    const idx = MODES.findIndex((m) => m.id === mode);
    const el = refs.current[idx];
    if (el) setThumb({ x: el.offsetLeft - 2, w: el.offsetWidth });
  }, [mode]);
  if (!hasDoc) return null;
  return (
    <div className="seg fade-on-type" role="radiogroup" aria-label="View mode">
      <span className="seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} />
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="radio"
          aria-checked={mode === m.id}
          aria-label={m.label}
          tabIndex={mode === m.id ? 0 : -1}
          className={`seg-btn${mode === m.id ? " is-active" : ""}`}
          onClick={() => setViewMode(m.id)}
          onKeyDown={(e) => {
            const next = e.key === "Home" ? 0 : e.key === "End" ? MODES.length - 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i + MODES.length - 1) % MODES.length : e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % MODES.length : null;
            if (next === null) return;
            e.preventDefault(); setViewMode(MODES[next].id, false); refs.current[next]?.focus();
          }}
          data-tip={m.label}
          data-kbd={keysFor(m.cmd)}
        >
          <m.icon size={15} strokeWidth={1.9} />
        </button>
      ))}
    </div>
  );
}

function WindowControls() {
  const maximized = useStore((s) => s.maximized);
  const fluent = navigator.userAgent.includes("Windows");
  return (
    <div className="win-controls">
      <button className="win-btn" aria-label="Minimize" onClick={() => void win.minimize()}>
        {fluent ? "\uE921" : <svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" /></svg>}
      </button>
      <button className="win-btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={() => void win.toggleMaximize()}>
        {fluent ? (maximized ? "\uE923" : "\uE922") : <svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>}
      </button>
      <button className="win-btn close" aria-label="Close" onClick={() => void win.close()}>
        {fluent ? "\uE8BB" : <svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>}
      </button>
    </div>
  );
}

export function TitleBar() {
  const sidebarOpen = useStore((s) => s.settings.sidebarOpen);
  const fullscreen = useStore((s) => s.fullscreen);
  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <AppMenuButton />
        <span className="tb-left-spacer" data-tauri-drag-region />
        <button
          className="icon-btn fade-on-type"
          onClick={() => toggleSidebar()}
          data-tip={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          data-kbd={keysFor("toggle-sidebar")}
          aria-pressed={sidebarOpen}
        >
          <PanelLeft size={17} strokeWidth={1.8} />
        </button>
      </div>
      <Tabs />
      <div className="tb-drag" data-tauri-drag-region />
      <div className="tb-right" data-tauri-drag-region>
        <ViewSwitch />
        <button
          className="icon-btn fade-on-type"
          onClick={() => setState({ palette: "commands" })}
          data-tip="Search commands"
          aria-label="Search commands"
          data-kbd={keysFor("palette")}
        >
          <Search size={16} strokeWidth={1.9} />
        </button>
        {!isMac && isTauri && !fullscreen && <WindowControls />}
      </div>
    </header>
  );
}
