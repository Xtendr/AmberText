import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileEntry } from "../lib/platform";

export type ViewMode = "write" | "split" | "read";
export type ThemePref = "system" | "light" | "dark";
export type Accent = "amber" | "vermilion" | "ink" | "moss" | "plum" | "ocean" | "graphite";
export type WritingFont = "serif" | "sans" | "mono";
export type SidebarTab = "files" | "outline";

export interface Settings {
  theme: ThemePref;
  accent: Accent;
  material: boolean;
  font: WritingFont;
  fontSize: number;
  lineHeight: number;
  measure: number;
  livePreview: boolean;
  focusMode: boolean;
  typewriter: boolean;
  spellcheck: boolean;
  autosave: boolean;
  quietChrome: boolean;
  viewMode: ViewMode;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  sidebarWidth: number;
  /** Show AI affordances (toolbar, menus, palette). */
  aiEnabled: boolean;
  /** Active local model tier, once one has been downloaded. */
  aiModel: "compact" | "standard" | "enhanced" | null;
  /** "local" runs AmberText's own runtime; "custom" talks to an OpenAI-compatible server (Ollama, LM Studio…). */
  aiProvider: "local" | "custom";
  aiEndpoint: string;
  aiEndpointModel: string;
  aiEndpointKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accent: "amber",
  material: false,
  font: "sans",
  fontSize: 18,
  lineHeight: 1.7,
  measure: 70,
  livePreview: true,
  focusMode: false,
  typewriter: false,
  spellcheck: true,
  autosave: true,
  quietChrome: false,
  viewMode: "write",
  sidebarOpen: true,
  sidebarTab: "files",
  sidebarWidth: 256,
  aiEnabled: true,
  aiModel: null,
  aiProvider: "local",
  aiEndpoint: "http://localhost:11434/v1",
  aiEndpointModel: "",
  aiEndpointKey: "",
};

export interface Doc {
  id: string;
  path: string | null;
  /** Fallback display name for untitled documents. */
  name: string;
  content: string;
  savedContent: string;
  mtime: number;
  eol: "\n" | "\r\n";
  saving: boolean;
  lastSavedAt: number | null;
  /** Content changed on disk while we had unsaved edits. */
  conflict: boolean;
}

export interface CursorInfo {
  line: number;
  col: number;
  selChars: number;
  selWords: number;
  pos: number;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "success" | "error";
  action?: { label: string; run: () => void };
}

export interface DialogAction {
  id: string;
  label: string;
  kind?: "primary" | "danger" | "default";
}

export interface DialogState {
  title: string;
  message?: string;
  actions: DialogAction[];
  input?: { value: string; placeholder?: string; selectUntil?: number };
}

export interface MenuItem {
  id?: string;
  label?: string;
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export type TreeEdit =
  | { kind: "new-file" | "new-folder"; parent: string }
  | { kind: "rename"; path: string };

export type PaletteMode = "files" | "commands" | "headings";

interface Workspace {
  root: string;
  tree: FileEntry[];
}

export interface AppState {
  settings: Settings;
  recentFiles: string[];
  recentFolders: string[];
  /** Word targets keyed by file path (or `draft:<id>` for unsaved documents). */
  goals: Record<string, number>;

  docs: Doc[];
  activeId: string | null;
  workspace: Workspace | null;
  expanded: string[];
  treeEdit: TreeEdit | null;

  cursor: CursorInfo;
  palette: PaletteMode | null;
  settingsOpen: boolean;
  /** Section to show when the settings drawer opens. */
  settingsSection: string | null;
  zen: boolean;
  typing: boolean;
  dark: boolean;
  materialActive: boolean;
  maximized: boolean;
  fullscreen: boolean;
  dialog: DialogState | null;
  toasts: Toast[];
  contextMenu: ContextMenuState | null;
  dropActive: boolean;

  setSettings: (patch: Partial<Settings>) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      settings: DEFAULT_SETTINGS,
      recentFiles: [],
      recentFolders: [],
      goals: {},

      docs: [],
      activeId: null,
      workspace: null,
      expanded: [],
      treeEdit: null,

      cursor: { line: 1, col: 1, selChars: 0, selWords: 0, pos: 0 },
      palette: null,
      settingsOpen: false,
      settingsSection: null,
      zen: false,
      typing: false,
      dark: false,
      materialActive: false,
      maximized: false,
      fullscreen: false,
      dialog: null,
      toasts: [],
      contextMenu: null,
      dropActive: false,

      setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: "margin:prefs",
      version: 4,
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        if (version < 2 && p.settings) p.settings = { ...p.settings, font: "sans", quietChrome: false };
        if (version < 3 && p.settings) p.settings = { ...p.settings, material: false };
        if (version < 4 && p.settings?.accent === "vermilion") p.settings = { ...p.settings, accent: "amber" };
        return p as AppState;
      },
      partialize: (s) => ({
        settings: s.settings,
        recentFiles: s.recentFiles,
        recentFolders: s.recentFolders,
        goals: s.goals,
        expanded: s.expanded,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AppState>;
        return {
          ...current,
          ...p,
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
        };
      },
    },
  ),
);

export const getState = useStore.getState;
export const setState = useStore.setState;

export function activeDoc(s: AppState = getState()): Doc | null {
  return s.docs.find((d) => d.id === s.activeId) ?? null;
}

export const goalKey = (d: Doc) => d.path ?? `draft:${d.id}`;

export function isDirty(d: Doc): boolean {
  return d.content !== d.savedContent;
}
