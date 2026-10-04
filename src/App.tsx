import { useEffect, useLayoutEffect, type CSSProperties } from "react";
import { useStore, activeDoc, isDirty, getState, setState } from "./state/store";
import {
  applyAppearance,
  checkExternalChanges,
  displayName,
  flushAll,
  handleDroppedPaths,
  openPaths,
  refreshTree,
  toggleZen,
} from "./state/actions";
import { handleGlobalKey, MENU_TO_COMMAND, runCommand } from "./commands";
import { isMac, onFileDrop, onNativeEvent, takeLaunchFiles, win } from "./lib/platform";
import { resetMermaidTheme } from "./lib/mermaid";
import { bridge } from "./editor/bridge";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Sheet } from "./components/Sheet";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsPanel } from "./components/SettingsPanel";
import { DialogHost, ToastHost, ContextMenuHost, TooltipHost, DropOverlay } from "./components/Overlays";

const FONT_STACKS = {
  serif: "var(--font-serif)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
};

export function App() {
  const settings = useStore((s) => s.settings);
  const typing = useStore((s) => s.typing);
  const zen = useStore((s) => s.zen);
  const fullscreen = useStore((s) => s.fullscreen);
  const palette = useStore((s) => s.palette);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const dark = useStore((s) => s.dark);
  const title = useStore((s) => {
    const d = activeDoc(s);
    return d ? `${displayName(d)}${isDirty(d) ? " •" : ""}` : "";
  });

  useEffect(() => {
    void applyAppearance();
  }, [settings.theme, settings.accent, settings.material]);

  useEffect(() => {
    resetMermaidTheme();
  }, [dark, settings.accent]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.font = settings.font;
    root.style.setProperty("--font-writing", FONT_STACKS[settings.font]);
    const size = settings.font === "mono" ? settings.fontSize - 2 : settings.font === "sans" ? settings.fontSize - 1 : settings.fontSize;
    root.style.setProperty("--writing-size", `${size}px`);
    root.style.setProperty("--writing-lh", String(settings.lineHeight));
    root.style.setProperty("--measure", `${settings.measure}ch`);
  }, [settings.font, settings.fontSize, settings.lineHeight, settings.measure]);

  useEffect(() => {
    void win.setTitle(title ? `${title} — Margin` : "Margin");
  }, [title]);

  // Global keyboard, chrome fading and modifier tracking.
  useEffect(() => {
    let lastX = -1;
    let lastY = -1;
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      document.documentElement.classList.toggle("mod-down", mod);
      if (e.key === "Escape") {
        const s = getState();
        if (s.contextMenu) return setState({ contextMenu: null });
        if (s.zen && !s.palette && !s.dialog && !s.settingsOpen) return void toggleZen(false);
      }
      if (getState().dialog) return;
      handleGlobalKey(e);
      const idle = !document.activeElement || document.activeElement === document.body;
      const s = getState();
      if (!e.defaultPrevented && idle && !e.ctrlKey && !e.metaKey && !e.altKey && s.activeId && s.settings.viewMode !== "read" && !s.palette) {
        if (e.key.length === 1 || /^(Arrow|Enter|Backspace|Page|Home|End)/.test(e.key)) bridge.focus();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      document.documentElement.classList.toggle("mod-down", isMac ? e.metaKey : e.ctrlKey);
    };
    const onMove = (e: MouseEvent) => {
      if (!getState().typing) return;
      if (lastX < 0 || Math.hypot(e.clientX - lastX, e.clientY - lastY) > 6) {
        if (lastX >= 0) setState({ typing: false });
        lastX = e.clientX;
        lastY = e.clientY;
      }
    };
    const onTypingReset = () => {
      lastX = -1;
    };
    const onBlur = () => document.documentElement.classList.remove("mod-down");
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mousedown", onTypingReset);
    window.addEventListener("blur", onBlur);
    const unsub = useStore.subscribe((s, prev) => {
      if (s.typing && !prev.typing) lastX = -1;
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mousedown", onTypingReset);
      window.removeEventListener("blur", onBlur);
      unsub();
    };
  }, []);

  // Native window integration.
  useEffect(() => {
    const sync = async () => {
      setState({ maximized: await win.isMaximized(), fullscreen: await win.isFullscreen() });
    };
    void sync();
    const offResize = win.onResized(() => void sync());
    const offFocus = win.onFocus(() => {
      void checkExternalChanges();
      void refreshTree();
    });
    const offClose = win.onCloseRequested(async () => {
      await flushAll();
    });
    const offMenu = onNativeEvent<string>("menu", (id) => {
      const cmd = MENU_TO_COMMAND[id];
      if (cmd) runCommand(cmd);
    });
    const offOpen = onNativeEvent<string[]>("open-files", async () => {
      await openPaths(await takeLaunchFiles());
    });
    const offDrop = onFileDrop((e) => {
      if (e.type === "enter" || e.type === "over") {
        if (!getState().dropActive) setState({ dropActive: true });
      } else {
        setState({ dropActive: false });
        if (e.type === "drop" && e.paths.length) void handleDroppedPaths(e.paths, e.x, e.y);
      }
    });
    const persist = () => void flushAll();
    window.addEventListener("pagehide", persist);
    requestAnimationFrame(() => requestAnimationFrame(() => void win.show()));
    return () => {
      offResize();
      offFocus();
      offClose();
      offMenu();
      offOpen();
      offDrop();
      window.removeEventListener("pagehide", persist);
    };
  }, []);

  const style = { "--sidebar-w": `${settings.sidebarWidth}px` } as CSSProperties;

  return (
    <div
      className="app"
      style={style}
      data-sidebar={settings.sidebarOpen ? "open" : "closed"}
      data-typing={typing && settings.quietChrome && !palette && !settingsOpen ? "true" : "false"}
      data-zen={zen ? "true" : "false"}
      data-fullscreen={fullscreen ? "true" : "false"}
    >
      <TitleBar />
      <div className="body">
        <Sidebar />
        <Sheet />
      </div>
      {settingsOpen && <SettingsPanel />}
      {palette && <CommandPalette key={palette} mode={palette} />}
      <DropOverlay />
      <ToastHost />
      <ContextMenuHost />
      <DialogHost />
      <TooltipHost />
    </div>
  );
}
