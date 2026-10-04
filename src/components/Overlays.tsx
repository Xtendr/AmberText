import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, FileDown, Info, X } from "lucide-react";
import { getState, setState, useStore, type MenuItem } from "../state/store";
import { dismissToast, resolveDialog } from "../state/actions";

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function DialogHost() {
  const dialog = useStore((s) => s.dialog);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!dialog) return;
    setValue(dialog.input?.value ?? "");
    requestAnimationFrame(() => {
      if (dialog.input && input.current) {
        input.current.focus();
        input.current.setSelectionRange(0, dialog.input.selectUntil ?? dialog.input.value.length);
      } else primaryRef.current?.focus();
    });
  }, [dialog]);

  if (!dialog) return null;
  const primary = dialog.actions.find((a) => a.kind === "primary") ?? dialog.actions[dialog.actions.length - 1];

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      resolveDialog(null);
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      if (dialog.input && !value.trim()) return;
      resolveDialog(primary.id, value);
    } else if (e.key === "Tab") {
      const nodes = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>("input, button")];
      const i = nodes.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (i <= 0 ? nodes.length - 1 : i - 1) : (i + 1) % nodes.length;
      e.preventDefault();
      nodes[next]?.focus();
    }
  };

  // Secondary actions on the left (e.g. "Don't save"), cancel + primary on the right.
  const left = dialog.actions.filter((a) => a.kind === "danger");
  const right = dialog.actions.filter((a) => a.kind !== "danger");

  return (
    <div className="scrim dim" onMouseDown={(e) => e.target === e.currentTarget && resolveDialog(null)}>
      <div className="dialog popover" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" onKeyDown={onKey}>
        <h2 id="dialog-title">{dialog.title}</h2>
        {dialog.message && <p>{dialog.message}</p>}
        {dialog.input && (
          <input
            ref={input}
            className="dialog-input"
            value={value}
            placeholder={dialog.input.placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          {left.map((a) => (
            <button key={a.id} className="btn danger" onClick={() => resolveDialog(a.id, value)}>
              {a.label}
            </button>
          ))}
          <span className="spacer" />
          {right.map((a) => (
            <button
              key={a.id}
              ref={a === primary ? primaryRef : undefined}
              className={`btn${a.kind === "primary" ? " primary" : ""}`}
              disabled={a === primary && !!dialog.input && !value.trim()}
              onClick={() => resolveDialog(a.id, value)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-icon">
            {t.kind === "success" ? <CircleCheck size={15} /> : t.kind === "error" ? <CircleAlert size={15} /> : <Info size={15} />}
          </span>
          <span className="toast-msg">{t.message}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Context menu                                                        */
/* ------------------------------------------------------------------ */

export function ContextMenuHost() {
  const menu = useStore((s) => s.contextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(-1);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const pad = 8;
    let x = menu.x;
    let y = menu.y;
    if (x + r.width > window.innerWidth - pad) x = Math.max(pad, menu.x - r.width);
    if (y + r.height > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - pad - r.height);
    setPos({ x, y });
    setActive(-1);
    ref.current.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      setState({ contextMenu: null });
    };
    const closeNow = () => setState({ contextMenu: null });
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", closeNow, { passive: true });
    window.addEventListener("resize", closeNow);
    window.addEventListener("blur", closeNow);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", closeNow);
      window.removeEventListener("resize", closeNow);
      window.removeEventListener("blur", closeNow);
    };
  }, [menu]);

  if (!menu) return null;
  const items = menu.items;
  const selectable = items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);

  const run = (it: MenuItem) => {
    if (it.disabled || it.separator) return;
    setState({ contextMenu: null });
    it.run?.();
  };

  const onKey = (e: React.KeyboardEvent) => {
    const at = selectable.indexOf(active);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(selectable[(at + 1) % selectable.length]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(selectable[at <= 0 ? selectable.length - 1 : at - 1]);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (active >= 0) run(items[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setState({ contextMenu: null });
    }
  };

  return (
    <div
      ref={ref}
      className="menu popover"
      role="menu"
      tabIndex={-1}
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? "visible" : "hidden", outline: "none" }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={it.id ?? i}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}${i === active ? " is-active" : ""}`}
            disabled={it.disabled}
            onMouseEnter={() => setActive(i)}
            onMouseLeave={() => setActive(-1)}
            onClick={() => run(it)}
          >
            <span className="mi-label">{it.label}</span>
            {it.shortcut && <span className="mi-keys">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltips — any element with data-tip (and optional data-kbd)        */
/* ------------------------------------------------------------------ */

interface Tip {
  text: string;
  kbd?: string;
  x: number;
  y: number;
  below: boolean;
}

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => {
    let timer = 0;
    let current: HTMLElement | null = null;
    let warmUntil = 0;

    const show = (el: HTMLElement) => {
      const text = el.dataset.tip;
      if (!text || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const below = r.top < 64;
      setShift(0);
      setTip({ text, kbd: el.dataset.kbd || undefined, x: r.left + r.width / 2, y: below ? r.bottom + 8 : r.top - 8, below });
    };
    const hide = () => {
      window.clearTimeout(timer);
      if (current) warmUntil = performance.now() + 500;
      current = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
      if (el === current) return;
      window.clearTimeout(timer);
      if (!el) return hide();
      const warm = current !== null || performance.now() < warmUntil;
      current = el;
      setTip(null);
      timer = window.setTimeout(() => show(el), warm ? 40 : 480);
    };
    const leaveWindow = (e: PointerEvent) => {
      if (!e.relatedTarget) hide();
    };
    const down = () => {
      window.clearTimeout(timer);
      setTip(null);
      current = null;
      warmUntil = 0;
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", leaveWindow);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", down, true);
    window.addEventListener("blur", down);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", leaveWindow);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", down, true);
      window.removeEventListener("blur", down);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const pad = 8;
    if (r.left < pad) setShift(pad - r.left);
    else if (r.right > window.innerWidth - pad) setShift(window.innerWidth - pad - r.right);
  }, [tip]);

  if (!tip) return null;
  const keys = tip.kbd ? tip.kbd.split("+").filter(Boolean) : [];
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      style={{
        left: tip.x + shift,
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? "0" : "-100%"})`,
      }}
    >
      {tip.text}
      {keys.length > 0 && (
        <span className="tip-keys">
          {keys.map((k, i) => (
            <span key={i}>{k}</span>
          ))}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* File drop overlay                                                   */
/* ------------------------------------------------------------------ */

export function DropOverlay() {
  const active = useStore((s) => s.dropActive);
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => getState().dropActive && setState({ dropActive: false }), 8000);
    return () => window.clearTimeout(t);
  }, [active]);
  if (!active) return null;
  return (
    <div className="drop-overlay">
      <div>
        <FileDown size={16} /> Drop to open Markdown · images are inserted at the cursor
      </div>
    </div>
  );
}
