import { useEffect, useState } from "react";
import { FolderOpen, HardDrive, Server } from "lucide-react";
import { getState, useStore } from "../../state/store";
import { chat, refreshAi, stopServer, useAi } from "../../ai/engine";
import { fsApi, isMac, isTauri, fileManagerName } from "../../lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { ModelPicker } from "./ModelPicker";

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="ai-field">
      <span>{label}</span>
      <input className="dialog-input" type={type} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function AiSettings({ Switch }: { Switch: (p: { value: boolean; onChange: (v: boolean) => void; label: string }) => React.ReactElement }) {
  const s = useStore((st) => st.settings);
  const supported = useAi((st) => st.supported);
  const server = useAi((st) => st.server);
  const error = useAi((st) => st.error);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "fail"; msg?: string }>({ state: "idle" });
  const set = getState().setSettings;

  useEffect(() => {
    void refreshAi();
  }, []);

  const runTest = async () => {
    setTest({ state: "testing" });
    try {
      const { text: out } = await chat({ messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 8, temperature: 0 });
      setTest({ state: "ok", msg: out.trim() ? `Connected — the model replied “${out.trim().slice(0, 40)}”` : "Connected" });
    } catch (e) {
      setTest({ state: "fail", msg: e instanceof Error ? e.message : String(e) });
    }
  };

  const revealModels = async () => {
    if (!isTauri) return;
    const st = await invoke<{ dir: string }>("ai_status").catch(() => null);
    if (st?.dir) void fsApi.reveal(st.dir);
  };

  return (
    <>
      <div className="set-group">
        <h3>Assistant</h3>
        <div className="set-row">
          <div className="set-row-text">
            <div className="set-label">Show AI in the editor</div>
            <div className="set-desc">
              Select text and press{" "}
              <span className="kbds">
                <kbd>{isMac ? "⌘" : "Ctrl"}</kbd>
                <kbd>J</kbd>
              </span>{" "}
              to rewrite, shorten, translate or explain it. Ask about the whole document from the command palette.
            </div>
          </div>
          <Switch value={s.aiEnabled} onChange={(v) => set({ aiEnabled: v })} label="Show AI in the editor" />
        </div>
      </div>

      <div className="set-group">
        <h3>Model</h3>
        <div className="ai-provider seg" role="radiogroup" aria-label="Model source">
          <button role="radio" aria-checked={s.aiProvider === "local"} className={s.aiProvider === "local" ? "is-active" : ""} onClick={() => set({ aiProvider: "local" })}>
            <HardDrive size={13} /> Built-in
          </button>
          <button role="radio" aria-checked={s.aiProvider === "custom"} className={s.aiProvider === "custom" ? "is-active" : ""} onClick={() => set({ aiProvider: "custom" })}>
            <Server size={13} /> Local server
          </button>
        </div>

        {s.aiProvider === "local" ? (
          supported ? (
            <>
              <p className="set-desc ai-para">Download one model to get started. Standard is the best fit for most computers; you can switch or remove models any time.</p>
              <ModelPicker value={s.aiModel} onChange={(t) => set({ aiModel: t })} manage />
              {error && <p className="ai-error-text">{error}</p>}
              <div className="ai-row-links">
                {server && (
                  <button className="ai-link" onClick={() => void stopServer()}>
                    Unload model from memory
                  </button>
                )}
                <button className="ai-link" onClick={() => void revealModels()}>
                  <FolderOpen size={12} /> Show models in {fileManagerName}
                </button>
              </div>
              <p className="set-desc ai-para small">
                Models are Qwen3.5 by Alibaba Cloud (Apache 2.0), run with llama.cpp. They load when you first use AI and unload after a few idle minutes.
              </p>
            </>
          ) : (
            <p className="set-desc ai-para">Built-in models run in the Margin desktop app. Connect a local server (Ollama, LM Studio, llama.cpp) to try AI here.</p>
          )
        ) : (
          <>
            <p className="set-desc ai-para">Use a model server you already run, like Ollama, LM Studio or llama.cpp. Anything that speaks the OpenAI chat API works.</p>
            <Field label="Server address" value={s.aiEndpoint} onChange={(v) => set({ aiEndpoint: v })} placeholder="http://localhost:11434/v1" />
            <Field label="Model name" value={s.aiEndpointModel} onChange={(v) => set({ aiEndpointModel: v })} placeholder="e.g. qwen3.5:2b" />
            <Field label="API key (optional)" type="password" value={s.aiEndpointKey} onChange={(v) => set({ aiEndpointKey: v })} placeholder="Not needed for most local servers" />
            <div className="ai-test">
              <button className="btn sm" onClick={() => void runTest()} disabled={test.state === "testing" || !s.aiEndpoint.trim()}>
                {test.state === "testing" ? "Testing…" : "Test connection"}
              </button>
              {test.msg && <span className={`ai-test-msg ${test.state}`}>{test.msg}</span>}
            </div>
            {!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(s.aiEndpoint.trim()) && s.aiEndpoint.trim() && (
              <p className="ai-note warn">This address isn't on your computer — your text will be sent to it.</p>
            )}
          </>
        )}
      </div>

      {s.aiProvider === "local" && (
        <div className="set-group">
          <h3>Privacy</h3>
          <dl className="ai-facts">
            <div>
              <dt>Runs on</dt>
              <dd>This computer</dd>
            </div>
            <div>
              <dt>Text sent online</dt>
              <dd>Never</dd>
            </div>
            <div>
              <dt>Account</dt>
              <dd>Not required</dd>
            </div>
          </dl>
        </div>
      )}
    </>
  );
}
