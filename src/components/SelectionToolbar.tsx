import { useEffect, useRef, useState } from "react";
import { Bold, Code, Italic, Link, ListChecks, Quote, Strikethrough } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { bridge } from "../editor/bridge";
import { headingLevel, insertLink, isInlineActive, setHeading, toggleInline, toggleLinePrefix } from "../editor/commands";
import { commandById, formatKeys } from "../commands";
import { useStore } from "../state/store";

interface Pos {
  x: number;
  y: number;
  below: boolean;
}

const keys = (id: string) => formatKeys(commandById.get(id)?.keys).join("+");

export function SelectionToolbar() {
  const [pos, setPos] = useState<Pos | null>(null);
  const [, setVersion] = useState(0);
  const pointerDown = useRef(false);
  const mode = useStore((s) => s.settings.viewMode);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    const compute = () => {
      const view = bridge.view;
      if (!view || !bridge.viewDocId) return setPos(null);
      const sel = view.state.selection.main;
      if (sel.empty || pointerDown.current || !view.hasFocus || view.state.selection.ranges.length > 1) return setPos(null);
      const host = view.dom.parentElement!.getBoundingClientRect();
      const start = view.coordsAtPos(sel.from);
      const end = view.coordsAtPos(sel.to);
      if (!start || !end) return setPos(null);
      const sameLine = Math.abs(start.top - end.top) < 4;
      const x = sameLine ? (start.left + end.right) / 2 : (start.left + Math.max(start.left, host.left + host.width / 2)) / 2;
      const top = start.top - host.top;
      const below = top < 56;
      setPos({ x: x - host.left, y: below ? end.bottom - host.top + 10 : top - 10, below });
      setVersion((v) => v + 1);
    };
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(compute, 90);
    };
    const offUpdate = bridge.onUpdate((u) => {
      if (!u || u.selectionSet || u.focusChanged || u.docChanged || u.geometryChanged) {
        if (u?.docChanged && !u.selectionSet) setPos(null);
        else schedule();
      }
    });
    const offScroll = bridge.onScroll(() => {
      setPos(null);
      schedule();
    });
    const down = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return;
      if ((e.target as HTMLElement).closest(".cm-content")) {
        pointerDown.current = true;
        setPos(null);
      }
    };
    const up = () => {
      if (pointerDown.current) {
        pointerDown.current = false;
        schedule();
      }
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      offUpdate();
      offScroll();
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  const view = bridge.view;
  if (!pos || !view || mode === "read") return null;
  const state = view.state;
  const level = headingLevel(state);
  const lineText = state.doc.lineAt(state.selection.main.from).text;

  const act = (fn: (v: EditorView) => unknown) => (e: React.MouseEvent) => {
    e.preventDefault();
    fn(view);
  };

  const btn = (label: string, kbd: string, on: boolean, fn: (v: EditorView) => unknown, icon: React.ReactNode, cls = "") => (
    <button className={`tb-btn${on ? " is-on" : ""}${cls}`} onMouseDown={act(fn)} data-tip={label} data-kbd={kbd} aria-pressed={on}>
      {icon}
    </button>
  );

  return (
    <div
      ref={barRef}
      className="sel-toolbar popover"
      style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? "0" : "-100%"})` }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {btn("Bold", keys("bold"), isInlineActive(state, "**"), (v) => toggleInline(v, "**"), <Bold size={15} strokeWidth={2.2} />)}
      {btn("Italic", keys("italic"), isInlineActive(state, "_"), (v) => toggleInline(v, "_"), <Italic size={15} strokeWidth={2.2} />)}
      {btn("Strikethrough", keys("strike"), isInlineActive(state, "~~"), (v) => toggleInline(v, "~~"), <Strikethrough size={15} strokeWidth={2} />)}
      {btn("Inline code", keys("code"), isInlineActive(state, "`"), (v) => toggleInline(v, "`"), <Code size={15} strokeWidth={2} />)}
      {btn("Link", keys("link"), false, insertLink, <Link size={15} strokeWidth={2} />)}
      <span className="tb-sep" />
      {btn("Heading 1", keys("h1"), level === 1, (v) => setHeading(v, 1), "H1", " tb-text")}
      {btn("Heading 2", keys("h2"), level === 2, (v) => setHeading(v, 2), "H2", " tb-text")}
      {btn("Heading 3", keys("h3"), level === 3, (v) => setHeading(v, 3), "H3", " tb-text")}
      <span className="tb-sep" />
      {btn("Quote", keys("quote"), /^\s*>/.test(lineText), (v) => toggleLinePrefix(v, "quote"), <Quote size={15} strokeWidth={2} />)}
      {btn("To-do", keys("tasks"), /^\s*[-*+]\s+\[[ xX]\]/.test(lineText), (v) => toggleLinePrefix(v, "task"), <ListChecks size={15} strokeWidth={2} />)}
    </div>
  );
}
