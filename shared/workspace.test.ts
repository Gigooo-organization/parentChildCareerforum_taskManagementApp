import { describe, expect, it } from "vite-plus/test";
import { parseWorkspaceState } from "./workspace";

describe("workspace state boundary", () => {
  it("accepts a local preview and valid features", () => {
    const state = {
      features: { color: "pink" },
      previewUrl: "http://127.0.0.1:5174/",
      revision: 1,
    };
    expect(parseWorkspaceState(state)).toEqual(state);
  });
  it.each([
    null,
    {},
    { features: { color: "blue" }, previewUrl: "javascript:alert(1)", revision: 1 },
    { features: { color: "blue" }, previewUrl: "http://127.0.0.1:5174/", revision: -1 },
  ])("rejects unsafe or malformed state %#", (value) => {
    expect(() => parseWorkspaceState(value)).toThrow();
  });
});
