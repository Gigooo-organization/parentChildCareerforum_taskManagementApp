import { describe, expect, it } from "vite-plus/test";
import { aiProviders, aiSelectionLabel, parseAiSelection } from "./ai";

describe("generation AI selection boundary", () => {
  it("accepts every offered provider-model pair and supplies its display label", () => {
    for (const provider of aiProviders)
      for (const model of provider.models) {
        const selected = { provider: provider.id, model: model.id };
        expect(parseAiSelection(selected)).toEqual(selected);
        expect(aiSelectionLabel(parseAiSelection(selected))).toBe(
          `${provider.label} / ${model.label}`,
        );
      }
  });
  it.each([
    null,
    {},
    { provider: "other", model: "default" },
    { provider: "codex", model: "opus" },
    { provider: "claude", model: "gpt-6-luna" },
    { provider: "codex", model: "--dangerous" },
    { provider: "claude", model: "unknown" },
    { provider: ["codex"], model: "default" },
    { provider: "codex", model: null },
  ])("rejects unknown and cross-provider model pairs %#", (input) => {
    expect(() => parseAiSelection(input)).toThrow();
  });
});
