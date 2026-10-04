import { useEffect, useMemo, useState } from "react";
import { Check, CircleAlert, Command, FileText, FolderOpen, Lightbulb, PenLine, Plus, Zap } from "lucide-react";
import { isMac } from "../lib/platform";
import { Editor } from "../editor/Editor";
import { activeDoc, isDirty, setState, useStore } from "../state/store";
import { displayName, newDoc, openFileDialog, openFolderDialog, openPath, reloadFromDisk, saveActive, setViewMode } from "../state/actions";
import { countWords, formatCount, readingMinutes, relativeTime } from "../lib/text";
import { basename, dirname, stripExt } from "../lib/paths";
import { commandById, formatKeys } from "../commands";
import { Preview } from "./Preview";
import { SelectionToolbar } from "./SelectionToolbar";
import { AiMenu } from "./ai/AiMenu";
import { AiLayer } from "./ai/AiCard";

function Keys({ id }: { id: string }) {
  const keys = formatKeys(commandById.get(id)?.keys);
  if (!keys.length) return null;
  return (
    <span className="kbds">
      {keys.map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

function Welcome() {
  const recent = useStore((s) => s.recentFiles);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-mark">
          <span className="welcome-rule" />
          <div>
            <h1 className="welcome-title">Margin</h1>
            <p className="welcome-sub">A quiet place to write.</p>
          </div>
        </div>
        <div className="welcome-actions">
          <button className="welcome-row" onClick={() => newDoc()}>
            <span className="wi">
              <Plus size={15} />
            </span>
            <span className="wl">New document</span>
            <Keys id="new" />
          </button>
          <button className="welcome-row" onClick={() => void openFileDialog()}>
            <span className="wi">
              <FileText size={15} />
            </span>
            <span className="wl">Open file…</span>
            <Keys id="open" />
          </button>
          <button className="welcome-row" onClick={() => void openFolderDialog()}>
            <span className="wi">
              <FolderOpen size={15} />
            </span>
            <span className="wl">Open folder…</span>
            <Keys id="open-folder" />
          </button>
          <button className="welcome-row" onClick={() => setState({ palette: "commands" })}>
            <span className="wi">{isMac ? <Command size={15} /> : <Zap size={15} />}</span>
            <span className="wl">All commands</span>
            <Keys id="palette" />
          </button>
        </div>
        {recent.length > 0 && (
          <>
            <div className="welcome-head">Recent</div>
            <div className="welcome-actions">
              {recent.slice(0, 5).map((p) => (
                <button key={p} className="welcome-row" onClick={() => void openPath(p)} data-tip={p}>
                  <span className="wi">
                    <FileText size={15} />
                  </span>
                  <span className="wl">
                    {stripExt(basename(p))}
                    <span className="wpath">{basename(dirname(p))}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <p className="welcome-tip">
          <Lightbulb size={13} />
          <span>
            Type <kbd>/</kbd> on an empty line to insert tables, diagrams, callouts and more.
          </span>
        </p>
      </div>
    </div>
  );
}

function StatusBar() {
  const doc = useStore(activeDoc);
  const cursor = useStore((s) => s.cursor);
  const mode = useStore((s) => s.settings.viewMode);
  const [showChars, setShowChars] = useState(false);
  const [, tick] = useState(0);
  const content = doc?.content ?? "";
  const words = useMemo(() => countWords(content), [content]);

  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30000);
    return () => window.clearInterval(t);
  }, []);

  if (!doc) return <div className="statusbar" />;
  const dirty = isDirty(doc);
  const state = doc.conflict ? "conflict" : doc.saving ? "saving" : dirty ? "dirty" : "saved";
  const label =
    state === "conflict"
      ? "Changed on disk"
      : state === "saving"
        ? "Saving…"
        : state === "dirty"
          ? doc.path
            ? "Edited"
            : "Draft — not saved yet"
          : doc.lastSavedAt
            ? `Saved ${relativeTime(doc.lastSavedAt)}`
            : doc.path
              ? "Saved"
              : "Draft";

  return (
    <div className="statusbar fade-on-type">
      <button className="status-item" onClick={() => setShowChars((v) => !v)} data-tip={showChars ? "Show words" : "Show characters"}>
        {cursor.selChars > 0
          ? showChars
            ? `${formatCount(cursor.selChars)} of ${formatCount(content.length)} characters`
            : `${formatCount(cursor.selWords)} of ${formatCount(words)} words`
          : showChars
            ? `${formatCount(content.length)} characters`
            : `${formatCount(words)} ${words === 1 ? "word" : "words"}`}
      </button>
      {words > 0 && (
        <>
          <span className="status-sep" />
          <span className="status-item">{readingMinutes(words)} min read</span>
        </>
      )}
      <span className="status-spacer" />
      {mode !== "read" && (
        <>
          <span className="status-item">
            Ln {cursor.line}, Col {cursor.col}
          </span>
          <span className="status-sep" />
        </>
      )}
      <button
        className="status-item"
        onClick={() => (doc.conflict ? void reloadFromDisk(doc.id) : void saveActive())}
        data-tip={doc.conflict ? "Reload from disk" : doc.path ? doc.path : "Save to a file"}
      >
        {state === "saved" && doc.path ? (
          <Check size={12} strokeWidth={2.4} />
        ) : state === "conflict" ? (
          <CircleAlert size={12} />
        ) : (
          <span className={`save-dot${state === "dirty" ? " is-dirty" : state === "saving" ? " is-saving" : ""}`} />
        )}
        {label}
      </button>
    </div>
  );
}

export function Sheet() {
  const mode = useStore((s) => s.settings.viewMode);
  const hasDoc = useStore((s) => !!s.activeId);
  const name = useStore((s) => {
    const d = activeDoc(s);
    return d ? displayName(d) : "";
  });
  return (
    <main className="sheet" aria-label={name || "Margin"}>
      <div className="doc-area" data-mode={mode}>
        <div className="pane pane-editor">
          <Editor />
          <SelectionToolbar />
          <AiMenu />
          <AiLayer />
        </div>
        {hasDoc && mode !== "write" && <Preview mode={mode} />}
        {!hasDoc && <Welcome />}
      </div>
      {hasDoc && <StatusBar />}
      {hasDoc && mode === "read" && <ReadModeHint />}
    </main>
  );
}

function ReadModeHint() {
  return (
    <button
      className="btn read-edit fade-on-type"
      onClick={() => setViewMode("write")}
      data-tip="Back to writing"
      data-kbd={formatKeys(commandById.get("mode-write")?.keys).join("+")}
    >
      <PenLine size={13} strokeWidth={2} />
      Edit
    </button>
  );
}
