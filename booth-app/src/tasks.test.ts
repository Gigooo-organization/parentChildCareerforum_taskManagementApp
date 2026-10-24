import { describe, expect, it } from "vite-plus/test";
import { candidates, initialTasks } from "./tasks";

describe("task choices", () => {
  it("offers sixteen distinct activities including the initial three", () => {
    const titles = Object.values(candidates).flat();
    expect(new Set(titles).size).toBe(16);
    for (const task of initialTasks()) expect(titles).toContain(task.title);
  });

  it("starts each participant with fresh unchecked tasks", () => {
    const previous = initialTasks();
    for (const task of previous) task.done = true;
    expect(initialTasks().every((task) => !task.done)).toBe(true);
  });
});
