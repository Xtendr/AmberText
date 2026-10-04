import { useEffect, useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { DEFAULT_SETTINGS, getState, setState, useStore, type Accent, type Settings, type ThemePref, type WritingFont } from "../state/store";
import { COMMANDS, formatKeys } from "../commands";
import { isMac, isTauri, isWindows, platformName } from "../lib/platform";
import { bridge } from "../editor/bridge";
import { AiSettings } from "./ai/AiSettings";

type Section = "appearance" | "writing" | "editor" | "ai" | "shortcuts";

const ACCENTS: { id: Accent; name: string; color: string }[] = [
  { id: "vermilion", name: "Vermilion", color: "#d9512c" },
  { id: "ink", name: "Ink", color: "#4c58d0" },
  { id: "moss", name: "Moss", color: "#3f7d58" },
  { id: "plum", name: "Plum", color: "#8e4ec6" },
  { id: "ocean", name: "Ocean", color: "#1c7aa3" },
  { id: "graphite", name: "Graphite", color: "#4b5059" },
];

const FONTS: { id: WritingFont; name: string; face: string; family: string }[] = [
  { id: "serif", name: "Serif", face: "Newsreader", family: "var(--font-serif)" },
  { id: "sans", name: "Sans", face: "Inter", family: "var(--font-sans)" },
  { id: "mono", name: "Mono", face: "JetBrains Mono", family: "var(--font-mono)" },
];

function set(patch: Partial<Settings>) {
  getState().setSettings(patch);
}

function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" className="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)} />;
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-label">{label}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function ToggleRow({ k, label, desc }: { k: keyof Settings; label: string; desc?: string }) {
  const value = useStore((s) => s.settings[k]) as boolean;
  return (
    <Row label={label} desc={desc}>
      <Switch value={value} onChange={(v) => set({ [k]: v } as Partial<Settings>)} label={label} />
    </Row>
  );
}

function Range({
  k,
  label,
  min,
  max,
  step,
  format,
}: {
  k: "fontSize" | "lineHeight" | "measure";
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
}) {
  const value = useStore((s) => s.settings[k]);
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <Row label={label}>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<Settings>)}
        onDoubleClick={() => set({ [k]: DEFAULT_SETTINGS[k] } as Partial<Settings>)}
      />
      <span className="set-value">{format(value)}</span>
    </Row>
  );
}

function ThemeThumb({ kind }: { kind: ThemePref }) {
  const half = (tone: "light" | "dark", split = false) => (
    <div className={`thumb-half ${tone}${split ? " split" : ""}`}>
      <div className="thumb-side">
        <i style={{ width: "80%" }} />
        <i style={{ width: "60%" }} />
        <i style={{ width: "70%" }} />
      </div>
      <div className="thumb-sheet">
        <i />
        <i className="acc" />
        <i style={{ width: "86%" }} />
        <i style={{ width: "72%" }} />
      </div>
    </div>
  );
  return (
    <div className="theme-thumb">
      {kind === "dark" ? half("dark") : half("light")}
      {kind === "system" && half("dark", true)}
    </div>
  );
}

function Appearance() {
  const theme = useStore((s) => s.settings.theme);
  const accent = useStore((s) => s.settings.accent);
  const materialActive = useStore((s) => s.materialActive);
  const material = useStore((s) => s.settings.material);
  const themes: { id: ThemePref; name: string }[] = [
    { id: "system", name: "System" },
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ];
  return (
    <>
      <div className="set-group">
        <h3>Theme</h3>
        <div className="theme-cards" role="radiogroup" aria-label="Theme">
          {themes.map((t) => (
            <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card${theme === t.id ? " is-active" : ""}`} onClick={() => set({ theme: t.id })}>
              <ThemeThumb kind={t.id} />
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="set-group">
        <h3>Accent</h3>
        <div className="swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={accent === a.id}
              aria-label={a.name}
              data-tip={a.name}
              className={`swatch${accent === a.id ? " is-active" : ""}`}
              style={{ background: a.color, color: a.color }}
              onClick={() => set({ accent: a.id })}
            />
          ))}
        </div>
      </div>
      <div className="set-group">
        <h3>Window</h3>
        <Row
          label={isMac ? "Translucent sidebar" : "Mica material"}
          desc={
            material && !materialActive && isWindows && isTauri
              ? "Needs Windows 11 — using a solid backdrop instead."
              : `Let the ${platformName} desktop tint the window chrome.`
          }
        >
          <Switch value={material} onChange={(v) => set({ material: v })} label="Window material" />
        </Row>
        <ToggleRow k="quietChrome" label="Quiet chrome" desc="Fade tabs, sidebar and status bar while you type." />
      </div>
    </>
  );
}

function Writing() {
  const font = useStore((s) => s.settings.font);
  return (
    <>
      <div className="set-group">
        <h3>Typeface</h3>
        <div className="font-cards" role="radiogroup" aria-label="Writing typeface">
          {FONTS.map((f) => (
            <button key={f.id} role="radio" aria-checked={font === f.id} className={`font-card${font === f.id ? " is-active" : ""}`} onClick={() => set({ font: f.id })}>
              <span className="fc-sample" style={{ fontFamily: f.family }}>
                Aa
              </span>
              <span>
                <div className="fc-name">{f.name}</div>
                <div className="fc-face">{f.face}</div>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="set-group">
        <h3>Layout</h3>
        <Range k="fontSize" label="Text size" min={13} max={26} step={1} format={(v) => `${v}px`} />
        <Range k="lineHeight" label="Line spacing" min={1.3} max={2.1} step={0.05} format={(v) => v.toFixed(2)} />
        <Range k="measure" label="Line width" min={48} max={110} step={2} format={(v) => `${v}ch`} />
      </div>
      <div className="set-group">
        <h3>Focus</h3>
        <ToggleRow k="focusMode" label="Focus mode" desc="Dim everything except the paragraph you're in." />
        <ToggleRow k="typewriter" label="Typewriter scrolling" desc="Keep the line you're writing centred on screen." />
      </div>
    </>
  );
}

function EditorSection() {
  return (
    <>
      <div className="set-group">
        <h3>Editing</h3>
        <ToggleRow k="livePreview" label="Live preview" desc="Hide Markdown syntax and render formatting inline as you write." />
        <ToggleRow k="spellcheck" label="Check spelling" desc="Underline misspelled words using the system dictionary." />
      </div>
      <div className="set-group">
        <h3>Files</h3>
        <ToggleRow k="autosave" label="Save automatically" desc="Write changes to disk a moment after you stop typing. Drafts are always kept safe between sessions." />
      </div>
    </>
  );
}

function Shortcuts() {
  const [q, setQ] = useState("");
  const rows = useMemo(
    () =>
      COMMANDS.filter((c) => c.keys && !c.hidden)
        .filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()))
        .map((c) => ({ id: c.id, title: c.title, keys: formatKeys(c.keys) })),
    [q],
  );
  return (
    <div className="set-group">
      <input className="dialog-input" style={{ marginTop: 0, marginBottom: 10 }} placeholder="Filter shortcuts…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="shortcut-list">
        {rows.map((r) => (
          <div className="shortcut-row" key={r.id}>
            <span>{r.title}</span>
            <span className="kbds" style={{ flex: "none" }}>
              {r.keys.map((k, i) => (
                <kbd key={i}>{k}</kbd>
              ))}
            </span>
          </div>
        ))}
        <div className="shortcut-row">
          <span>Insert block</span>
          <span className="kbds" style={{ flex: "none" }}>
            <kbd>/</kbd>
          </span>
        </div>
        <div className="shortcut-row">
          <span>Open link</span>
          <span className="kbds" style={{ flex: "none" }}>
            <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
            <kbd>Click</kbd>
          </span>
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const requested = useStore((s) => s.settingsSection) as Section | null;
  const [section, setSection] = useState<Section>(requested ?? "appearance");
  useEffect(() => {
    if (requested) {
      setSection(requested);
      setState({ settingsSection: null });
    }
  }, [requested]);
  const close = () => {
    setState({ settingsOpen: false });
    requestAnimationFrame(() => bridge.focus());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !getState().palette && !getState().dialog) {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const reset = () => {
    const s = getState().settings;
    set({
      ...DEFAULT_SETTINGS,
      viewMode: s.viewMode,
      sidebarOpen: s.sidebarOpen,
      sidebarTab: s.sidebarTab,
      sidebarWidth: s.sidebarWidth,
      aiModel: s.aiModel,
      aiProvider: s.aiProvider,
      aiEndpoint: s.aiEndpoint,
      aiEndpointModel: s.aiEndpointModel,
      aiEndpointKey: s.aiEndpointKey,
    });
  };

  const sections: { id: Section; label: string }[] = [
    { id: "appearance", label: "Appearance" },
    { id: "writing", label: "Writing" },
    { id: "editor", label: "Editor" },
    { id: "ai", label: "AI" },
    { id: "shortcuts", label: "Shortcuts" },
  ];

  return (
    <>
      <div className="settings-scrim" onMouseDown={close} />
      <aside className="settings popover" role="dialog" aria-label="Settings">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={reset} data-tip="Restore defaults">
            <RotateCcw size={15} />
          </button>
          <button className="icon-btn" onClick={close} data-tip="Close" data-kbd="Esc">
            <X size={16} />
          </button>
        </div>
        <nav className="settings-nav">
          {sections.map((s) => (
            <button key={s.id} className={section === s.id ? "is-active" : ""} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {section === "appearance" && <Appearance />}
          {section === "writing" && <Writing />}
          {section === "editor" && <EditorSection />}
          {section === "ai" && <AiSettings Switch={Switch} />}
          {section === "shortcuts" && <Shortcuts />}
          {section !== "shortcuts" && (
            <div className="set-group about">
              <span className="brand-mark" aria-hidden />
              <div>
                <div className="about-name">Margin</div>
                <div className="about-meta">Version 1.0 · Markdown, beautifully.</div>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
