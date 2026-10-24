import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildCatalog } from "./catalogBuild";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("catalog build feedback", () => {
  it("keeps a fast update in the building state for1.6seconds", async () => {
    const finished = vi.fn();
    const build = buildCatalog(async () => "applied").then(finished);
    await vi.advanceTimersByTimeAsync(1599);
    expect(finished).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await build;
    expect(finished).toHaveBeenCalledWith("applied");
  });

  it("does not add another delay after a slower update", async () => {
    const build = buildCatalog(
      () => new Promise((resolve) => setTimeout(() => resolve("applied"), 2500)),
    );
    await vi.advanceTimersByTimeAsync(2500);
    await expect(build).resolves.toBe("applied");
  });

  it("preserves the failure after the loading feedback", async () => {
    const failure = new Error("not applied");
    const build = buildCatalog(async () => {
      throw failure;
    });
    const check = expect(build).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1600);
    await check;
  });
});
