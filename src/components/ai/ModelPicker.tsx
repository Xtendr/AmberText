import { Check, Download, LoaderCircle, Trash2, X } from "lucide-react";
import { MODELS, formatBytes, type ModelInfo, type ModelTier } from "../../ai/models";
import { cancelInstall, installModel, isInstalled, removeModel, useAi } from "../../ai/engine";
import { useStore, getState } from "../../state/store";
import { ask } from "../../state/actions";

export function ProgressBar({ received, total }: { received: number; total: number }) {
  const pct = total ? Math.min(100, (received / total) * 100) : 0;
  return (
    <div className={`ai-progress${total ? "" : " is-indeterminate"}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: total ? `${pct}%` : undefined }} />
    </div>
  );
}

export function InstallStatus({ tier }: { tier: ModelTier }) {
  const progress = useAi((s) => s.progress);
  const m = MODELS.find((x) => x.id === tier)!;
  if (!progress) return null;
  const label =
    progress.stage === "runtime"
      ? "Preparing the local runtime…"
      : `Downloading ${m.name} · ${formatBytes(progress.received)} of ${formatBytes(progress.total || m.size)}`;
  return (
    <div className="ai-install">
      <div className="ai-install-row">
        <span>{label}</span>
        <button className="ai-link" onClick={cancelInstall}>
          Cancel
        </button>
      </div>
      <ProgressBar received={progress.stage === "runtime" ? 0 : progress.received} total={progress.stage === "runtime" ? 0 : progress.total || m.size} />
    </div>
  );
}

/** Radio-style tier list. In "manage" mode each row has its own install / remove controls. */
export function ModelPicker({
  value,
  onChange,
  manage = false,
}: {
  value: ModelTier | null;
  onChange: (t: ModelTier) => void;
  manage?: boolean;
}) {
  const installed = useAi((s) => s.installed);
  const installing = useAi((s) => s.installing);
  const active = useStore((s) => (s.settings.aiProvider === "local" ? s.settings.aiModel : null));

  const remove = async (m: ModelInfo) => {
    const r = await ask({
      title: `Remove the ${m.name} model?`,
      message: `This frees ${formatBytes(m.size)} of disk space. You can download it again at any time.`,
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "remove", label: "Remove", kind: "danger" },
      ],
    });
    if (r?.action === "remove") await removeModel(m.id);
  };

  return (
    <div className="ai-tiers" role="radiogroup" aria-label="Model">
      {MODELS.map((m) => {
        const has = isInstalled(m, installed);
        const selected = manage ? active === m.id : value === m.id;
        return (
          <div
            key={m.id}
            role="radio"
            tabIndex={0}
            aria-checked={selected}
            className={`ai-tier${selected ? " is-active" : ""}`}
            onClick={() => (!manage || has) && onChange(m.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (!manage || has) && onChange(m.id)}
          >
            <span className="ai-tier-radio" aria-hidden />
            <span className="ai-tier-text">
              <span className="ai-tier-name">
                {m.name}
                {m.recommended && <span className="ai-badge">Recommended</span>}
                {has && !manage && <span className="ai-badge quiet">Downloaded</span>}
              </span>
              <span className="ai-tier-desc">{m.blurb}</span>
              <span className="ai-tier-meta">
                {m.model} · {formatBytes(m.size)} · {m.memory}
              </span>
              {manage && installing === m.id && <InstallStatus tier={m.id} />}
            </span>
            {manage && (
              <span className="ai-tier-actions" onClick={(e) => e.stopPropagation()}>
                {installing === m.id ? (
                  <button className="icon-btn sm" onClick={cancelInstall} data-tip="Cancel download">
                    <X size={14} />
                  </button>
                ) : has ? (
                  <>
                    {selected && (
                      <span className="ai-tier-check" data-tip="In use">
                        <Check size={14} strokeWidth={2.4} />
                      </span>
                    )}
                    <button className="icon-btn sm" onClick={() => void remove(m)} data-tip="Remove model">
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : (
                  <button className="btn sm" disabled={!!installing} onClick={() => void installModel(m.id)}>
                    {installing ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}
                    {formatBytes(m.size)}
                  </button>
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function preferredTier(): ModelTier {
  return getState().settings.aiModel ?? "standard";
}
