import { describe, expect, it } from "vite-plus/test";
import { candidates, initialTasks } from "./tasks";

describe("task choices", () => {
  it("offers sixteen distinct activities including the six starting tasks", () => {
    const titles = Object.values(candidates).flat();
    expect(new Set(titles).size).toBe(16);
    const startingTitles = initialTasks().map((task) => task.title);
    expect(new Set(startingTitles).size).toBe(6);
    for (const title of startingTitles) expect(titles).toContain(title);
  });

  it("starts each participant with fresh unchecked tasks", () => {
    const previous = initialTasks();
    for (const task of previous) task.done = true;
    expect(initialTasks().every((task) => !task.done)).toBe(true);
  });
});
