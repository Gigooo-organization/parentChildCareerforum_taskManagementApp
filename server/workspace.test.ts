import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "booth-workspace-"));
  roots.push(root);
  await mkdir(join(root, "booth-app", "src"), { recursive: true });
  await writeFile(join(root, "booth-app", "features.json"), '{"color":"blue"}');
  await writeFile(join(root, "booth-app", "src", "App.vue"), "initial source");
  const workspace = new Workspace(root);
  await workspace.reset();
  return { root, workspace };
}

describe("participant workspace", () => {
  it("resets only the working copy and removes prior generated files", async () => {
    const { root, workspace } = await fixture();
    await workspace.writeFeatures({ color: "pink", points: { per: 10 } });
    await writeFile(join(workspace.appDir, "src", "extra.ts"), "old participant");
    await writeFile(join(workspace.appDir, "src", "App.vue"), "changed source");
    const revision = workspace.revision;
    await workspace.reset();
    expect(await workspace.readFeatures()).toEqual({ color: "blue" });
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toBe("initial source");
    await expect(readFile(join(workspace.appDir, "src", "extra.ts"))).rejects.toThrow();
    expect(await readFile(join(root, "booth-app", "src", "App.vue"), "utf8")).toBe(
      "initial source",
    );
    expect(workspace.revision).toBe(revision + 1);
  });
  it("rejects malformed settings without changing the working copy", async () => {
    const { workspace } = await fixture();
    await expect(workspace.writeFeatures({ color: "purple" })).rejects.toThrow();
    expect(await workspace.readFeatures()).toEqual({ color: "blue" });
  });
  it("serializes mutations and keeps working after a failed operation", async () => {
    const { workspace } = await fixture();
    const order: number[] = [];
    const first = workspace.serialize(async () => {
      order.push(1);
      await Promise.resolve();
      order.push(2);
      throw new Error("failure");
    });
    const next = workspace.serialize(async () => {
      order.push(3);
    });
    await expect(first).rejects.toThrow("failure");
    await next;
    expect(order).toEqual([1, 2, 3]);
  });
  it("does not overwrite a symlinked feature file or reset through a symlinked booth directory", async () => {
    const { root, workspace } = await fixture();
    const outside = join(root, "outside.json");
    await writeFile(outside, "protected");
    await rm(join(workspace.appDir, "features.json"));
    await symlink(outside, join(workspace.appDir, "features.json"));
    await expect(workspace.writeFeatures({ color: "green" })).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("protected");
    await rm(join(root, ".booth"), { recursive: true });
    await symlink(join(root, "booth-app"), join(root, ".booth"));
    await expect(workspace.reset()).rejects.toThrow();
    expect(await readFile(join(root, "booth-app", "features.json"), "utf8")).toBe(
      '{"color":"blue"}',
    );
  });
});
