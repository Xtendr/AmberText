import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Check, Copy, CornerDownLeft, Diff, Lock, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import { aiHost } from "../../editor/aiInline";
import { bridge } from "../../editor/bridge";
import { accept, applyTitle, canReplace, copyOutput, discard, primaryMode, refine, retry, setupAndRun, stop, useAiSession, type AcceptMode, type AiSession } from "../../ai/session";
import { activeModelLabel, useAi } from "../../ai/engine";
import { parseTitles } from "../../ai/actions";
import { changeRatio, diffWords } from "../../ai/diff";
import { renderFragment } from "../../lib/markdown";
import { isTauri } from "../../lib/platform";
import { setState, useStore } from "../../state/store";
import { modelById } from "../../ai/models";
import { InstallStatus, ModelPicker, preferredTier } from "./ModelPicker";

function primaryLabel(s: AiSession): string {
  const a = s.action;
  if (a.kind === "rewrite") return canReplace(s) ? "Replace" : a.scope === "selection" ? "Insert below" : "Insert at top";
  if (a.id === "heading") return "Add heading";
  if (a.placement === "frontmatter") return "Add to front matter";
  if (a.placement === "top") return "Insert at top";
  if (a.kind === "insert") return "Insert";
  return a.scope === "selection" ? "Insert below" : "Insert at cursor";
}

function Setup() {
  const installing = useAi((s) => s.installing);
  const error = useAi((s) => s.error);
  const supported = useAi((s) => s.supported);
  const [tier, setTier] = useState(preferredTier());
  const openSettings = () => setState({ settingsOpen: true, settingsSection: "ai" });

  if (!isTauri || !supported) {
    return (
      <div className="ai-setup">
        <p className="ai-setup-lead">
          Local models run in the Margin desktop app. You can also connect a model server you already run — like Ollama or LM Studio.
        </p>
        <div className="ai-actions">
          <button className="btn primary sm" onClick={openSettings}>
            Connect a local server
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ai-setup">
      <p className="ai-setup-lead">
        <Lock size={12} strokeWidth={2.2} /> Margin's writing intelligence runs entirely on this computer. Your text never leaves it — no account, no subscription.
      </p>
      {installing ? (
        <InstallStatus tier={installing} />
      ) : (
        <>
          <ModelPicker value={tier} onChange={setTier} />
          {error && <p className="ai-error-text">{error}</p>}
          <div className="ai-actions">
            <button className="btn primary sm" onClick={() => setupAndRun(tier)} autoFocus>
              Download & continue
            </button>
            <button className="btn ghost sm" onClick={openSettings}>
              Use a local server instead
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Output({ s, showDiff }: { s: AiSession; showDiff: boolean }) {
  const parts = useMemo(() => (showDiff && s.status === "done" ? diffWords(s.original.trim(), s.output) : null), [showDiff, s.status, s.original, s.output]);
  const html = useMemo(() => (parts ? "" : renderFragment(s.output || "")), [parts, s.output]);
  const streaming = s.status === "streaming";

  if (s.action.kind === "titles" && s.status === "done") {
    const titles = parseTitles(s.output);
    return (
      <div className="ai-titles">
        {titles.map((t, i) => (
          <button key={i} className="ai-title-option" onClick={() => applyTitle(t)}>
            <span>{t}</span>
            <span className="ai-title-use">Use</span>
          </button>
        ))}
      </div>
    );
  }
  if (parts) {
    return (
      <div className="ai-output ai-diff">
        {parts.map((p, i) => (p.type === "same" ? <span key={i}>{p.text}</span> : p.type === "add" ? <ins key={i}>{p.text}</ins> : <del key={i}>{p.text}</del>))}
      </div>
    );
  }
  return <div className={`ai-output prose${streaming ? " is-streaming" : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Thinking({ s }: { s: AiSession }) {
  const starting = useAi((st) => st.starting);
  const label = starting ? "Loading the model…" : s.action.kind === "rewrite" ? "Rewriting…" : "Thinking…";
  return (
    <div className="ai-thinking">
      <span className="ai-shimmer">{label}</span>
    </div>
  );
}

export function AiCard({ s, docked }: { s: AiSession; docked?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [follow, setFollow] = useState("");
  const model = useStore((st) => st.settings.aiModel);
  const provider = useStore((st) => st.settings.aiProvider);
  const diffable = s.action.kind === "rewrite" && !!s.original.trim();
  const ratio = useMemo(() => {
    if (!diffable || s.status !== "done") return 1;
    const d = diffWords(s.original.trim(), s.output);
    return d ? changeRatio(d) : 1;
  }, [diffable, s.status, s.original, s.output]);
  const [diffPref, setDiffPref] = useState<boolean | null>(null);
  const showDiff = diffable && (diffPref ?? ratio < 0.55);
  const done = s.status === "done";
  const busy = s.status === "loading" || s.status === "streaming";
  const label = activeModelLabel();
  const compact = provider === "local" && modelById(model)?.id === "compact";

  useEffect(() => {
    if (done) {
      setFollow("");
      input.current?.focus({ preventScroll: true });
    } else if (s.status !== "setup") root.current?.focus({ preventScroll: true });
  }, [done, s.status, s.turns]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => bridge.view?.requestMeasure());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (docked || (s.status !== "loading" && s.status !== "done")) return;
    requestAnimationFrame(() => root.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }, [docked, s.status]);

  const unchanged = done && diffable && s.output.trim() === s.original.trim();

  const go = (mode: AcceptMode) => (unchanged ? discard() : accept(mode));

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (busy) stop();
      else discard();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && done) {
      e.preventDefault();
      go(primaryMode(s));
    } else if (e.key === "Enter" && done && e.target === input.current) {
      e.preventDefault();
      const text = follow.trim();
      if (text) refine(text);
      else if (s.action.kind !== "titles") go(primaryMode(s));
    }
  };

  const Icon = s.action.icon;
  return (
    <div ref={root} className={`ai-card${docked ? " is-docked" : ""}`} tabIndex={-1} onKeyDown={onKey} role="dialog" aria-label={`AI: ${s.action.verb ?? s.action.label}`}>
      <div className="ai-head">
        <span className="ai-mark">
          <Icon size={13} strokeWidth={2} />
        </span>
        <span className="ai-title">{s.status === "setup" ? "Set up writing intelligence" : (s.action.verb ?? s.action.label)}</span>
        {label && s.status !== "setup" && (
          <span className="ai-meta" data-tip={provider === "local" ? "Runs on this computer" : "Your local server"}>
            <Lock size={10} strokeWidth={2.4} />
            {label}
          </span>
        )}
        <button className="icon-btn sm" onClick={() => discard()} data-tip="Discard" data-kbd="Esc" aria-label="Discard">
          <X size={14} />
        </button>
      </div>

      {s.status === "setup" && <Setup />}
      {s.status === "loading" && <Thinking s={s} />}
      {(s.status === "streaming" || done) && (
        <div className="ai-body">
          <Output s={s} showDiff={showDiff} />
        </div>
      )}
      {s.status === "error" && (
        <div className="ai-error">
          <TriangleAlert size={14} />
          <span>{s.error}</span>
        </div>
      )}

      {done && (unchanged || s.warnings.length > 0 || s.truncated || (s.incomplete && s.action.kind === "rewrite") || (compact && s.action.demanding)) && (
        <div className="ai-notes">
          {unchanged && (
            <span className="ai-note good">
              <Check size={12} strokeWidth={2.4} /> Reads well already — no changes suggested.
            </span>
          )}
          {s.warnings.map((w) => (
            <span key={w} className="ai-note warn">
              <TriangleAlert size={12} /> {w}
            </span>
          ))}
          {s.truncated && <span className="ai-note">Only the first part of this long document was read.</span>}
          {s.incomplete && s.action.kind === "rewrite" && (
            <span className="ai-note warn">
              <TriangleAlert size={12} /> This stopped before the end, so it won't replace your text.
            </span>
          )}
          {compact && s.action.demanding && <span className="ai-note">The Compact model can be rough at this — Standard does better.</span>}
        </div>
      )}

      {busy && (
        <div className="ai-foot">
          <span className="ai-hint">
            <kbd>Esc</kbd> to stop
          </span>
          <span className="grow" />
          <button className="btn ghost sm" onClick={stop}>
            <Square size={10} fill="currentColor" /> Stop
          </button>
        </div>
      )}

      {s.status === "error" && (
        <div className="ai-foot">
          <span className="grow" />
          <button className="btn ghost sm" onClick={() => setState({ settingsOpen: true, settingsSection: "ai" })}>
            AI settings
          </button>
          <button className="btn sm" onClick={retry}>
            <RotateCcw size={12} /> Try again
          </button>
        </div>
      )}

      {done && (
        <div className="ai-foot">
          <div className="ai-follow">
            <input
              ref={input}
              value={follow}
              onChange={(e) => setFollow(e.target.value)}
              placeholder={s.action.kind === "titles" ? "Ask for different titles…" : "Ask for changes…"}
              spellCheck={false}
              aria-label="Ask for changes"
            />
            {follow.trim() && (
              <button className="ai-send" onClick={() => refine(follow.trim())} aria-label="Send">
                <ArrowUp size={13} strokeWidth={2.4} />
              </button>
            )}
          </div>
          {diffable && !unchanged && (
            <button className={`icon-btn sm${showDiff ? " is-on" : ""}`} onClick={() => setDiffPref(!showDiff)} data-tip={showDiff ? "Hide changes" : "Show changes"} aria-pressed={showDiff}>
              <Diff size={14} />
            </button>
          )}
          <button className="icon-btn sm" onClick={retry} data-tip="Try again">
            <RotateCcw size={14} />
          </button>
          <button className="icon-btn sm" onClick={() => void copyOutput()} data-tip="Copy">
            <Copy size={14} />
          </button>
          {s.action.kind === "rewrite" && s.action.scope === "selection" && !unchanged && canReplace(s) && (
            <button className="btn ghost sm" onClick={() => go("below")}>
              Insert below
            </button>
          )}
          {unchanged && (
            <button className="btn primary sm" onClick={() => discard()} data-kbd="↵">
              <Check size={13} strokeWidth={2.4} /> Done
            </button>
          )}
          {s.action.kind !== "titles" && !unchanged && (
            <button className="btn primary sm" onClick={() => go(primaryMode(s))} data-tip={`${primaryLabel(s)}`} data-kbd="↵">
              {s.action.kind === "rewrite" && canReplace(s) ? <Check size={13} strokeWidth={2.4} /> : <CornerDownLeft size={13} />}
              {primaryLabel(s)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Renders the active AI card inline (inside the editor) or docked above the status bar. */
export function AiLayer() {
  const session = useAiSession((s) => s.session);
  const host = useSyncExternalStore(aiHost.subscribe, aiHost.get);
  if (!session) return null;
  if (session.placement === "dock") {
    return (
      <div className="ai-dock">
        <AiCard s={session} docked />
      </div>
    );
  }
  if (!host) return null;
  return createPortal(<AiCard s={session} />, host);
}