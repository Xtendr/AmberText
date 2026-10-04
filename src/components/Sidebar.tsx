import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Moon,
  Settings,
  Sun,
  SunMoon,
  ListTree,
  X,
} from "lucide-react";
import { activeDoc, getState, setState, useStore, type TreeEdit } from "../state/store";
import {
  closeFolder,
  collapseAll,
  createEntry,
  cycleTheme,
  openContextMenu,
  openFolder,
  openFolderDialog,
  openPath,
  renameEntry,
  scrollToHeading,
  toggleExpanded,
  trashEntry,
} from "../state/actions";
import { fileManagerName, fsApi, isTauri, type FileEntry } from "../lib/platform";
import { basename, extname, samePath, stripExt } from "../lib/paths";
import { extractHeadings, formatCount } from "../lib/text";
import { commandById, formatKeys } from "../commands";

const INDENT = 14;

function InlineInput({ initial, onDone, depth, icon }: { initial: string; onDone: (v: string | null) => void; depth: number; icon: React.ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <div className="tree-row" style={{ paddingLeft: 8 + depth * INDENT + 22 }}>
      {icon}
      <input
        ref={ref}
        className="tree-input"
        defaultValue={initial}
        spellCheck={false}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") finish(e.currentTarget.value.trim() || null);
          if (e.key === "Escape") finish(null);
          e.stopPropagation();
        }}
        onBlur={(e) => finish(e.currentTarget.value.trim() || null)}
      />
    </div>
  );
}

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expanded = useStore((s) => s.expanded.some((p) => samePath(p, entry.path)));
  const activePath = useStore((s) => activeDoc(s)?.path ?? null);
  const isOpenDoc = useStore((s) => s.docs.some((d) => samePath(d.path, entry.path)));
  const edit = useStore((s) => s.treeEdit);
  const [ctx, setCtx] = useState(false);

  const renaming = edit?.kind === "rename" && samePath(edit.path, entry.path);
  const creatingHere = edit && edit.kind !== "rename" && samePath(edit.parent, entry.path);
  const active = !entry.isDir && samePath(activePath, entry.path);

  const setEdit = (e: TreeEdit | null) => setState({ treeEdit: e });

  const menu = (x: number, y: number) => {
    setCtx(true);
    const parent = entry.isDir ? entry.path : entry.path.slice(0, entry.path.length - entry.name.length - 1);
    openContextMenu(x, y, [
      ...(entry.isDir
        ? []
        : [{ label: "Open", run: () => void openPath(entry.path) }, { separator: true as const }]),
      {
        label: "New document",
        run: () => {
          toggleExpanded(parent, true);
          setEdit({ kind: "new-file", parent });
        },
      },
      {
        label: "New folder",
        run: () => {
          toggleExpanded(parent, true);
          setEdit({ kind: "new-folder", parent });
        },
      },
      { separator: true },
      { label: "Rename…", shortcut: "F2", run: () => setEdit({ kind: "rename", path: entry.path }) },
      { label: `Reveal in ${fileManagerName}`, disabled: !isTauri, run: () => void fsApi.reveal(entry.path) },
      { label: "Copy path", run: () => void navigator.clipboard.writeText(entry.path) },
      { separator: true },
      { label: "Move to trash", danger: true, run: () => void trashEntry(entry) },
    ]);
    const unsub = useStore.subscribe((s) => {
      if (!s.contextMenu) {
        setCtx(false);
        unsub();
      }
    });
  };

  const ext = extname(entry.name);
  const label = entry.isDir || ext !== "md" ? entry.name : stripExt(entry.name);
  const pad = 8 + depth * INDENT;

  if (renaming) {
    return (
      <InlineInput
        initial={entry.name}
        depth={depth}
        icon={entry.isDir ? <Folder size={15} className="tree-icon" /> : <FileText size={15} className="tree-icon" />}
        onDone={(v) => {
          setEdit(null);
          if (v) void renameEntry(entry.path, v);
        }}
      />
    );
  }

  return (
    <>
      <div
        className={`tree-row${active ? " is-active" : ""}${isOpenDoc ? " is-open-doc" : ""}${ctx ? " is-context" : ""}`}
        style={{ paddingLeft: pad }}
        role="treeitem"
        aria-expanded={entry.isDir ? expanded : undefined}
        aria-selected={active}
        tabIndex={-1}
        onClick={() => (entry.isDir ? toggleExpanded(entry.path) : void openPath(entry.path))}
        onContextMenu={(e) => {
          e.preventDefault();
          menu(e.clientX, e.clientY);
        }}
        onKeyDown={(e) => {
          if (e.key === "F2") setEdit({ kind: "rename", path: entry.path });
        }}
        data-tip={depth > 2 ? entry.name : undefined}
      >
        {Array.from({ length: depth }, (_, i) => (
          <span key={i} className="tree-guide" style={{ left: 8 + i * INDENT + 7 }} />
        ))}
        {entry.isDir ? (
          <span className={`tree-twisty${expanded ? " open" : ""}`}>
            <ChevronRight size={13} strokeWidth={2.2} />
          </span>
        ) : (
          <span className="tree-twisty" />
        )}
        {entry.isDir ? (
          expanded ? (
            <FolderOpen size={15} className="tree-icon" strokeWidth={1.8} />
          ) : (
            <Folder size={15} className="tree-icon" strokeWidth={1.8} />
          )
        ) : (
          <FileText size={15} className="tree-icon" strokeWidth={1.8} />
        )}
        <span className="tree-name">{label}</span>
      </div>
      {entry.isDir && (expanded || creatingHere) && (
        <div className="tree-children" role="group">
          {creatingHere && <NewEntryRow edit={edit!} depth={depth + 1} />}
          {entry.children?.map((c) => <TreeNode key={c.path} entry={c} depth={depth + 1} />)}
        </div>
      )}
    </>
  );
}

function NewEntryRow({ edit, depth }: { edit: TreeEdit; depth: number }) {
  if (edit.kind === "rename") return null;
  const file = edit.kind === "new-file";
  return (
    <InlineInput
      initial={file ? "Untitled.md" : "New folder"}
      depth={depth}
      icon={file ? <FileText size={15} className="tree-icon" /> : <Folder size={15} className="tree-icon" />}
      onDone={(v) => {
        setState({ treeEdit: null });
        if (v) void createEntry(file ? "file" : "folder", edit.parent, v);
      }}
    />
  );
}

function FilesPanel() {
  const ws = useStore((s) => s.workspace);
  const edit = useStore((s) => s.treeEdit);
  const recent = useStore((s) => s.recentFiles);
  const recentFolders = useStore((s) => s.recentFolders);

  if (!ws) {
    const recentOutside = recent.slice(0, 6);
    return (
      <div className="sb-scroll">
        <div className="sb-empty">
          <div className="sb-empty-icon">
            <FolderOpen size={17} strokeWidth={1.8} />
          </div>
          <strong>No folder open</strong>
          Open a folder to browse and organise your notes.
          <div>
            <button className="btn" onClick={() => void openFolderDialog()}>
              Open folder…
            </button>
          </div>
        </div>
        {recentFolders.length > 0 && (
          <>
            <div className="sb-subhead">Recent folders</div>
            <div className="tree">
              {recentFolders.slice(0, 5).map((p) => (
                <div key={p} className="tree-row" style={{ paddingLeft: 8 }} onClick={() => void openFolder(p)} data-tip={p}>
                  <Folder size={15} className="tree-icon" strokeWidth={1.8} />
                  <span className="tree-name">{basename(p)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {recentOutside.length > 0 && (
          <>
            <div className="sb-subhead">Recent documents</div>
            <div className="tree">
              {recentOutside.map((p) => (
                <div key={p} className="tree-row" style={{ paddingLeft: 8 }} onClick={() => void openPath(p)} data-tip={p}>
                  <FileText size={15} className="tree-icon" strokeWidth={1.8} />
                  <span className="tree-name">{stripExt(basename(p))}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const rootCreating = edit && edit.kind !== "rename" && samePath(edit.parent, ws.root);

  const folderMenu = (target: HTMLElement) => {
    const r = target.getBoundingClientRect();
    const others = recentFolders.filter((p) => !samePath(p, ws.root)).slice(0, 5);
    openContextMenu(r.left, r.bottom + 4, [
      { label: "Open another folder…", run: () => void openFolderDialog() },
      ...(others.length
        ? [{ separator: true as const }, ...others.map((p) => ({ label: basename(p), run: () => void openFolder(p) }))]
        : []),
      { separator: true },
      { label: `Reveal in ${fileManagerName}`, disabled: !isTauri, run: () => void fsApi.reveal(ws.root) },
      { label: "Close folder", run: closeFolder },
    ]);
  };

  return (
    <div className="sb-scroll" role="tree" aria-label="Files">
      <div className="sb-section-head">
        <button className="sb-section-title" data-tip={ws.root} aria-haspopup="menu" onClick={(e) => folderMenu(e.currentTarget)}>
          <span className="sb-section-name">{basename(ws.root)}</span>
          <ChevronDown size={12} strokeWidth={2.2} />
        </button>
        <div className="sb-section-actions">
          <button className="icon-btn sm" data-tip="New document" onClick={() => setState({ treeEdit: { kind: "new-file", parent: ws.root } })}>
            <FilePlus size={14} />
          </button>
          <button className="icon-btn sm" data-tip="New folder" onClick={() => setState({ treeEdit: { kind: "new-folder", parent: ws.root } })}>
            <FolderPlus size={14} />
          </button>
          <button className="icon-btn sm" data-tip="Collapse all" onClick={collapseAll}>
            <ChevronsDownUp size={14} />
          </button>
          <button className="icon-btn sm" data-tip="Close folder" onClick={closeFolder}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div
        className="tree"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".tree-row")) return;
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, [
            { label: "New document", run: () => setState({ treeEdit: { kind: "new-file", parent: ws.root } }) },
            { label: "New folder", run: () => setState({ treeEdit: { kind: "new-folder", parent: ws.root } }) },
            { separator: true },
            { label: `Reveal in ${fileManagerName}`, disabled: !isTauri, run: () => void fsApi.reveal(ws.root) },
            { label: "Close folder", run: closeFolder },
          ]);
        }}
      >
        {rootCreating && <NewEntryRow edit={edit!} depth={0} />}
        {ws.tree.map((e) => (
          <TreeNode key={e.path} entry={e} depth={0} />
        ))}
        {ws.tree.length === 0 && !rootCreating && (
          <div className="sb-empty">
            <strong>This folder is empty</strong>
            Create your first document to get started.
            <div>
              <button className="btn" onClick={() => setState({ treeEdit: { kind: "new-file", parent: ws.root } })}>
                New document
              </button>
            </div>
          </div>
        )}
        <div style={{ minHeight: 40, flex: 1 }} />
      </div>
    </div>
  );
}

function OutlinePanel() {
  const content = useStore((s) => activeDoc(s)?.content ?? null);
  const pos = useStore((s) => s.cursor.pos);
  const deferred = useDeferredValue(content);
  const headings = useMemo(() => (deferred ? extractHeadings(deferred) : []), [deferred]);
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6);
  let current = -1;
  for (let i = 0; i < headings.length; i++) if (headings[i].from <= pos) current = i;

  if (content === null) {
    return (
      <div className="sb-scroll">
        <div className="sb-empty">No document open.</div>
      </div>
    );
  }
  if (!headings.length) {
    return (
      <div className="sb-scroll">
        <div className="sb-empty">
          <div className="sb-empty-icon">
            <ListTree size={17} strokeWidth={1.8} />
          </div>
          <strong>No headings yet</strong>
          Start a line with <code>#</code> and your outline will appear here.
        </div>
      </div>
    );
  }
  return (
    <div className="sb-scroll">
      <nav className="outline" aria-label="Outline">
        {headings.map((h, i) => (
          <button
            key={`${h.from}-${i}`}
            className={`outline-item l${h.level - minLevel + 1}${i === current ? " is-current" : ""}`}
            style={{ paddingLeft: 10 + (h.level - minLevel) * 14 }}
            onClick={() => scrollToHeading(h.from)}
          >
            <span className="outline-text">{h.text}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function SidebarFooter() {
  const theme = useStore((s) => s.settings.theme);
  const ws = useStore((s) => s.workspace);
  const count = useMemo(() => {
    if (!ws) return 0;
    let n = 0;
    const walk = (es: FileEntry[]) => es.forEach((e) => (e.isDir ? walk(e.children ?? []) : n++));
    walk(ws.tree);
    return n;
  }, [ws]);
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;
  return (
    <div className="sb-foot">
      <button
        className="icon-btn"
        data-tip="Settings"
        data-kbd={formatKeys(commandById.get("settings")?.keys).join("+")}
        onClick={() => setState((s) => ({ settingsOpen: !s.settingsOpen }))}
      >
        <Settings size={16} strokeWidth={1.8} />
      </button>
      <button className="icon-btn" data-tip={`Theme: ${theme === "system" ? "match system" : theme}`} onClick={cycleTheme}>
        <ThemeIcon size={16} strokeWidth={1.8} />
      </button>
      <span className="sb-foot-stat">{ws ? `${formatCount(count)} document${count === 1 ? "" : "s"}` : ""}</span>
    </div>
  );
}

function Resizer() {
  const [active, setActive] = useState(false);
  return (
    <div
      className={`resizer${active ? " is-active" : ""}`}
      style={{ left: "var(--sidebar-w)" }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = getState().settings.sidebarWidth;
        const app = document.querySelector(".app");
        app?.classList.add("is-resizing");
        setActive(true);
        const move = (ev: PointerEvent) => {
          const w = Math.round(Math.max(200, Math.min(440, startW + ev.clientX - startX)));
          getState().setSettings({ sidebarWidth: w });
        };
        const up = () => {
          app?.classList.remove("is-resizing");
          setActive(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={() => getState().setSettings({ sidebarWidth: 256 })}
    />
  );
}

export function Sidebar() {
  const tab = useStore((s) => s.settings.sidebarTab);
  const open = useStore((s) => s.settings.sidebarOpen);
  const thumbRef = useRef<HTMLSpanElement>(null);
  return (
    <>
      <aside className="sidebar fade-on-type" aria-hidden={!open}>
        <div className="sidebar-inner">
          <div className="seg full sb-tabs" role="tablist">
            <span ref={thumbRef} className="seg-thumb" style={{ width: "calc(50% - 2px)", transform: tab === "files" ? "translateX(0)" : "translateX(100%)" }} />
            <button role="tab" aria-selected={tab === "files"} className={`seg-btn${tab === "files" ? " is-active" : ""}`} onClick={() => getState().setSettings({ sidebarTab: "files" })}>
              Files
            </button>
            <button role="tab" aria-selected={tab === "outline"} className={`seg-btn${tab === "outline" ? " is-active" : ""}`} onClick={() => getState().setSettings({ sidebarTab: "outline" })}>
              Outline
            </button>
          </div>
          {tab === "files" ? <FilesPanel /> : <OutlinePanel />}
          <SidebarFooter />
        </div>
      </aside>
      {open && <Resizer />}
    </>
  );
}
