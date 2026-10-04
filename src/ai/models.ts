export type ModelTier = "compact" | "standard" | "enhanced";

export interface ModelInfo {
  id: ModelTier;
  name: string;
  model: string;
  file: string;
  url: string;
  sha256: string;
  size: number;
  memory: string;
  blurb: string;
  recommended?: boolean;
}

const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

/** Qwen3.5 (Apache 2.0), Q4_K_M quantisations, pinned to exact revisions. */
export const MODELS: ModelInfo[] = [
  {
    id: "compact",
    name: "Compact",
    model: "Qwen3.5 0.8B",
    file: "Qwen_Qwen3.5-0.8B-Q4_K_M.gguf",
    url: hf("bartowski/Qwen_Qwen3.5-0.8B-GGUF", "f36b1ea49a332ede8fe5f389bbf5b3575ef71f48", "Qwen_Qwen3.5-0.8B-Q4_K_M.gguf"),
    sha256: "fb044e93939a70469c905781334f5de1e6c8b608ced6cbc8c9249bd4127d9526",
    size: 579615840,
    memory: "Runs on almost anything",
    blurb: "Quick fixes — spelling, shortening, lists. Light on disk and memory.",
  },
  {
    id: "standard",
    name: "Standard",
    model: "Qwen3.5 2B",
    file: "Qwen_Qwen3.5-2B-Q4_K_M.gguf",
    url: hf("bartowski/Qwen_Qwen3.5-2B-GGUF", "7d26695454df6de5fbcce2e58681e62dae06ce43", "Qwen_Qwen3.5-2B-Q4_K_M.gguf"),
    sha256: "57a1085840f497d764a7fc5d346922dbde961efb54cc792ea81d694fd846a1d8",
    size: 1396198496,
    memory: "8 GB memory or more",
    blurb: "The best balance. Rewrites, tone, translation and document summaries.",
    recommended: true,
  },
  {
    id: "enhanced",
    name: "Enhanced",
    model: "Qwen3.5 4B",
    file: "Qwen_Qwen3.5-4B-Q4_K_M.gguf",
    url: hf("bartowski/Qwen_Qwen3.5-4B-GGUF", "4168f45a16a1290d65a4ec0fa312ae917a4c15d6", "Qwen_Qwen3.5-4B-Q4_K_M.gguf"),
    sha256: "13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983",
    size: 3013027808,
    memory: "16 GB memory recommended",
    blurb: "Noticeably sharper reasoning for document reviews and restructuring.",
  },
];

export const modelById = (id: string | null | undefined) => MODELS.find((m) => m.id === id) ?? null;

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}
