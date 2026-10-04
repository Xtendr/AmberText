import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileEntry } from "../lib/platform";

export type ViewMode = "write" | "split" | "read";
export type ThemePref = "system" | "light" | "dark";
export type Accent = "vermilion" | "ink" | "moss" | "plum" | "ocean" | "graphite";
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  accent: "vermilion",
  material: true,
  font: "serif",
  fontSize: 18,
  lineHeight: 1.7,
  measure: 70,
  livePreview: true,
  focusMode: false,
  typewriter: false,
  spellcheck: true,
  autosave: true,
  quietChrome: true,
  viewMode: "write",
  sidebarOpen: true,
  sidebarTab: "files",
  sidebarWidth: 256,
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

  docs: Doc[];
  activeId: string | null;
  workspace: Workspace | null;
  expanded: string[];
  treeEdit: TreeEdit | null;

  cursor: CursorInfo;
  palette: PaletteMode | null;
  settingsOpen: boolean;
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

      docs: [],
      activeId: null,
      workspace: null,
      expanded: [],
      treeEdit: null,

      cursor: { line: 1, col: 1, selChars: 0, selWords: 0, pos: 0 },
      palette: null,
      settingsOpen: false,
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
      version: 1,
      partialize: (s) => ({
        settings: s.settings,
        recentFiles: s.recentFiles,
        recentFolders: s.recentFolders,
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

export function isDirty(d: Doc): boolean {
  return d.content !== d.savedContent;
}
