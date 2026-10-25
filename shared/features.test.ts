import { describe, expect, it } from "vite-plus/test";
import { parseFeatures, summarizeTasks } from "./features";

describe("feature settings", () => {
  it("accepts the initial state and every catalog setting", () => {
    expect(parseFeatures({ color: "blue" })).toEqual({ color: "blue" });
    const features = {
      color: "pink",
      points: { per: 100 },
      progress: { number: false },
      celebrate: { face: "🐱", msg: "すごい！" },
    };
    expect(parseFeatures(features)).toEqual(features);
  });

  it.each([
    null,
    [],
    {},
    { color: "purple" },
    { color: "blue", points: { per: -10 } },
    { color: "blue", progress: { number: "true" } },
    { color: "blue", celebrate: { face: "🐱", msg: "" } },
    { color: "blue", celebrate: { face: "🐱", msg: "x".repeat(81) } },
    { color: "blue", celebrate: { face: "unknown", msg: "hello" } },
    { color: "blue", extra: true },
    { color: "blue", points: { per: 10, extra: true } },
  ])("rejects unsupported or malformed settings %#", (input) => {
    expect(() => parseFeatures(input)).toThrow();
  });
});

describe("study progress", () => {
  const features = parseFeatures({
    color: "blue",
    points: { per: 10 },
    progress: { number: true },
    celebrate: { face: "🥳", msg: "よくがんばりました！" },
  });

  it("recomputes points and rounded progress when completion changes", () => {
    const tasks = [{ done: true }, { done: false }, { done: false }];
    expect(summarizeTasks(tasks, features)).toEqual({
      done: 1,
      percent: 33,
      points: 10,
      celebrate: false,
    });
    tasks[0] = { done: false };
    expect(summarizeTasks(tasks, features).points).toBe(0);
  });

  it("celebrates only a nonempty completed list when enabled", () => {
    expect(summarizeTasks([], features)).toEqual({
      done: 0,
      percent: 0,
      points: 0,
      celebrate: false,
    });
    expect(summarizeTasks([{ done: true }], features).celebrate).toBe(true);
    expect(summarizeTasks([{ done: true }], { color: "blue" })).toEqual({
      done: 1,
      percent: 100,
      points: 0,
      celebrate: false,
    });
  });
});
