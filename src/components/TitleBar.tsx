import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
      { separator: true },
      item("save"),
      item("save-as"),
      { separator: true },
      item("export-pdf", "Export as PDF…"),
      item("export-html"),
      item("copy-html"),
      { separator: true },
      item("palette", "Command palette…"),
      item("settings", "Settings…"),
      item("welcome", "Welcome guide"),
      ...(isTauri ? [{ separator: true as const }, { label: "Quit Margin", shortcut: "Alt+F4", run: () => void win.close() }] : []),
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
      Margin
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

  const onContext = (e: ReactMouseEvent, id: string) => {
    e.preventDefault();
    const doc = docs.find((d) => d.id === id);
    openContextMenu(e.clientX, e.clientY, [
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
    <div className="tb-tabs fade-on-type" role="tablist" ref={strip} data-tauri-drag-region>
      {docs.map((d, i) => {
        const dirty = isDirty(d);
        const draft = !d.path;
        const showDrop = dragId && dropIndex === i && dragId !== d.id && docs[i - 1]?.id !== dragId;
        return (
          <div
            key={d.id}
            role="tab"
            aria-selected={d.id === activeId}
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
            onContextMenu={(e) => onContext(e, d.id)}
            data-tip={d.path ?? "Unsaved draft"}
          >
            <span className={`tab-label${draft ? " is-draft" : ""}`}>{displayName(d)}</span>
            <span className="tab-end">
              {dirty && <span className="tab-dot" />}
              <span
                className="tab-close"
                role="button"
                aria-label="Close tab"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeDoc(d.id);
                }}
              >
                <X size={13} strokeWidth={2} />
              </span>
            </span>
          </div>
        );
      })}
      <button className="icon-btn sm tab-new" onClick={() => newDoc()} data-tip="New document" data-kbd={keysFor("new")}>
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
          className={`seg-btn${mode === m.id ? " is-active" : ""}`}
          onClick={() => setViewMode(m.id)}
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
        {(!isMac || !isTauri) && <AppMenuButton />}
        <span className="tb-left-spacer" data-tauri-drag-region />
        <button
          className="icon-btn fade-on-type"
          onClick={() => toggleSidebar()}
          data-tip={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
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
          data-kbd={keysFor("palette")}
        >
          <Search size={16} strokeWidth={1.9} />
        </button>
        {!isMac && isTauri && !fullscreen && <WindowControls />}
      </div>
    </header>
  );
}
