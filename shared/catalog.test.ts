import { describe, expect, it } from "vite-plus/test";
import { actionFromAnswers, applyAction, catalog, instructionFor } from "./catalog";

describe("catalog choices", () => {
  it("requires every celebration answer before building", () => {
    expect(actionFromAnswers("celebrate", ["🐱"])).toBeNull();
    expect(actionFromAnswers("celebrate", ["🐱", "天才！"])).toEqual({
      kind: "celebrate",
      face: "🐱",
      msg: "天才！",
    });
    expect(actionFromAnswers("celebrate", ["unknown", "天才！"])).toBeNull();
  });
  it("keeps the bar-only choice and all supported point values", () => {
    expect(actionFromAnswers("progress", [false])).toEqual({ kind: "progress", number: false });
    for (const per of [5, 10, 100])
      expect(actionFromAnswers("points", [per])).toEqual({ kind: "points", per });
    expect(actionFromAnswers("points", [0])).toBeNull();
  });
  it("changes only the requested feature without mutating earlier settings", () => {
    const previous = { color: "blue", points: { per: 10 } } satisfies import("./features").Features;
    expect(applyAction(previous, { kind: "color", color: "pink" })).toEqual({
      color: "pink",
      points: { per: 10 },
    });
    expect(previous.color).toBe("blue");
  });
  it("offers all four themes including a way back to blue", () => {
    for (const color of ["blue", "pink", "green", "orange"] as const) {
      expect(catalog.some((card) => card.id === color)).toBe(true);
      expect(actionFromAnswers(color, [])).toEqual({ kind: "color", color });
    }
  });
  it("states the chosen specification in the instruction", () => {
    expect(instructionFor({ kind: "points", per: 100 })).toContain("100 ポイント");
    expect(instructionFor({ kind: "progress", number: false })).toContain("数字は出さず");
    expect(instructionFor({ kind: "celebrate", face: "🚀", msg: "天才！" })).toContain("🚀");
  });
});
