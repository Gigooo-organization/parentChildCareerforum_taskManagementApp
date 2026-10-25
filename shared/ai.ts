export const aiProviders = [
  {
    id: "codex",
    label: "Codex",
    models: [
      { id: "default", label: "標準モデル" },
      { id: "gpt-6.1-sol", label: "GPT-6.1-Sol" },
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-6-luna", label: "GPT-6-Luna" },
    ],
  },
  {
    id: "claude",
    label: "Claude Code",
    models: [
      { id: "default", label: "標準モデル" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "fable", label: "Fable" },
    ],
  },
] as const;

export type AiSelection =
  | { provider: "codex"; model: (typeof aiProviders)[0]["models"][number]["id"] }
  | { provider: "claude"; model: (typeof aiProviders)[1]["models"][number]["id"] };

export function parseAiSelection(value: unknown): AiSelection {
  if (typeof value === "object" && value !== null && "provider" in value && "model" in value) {
    if (value.provider === "codex") {
      const model = aiProviders[0].models.find((model) => model.id === value.model);
      if (model) return { provider: "codex", model: model.id };
    } else if (value.provider === "claude") {
      const model = aiProviders[1].models.find((model) => model.id === value.model);
      if (model) return { provider: "claude", model: model.id };
    }
  }
  throw new Error("作成用AIとモデルを選びなおしてください。");
}

export function aiSelectionLabel(selection: AiSelection) {
  const provider = aiProviders.find((provider) => provider.id === selection.provider);
  const model = provider?.models.find((model) => model.id === selection.model);
  return `${provider?.label} / ${model?.label}`;
}
