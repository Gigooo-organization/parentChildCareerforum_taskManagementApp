import { afterEach, describe, expect, it } from "vite-plus/test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace";
import { createBoothRuntime } from "./runtime";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const roots: string[] = [];
const runtimes: ReturnType<typeof createBoothRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "booth-runtime-"));
  roots.push(root);
  await cp(join(repoRoot, "booth-app"), join(root, "booth-app"), { recursive: true });
  const workspace = new Workspace(root);
  await workspace.reset();
  const source = await readFile(join(workspace.appDir, "src", "App.vue"), "utf8");
  return { root, workspace, source };
}
function finished(runtime: ReturnType<typeof createBoothRuntime>, id: string) {
  return new Promise<ReturnType<typeof runtime.queue.jobs>[number]>((resolve) => {
    const unsubscribe = runtime.queue.subscribe((jobs) => {
      const job = jobs.find((item) => item.id === id);
      if (job && !["pending", "queued", "running"].includes(job.status)) {
        unsubscribe();
        resolve(job);
      }
    });
  });
}

describe("booth AI runtime", () => {
  it("compiles a valid AI change while preserving catalog settings and template files", async () => {
    const { workspace, source, root } = await fixture();
    await workspace.writeFeatures({ color: "pink", points: { per: 10 } });
    const runtime = createBoothRuntime(workspace, "codex", async () => ({
      files: [
        {
          path: "src/App.vue",
          content: source.replaceAll("わたしの勉強リスト", "チャレンジリスト"),
        },
      ],
      message: "見出しを変えました。",
    }));
    runtimes.push(runtime);
    const job = runtime.queue.submit("見出しを変えて");
    const done = finished(runtime, job.id);
    runtime.queue.approve(job.id);
    expect((await done).status).toBe("succeeded");
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toContain(
      "チャレンジリスト",
    );
    expect(await workspace.readFeatures()).toEqual({ color: "pink", points: { per: 10 } });
    expect(await readFile(join(workspace.appDir, "src", "tasks.test.ts"), "utf8")).toContain(
      "task choices",
    );
    expect(await readFile(join(root, "booth-app", "src", "App.vue"), "utf8")).toBe(source);
    runtime.assertHealthy();
  }, 30_000);

  it("restores changed files and removes additions when the real Vue compiler rejects the change", async () => {
    const { workspace, source } = await fixture();
    const runtime = createBoothRuntime(workspace, "codex", async () => ({
      files: [
        {
          path: "src/App.vue",
          content:
            '<script setup lang="ts">import missing from "./missing";</script><template>{{ missing }}</template>',
        },
        { path: "src/extra.ts", content: "export const extra = true;" },
      ],
      message: "changed",
    }));
    runtimes.push(runtime);
    const job = runtime.queue.submit("壊れた変更のテスト");
    const done = finished(runtime, job.id);
    runtime.queue.approve(job.id);
    expect((await done).status).toBe("failed");
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toBe(source);
    await expect(readFile(join(workspace.appDir, "src", "extra.ts"))).rejects.toThrow();
    expect(await readFile(join(workspace.appDir, "src", "tasks.test.ts"), "utf8")).toContain(
      "task choices",
    );
    runtime.assertHealthy();
  }, 30_000);

  it("cancels the running agent before resetting the workcopy and blocks operations during reset", async () => {
    const { workspace, source } = await fixture();
    let started!: () => void;
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const runtime = createBoothRuntime(workspace, "codex", async ({ signal }) => {
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
      );
    });
    runtimes.push(runtime);
    const job = runtime.queue.submit("変更して");
    runtime.queue.approve(job.id);
    await executing;
    const resetting = runtime.reset();
    expect(() => runtime.assertHealthy()).toThrow();
    await resetting;
    runtime.assertHealthy();
    expect(runtime.queue.jobs()).toEqual([]);
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toBe(source);
  });

  it("rolls back a patch that exceeds the final app source budget", async () => {
    const { workspace, source } = await fixture();
    const runtime = createBoothRuntime(workspace, "codex", async () => ({
      files: [{ path: "src/padding.ts", content: "//" + "a".repeat(256 * 1024 - 50) }],
      message: "changed",
    }));
    runtimes.push(runtime);
    const job = runtime.queue.submit("変更して");
    const done = finished(runtime, job.id);
    runtime.queue.approve(job.id);
    expect((await done).status).toBe("failed");
    runtime.assertHealthy();
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toBe(source);
    await expect(readFile(join(workspace.appDir, "src", "padding.ts"))).rejects.toThrow();
  });

  it("rejects unsafe CSS before publishing generated source", async () => {
    const { workspace, source } = await fixture();
    const runtime = createBoothRuntime(workspace, "codex", async () => ({
      files: [
        { path: "src/App.vue", content: source.replaceAll("わたしの勉強リスト", "changed") },
        { path: "src/extra.css", content: '@import "../../outside.css";' },
      ],
      message: "changed",
    }));
    runtimes.push(runtime);
    const job = runtime.queue.submit("見た目を変えて");
    const done = finished(runtime, job.id);
    runtime.queue.approve(job.id);
    expect((await done).message).toContain("CSS");
    expect(await readFile(join(workspace.appDir, "src", "App.vue"), "utf8")).toBe(source);
    await expect(readFile(join(workspace.appDir, "src", "extra.css"))).rejects.toThrow();
  });

  it("blocks catalog mutations after rollback fails until a successful explicit reset", async () => {
    const { workspace, root } = await fixture();
    const protectedFile = join(root, "protected.txt");
    await writeFile(protectedFile, "protected");
    const runtime = createBoothRuntime(workspace, "codex", async () => {
      await rm(join(workspace.appDir, "src", "App.vue"));
      await symlink(protectedFile, join(workspace.appDir, "src", "App.vue"));
      return {
        files: [{ path: "src/App.vue", content: "<template>changed</template>" }],
        message: "changed",
      };
    });
    runtimes.push(runtime);
    const job = runtime.queue.submit("変更して");
    const done = finished(runtime, job.id);
    runtime.queue.approve(job.id);
    expect((await done).status).toBe("failed");
    expect(() => runtime.assertHealthy()).toThrow();
    expect(await readFile(protectedFile, "utf8")).toBe("protected");
    await runtime.reset();
    runtime.assertHealthy();
  });
});
