import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";
import { ArrowDown, ArrowUp, CaseSensitive, ChevronRight, Regex, Replace, WholeWord, X } from "lucide-react";

let replaceRequested = false;
/** Ask the next opened panel to show the replace row. */
export function requestReplace() {
  replaceRequested = true;
}

function countMatches(view: EditorView, query: SearchQuery) {
  if (!query.valid || !query.search) return { total: 0, current: 0 };
  const sel = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let total = 0;
  let current = 0;
  for (let r = cursor.next(); !r.done; r = cursor.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) current = total;
    if (total >= 9999) break;
  }
  return { total, current };
}

function FindPanel({ view, version, initialReplace }: { view: EditorView; version: number; initialReplace: boolean }) {
  const query = getSearchQuery(view.state);
  const [showReplace, setShowReplace] = useState(initialReplace);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchor = useRef(view.state.selection.main.from);
  const [stats, setStats] = useState({ total: 0, current: 0 });

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    setStats(countMatches(view, query));
  }, [view, version, query]);

  const update = (patch: Partial<{ search: string; replace: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }>, jump = false) => {
    const next = new SearchQuery({
      search: query.search,
      replace: query.replace,
      caseSensitive: query.caseSensitive,
      regexp: query.regexp,
      wholeWord: query.wholeWord,
      ...patch,
    });
    view.dispatch({ effects: setSearchQuery.of(next) });
    if (jump && next.valid && next.search) {
      const cursor = next.getCursor(view.state, anchor.current);
      let r = cursor.next();
      if (r.done) r = next.getCursor(view.state).next();
      if (!r.done) {
        view.dispatch({
          selection: { anchor: r.value.from, head: r.value.to },
          effects: EditorView.scrollIntoView(r.value.from, { y: "center" }),
        });
      }
    }
  };

  const close = () => {
    closeSearchPanel(view);
    view.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && (e.target as HTMLElement).dataset.field === "search") {
      e.preventDefault();
      (e.shiftKey ? findPrevious : findNext)(view);
    } else if (e.key === "Enter" && (e.target as HTMLElement).dataset.field === "replace") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) replaceAll(view);
      else replaceNext(view);
    }
  };

  const invalid = query.search && !query.valid;
  const label = !query.search ? "" : invalid ? "Invalid" : stats.total ? `${stats.current || "–"} of ${stats.total}` : "No results";

  return (
    <div className={`find${showReplace ? " has-replace" : ""}`} onKeyDown={onKey}>
      <button
        className="find-toggle"
        data-tip={showReplace ? "Hide replace" : "Replace"}
        onClick={() => setShowReplace((v) => !v)}
        aria-expanded={showReplace}
      >
        <ChevronRight size={14} className={showReplace ? "rot" : ""} />
      </button>
      <div className="find-rows">
        <div className="find-row">
          <div className={`find-field${invalid ? " is-invalid" : ""}`}>
            <input
              ref={inputRef}
              data-field="search"
              {...{ "main-field": "true" }}
              placeholder="Find"
              value={query.search}
              spellCheck={false}
              onChange={(e) => update({ search: e.target.value }, true)}
            />
            <span className={`find-count${stats.total === 0 && query.search ? " is-empty" : ""}`}>{label}</span>
            <button className={`find-opt${query.caseSensitive ? " on" : ""}`} data-tip="Match case" onClick={() => update({ caseSensitive: !query.caseSensitive })}>
              <CaseSensitive size={15} />
            </button>
            <button className={`find-opt${query.wholeWord ? " on" : ""}`} data-tip="Whole word" onClick={() => update({ wholeWord: !query.wholeWord })}>
              <WholeWord size={15} />
            </button>
            <button className={`find-opt${query.regexp ? " on" : ""}`} data-tip="Regular expression" onClick={() => update({ regexp: !query.regexp })}>
              <Regex size={15} />
            </button>
          </div>
          <button className="find-btn" data-tip="Previous" data-kbd="Shift+Enter" onClick={() => findPrevious(view)} disabled={!stats.total}>
            <ArrowUp size={15} />
          </button>
          <button className="find-btn" data-tip="Next" data-kbd="Enter" onClick={() => findNext(view)} disabled={!stats.total}>
            <ArrowDown size={15} />
          </button>
          <button className="find-btn" data-tip="Close" data-kbd="Esc" onClick={close}>
            <X size={15} />
          </button>
        </div>
        {showReplace && (
          <div className="find-row">
            <div className="find-field">
              <input
                data-field="replace"
                placeholder="Replace"
                value={query.replace}
                spellCheck={false}
                onChange={(e) => update({ replace: e.target.value })}
              />
            </div>
            <button className="find-text-btn" onClick={() => replaceNext(view)} disabled={!stats.total}>
              <Replace size={14} /> Replace
            </button>
            <button className="find-text-btn" onClick={() => replaceAll(view)} disabled={!stats.total}>
              All
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "find-host";
  let root: Root | null = createRoot(dom);
  let version = 0;
  const initialReplace = replaceRequested;
  replaceRequested = false;
  const render = () => root?.render(<FindPanel view={view} version={version} initialReplace={initialReplace} />);
  return {
    dom,
    top: true,
    mount() {
      render();
    },
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.length)) {
        version++;
        render();
      }
    },
    destroy() {
      const r = root;
      root = null;
      queueMicrotask(() => r?.unmount());
    },
  };
}
