import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauri, onNativeEvent } from "../lib/platform";
import { getState } from "../state/store";
import { MODELS, modelById, type ModelInfo, type ModelTier } from "./models";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ServerInfo {
  url: string;
  key: string;
  model: string;
}

interface Progress {
  stage: "runtime" | "model";
  received: number;
  total: number;
}

interface AiRuntime {
  checked: boolean;
  supported: boolean;
  /** Downloaded model files. */
  installed: string[];
  installing: ModelTier | null;
  progress: Progress | null;
  server: ServerInfo | null;
  starting: boolean;
  error: string | null;
}

export const useAi = create<AiRuntime>(() => ({
  checked: false,
  supported: isTauri,
  installed: [],
  installing: null,
  progress: null,
  server: null,
  starting: false,
  error: null,
}));

const setAi = useAi.setState;

interface StatusPayload {
  runtimeInstalled: boolean;
  runtimeSupported: boolean;
  installed: string[];
  server: ServerInfo | null;
  installing: boolean;
}

export async function refreshAi() {
  if (!isTauri) {
    setAi({ checked: true, supported: false });
    return;
  }
  try {
    const s = await invoke<StatusPayload>("ai_status");
    setAi({ checked: true, supported: s.runtimeSupported, installed: s.installed, server: s.server });
    const pref = getState().settings.aiModel;
    if (pref && !s.installed.includes(modelById(pref)?.file ?? "")) {
      const fallback = MODELS.slice().reverse().find((m) => s.installed.includes(m.file));
      getState().setSettings({ aiModel: fallback?.id ?? null });
    }
  } catch {
    setAi({ checked: true, supported: false });
  }
}

export function isInstalled(m: ModelInfo, installed = useAi.getState().installed) {
  return installed.includes(m.file);
}

/** The model a request would use right now, or null when AI isn't set up. */
export function activeModelLabel(): string | null {
  const s = getState().settings;
  if (s.aiProvider === "custom") return s.aiEndpoint.trim() ? s.aiEndpointModel.trim() || "Local server" : null;
  const m = modelById(s.aiModel);
  return m && isInstalled(m) ? m.model : null;
}

export function aiReady(): boolean {
  return activeModelLabel() !== null;
}

export async function installModel(tier: ModelTier): Promise<boolean> {
  const m = modelById(tier);
  if (!m || !isTauri || useAi.getState().installing) return false;
  setAi({ installing: tier, progress: { stage: "runtime", received: 0, total: 0 }, error: null });
  const off = onNativeEvent<Progress>("ai-progress", (p) => setAi({ progress: p }));
  try {
    await invoke("ai_install", { model: { file: m.file, url: m.url, sha256: m.sha256, size: m.size } });
    await refreshAi();
    getState().setSettings({ aiModel: tier, aiProvider: "local" });
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg !== "cancelled") setAi({ error: msg });
    return false;
  } finally {
    off();
    setAi({ installing: null, progress: null });
  }
}

export function cancelInstall() {
  if (isTauri) void invoke("ai_cancel_install");
}

export async function removeModel(tier: ModelTier) {
  const m = modelById(tier);
  if (!m || !isTauri) return;
  await invoke("ai_remove", { file: m.file });
  if (useAi.getState().server?.model === m.file) setAi({ server: null });
  await refreshAi();
}

export async function stopServer() {
  if (!isTauri) return;
  await invoke("ai_stop").catch(() => {});
  setAi({ server: null });
}

let starting: Promise<ServerInfo> | null = null;

async function endpoint(): Promise<{ url: string; key: string; model: string }> {
  const s = getState().settings;
  if (s.aiProvider === "custom") {
    let base = s.aiEndpoint.trim().replace(/\/+$/, "");
    if (!/\/chat\/completions$/.test(base)) base = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    return { url: base, key: s.aiEndpointKey.trim(), model: s.aiEndpointModel.trim() || "default" };
  }
  const m = modelById(s.aiModel);
  if (!m || !isTauri) throw new Error("No local model is set up yet");
  // ai_start returns at once when the server is already up; asking every time
  // picks up a restart after the native side unloaded an idle model.
  if (!starting) {
    if (useAi.getState().server?.model !== m.file) setAi({ starting: true, error: null });
    starting = invoke<ServerInfo>("ai_start", { file: m.file })
      .then((info) => {
        setAi({ server: info });
        return info;
      })
      .finally(() => {
        starting = null;
        setAi({ starting: false });
      });
  }
  const info = await starting;
  return { url: `${info.url}/v1/chat/completions`, key: info.key, model: m.file };
}

/** Warm the model up so the first request feels instant. */
export function prewarm() {
  if (getState().settings.aiProvider === "local" && aiReady()) void endpoint().catch(() => {});
}

export interface ChatOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onToken?: (delta: string) => void;
}

let reqSeq = 0;

export interface ChatResult {
  text: string;
  /** "stop", "length" (hit the token cap) or "cancelled". */
  finish: string;
}

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const ep = await endpoint();
  if (opts.signal?.aborted) return { text: "", finish: "cancelled" };
  const body = {
    model: ep.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.3,
    top_p: 0.9,
    max_tokens: opts.maxTokens ?? 1200,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (isTauri) {
    const id = `r${++reqSeq}-${Date.now()}`;
    const channel = new Channel<string>();
    channel.onmessage = (t) => opts.onToken?.(t);
    const abort = () => void invoke("ai_cancel", { id });
    opts.signal?.addEventListener("abort", abort);
    try {
      return await invoke<ChatResult>("ai_chat", { id, url: ep.url, key: ep.key || null, body, onToken: channel });
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
  }
  return await fetchStream(ep.url, ep.key, body, opts);
}

async function fetchStream(url: string, key: string, body: unknown, opts: ChatOptions): Promise<ChatResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: opts.signal,
  }).catch((e) => {
    if (opts.signal?.aborted) return null;
    throw new Error(`Couldn't reach the model — ${e instanceof Error ? e.message : e}`);
  });
  if (!res) return { text: "", finish: "cancelled" };
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`The model returned an error (${res.status}) — ${msg}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";
  let finish = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return { text: full, finish };
        try {
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error.message ?? "The model returned an error");
          const delta: string | undefined = json.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            opts.onToken?.(delta);
          }
          if (json.choices?.[0]?.finish_reason) finish = json.choices[0].finish_reason;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) return { text: full, finish: "cancelled" };
    throw e;
  }
  return { text: full, finish };
}
