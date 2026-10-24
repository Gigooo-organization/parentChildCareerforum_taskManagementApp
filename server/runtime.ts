import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyFiles,
  readSource,
  runAgent,
  runCommand,
  type AgentOutput,
  type Provider,
} from "./agent";
import { createQueue } from "./queue";
import { assertPreviewSource } from "./preview";
import type { Workspace } from "./workspace";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
type Snapshot = { files: AgentOutput["files"]; changed: string[] };

export function createBoothRuntime(workspace: Workspace, provider: Provider, execute = runAgent) {
  let active: Snapshot | undefined;
  let healthy = true;
  let closed = false;
  let resetting: Promise<void> | undefined;
  const queue = createQueue<Snapshot>({
    exclusive: (operation) =>
      workspace.serialize(async () => {
        if (!healthy || closed) throw new Error("作業フォルダをリセットしてください。");
        await operation();
      }),
    async snapshot() {
      try {
        active = { files: await readSource(workspace.appDir), changed: [] };
        return active;
      } catch (error) {
        healthy = false;
        throw error;
      }
    },
    execute: (prompt, signal, onProgress) =>
      execute({ provider, appDir: workspace.appDir, prompt, signal, onProgress }),
    async apply(output) {
      if (!active) throw new Error("変更前の状態を読み取れませんでした。");
      for (const file of output.files) assertPreviewSource(file.content, file.path);
      active.changed = output.files.map((file) => file.path);
      await applyFiles(workspace.appDir, output.files);
    },
    async restore(previous) {
      try {
        for (const path of previous.changed) {
          const original = previous.files.find((file) => file.path === path);
          if (original) await applyFiles(workspace.appDir, [original]);
          else await rm(join(workspace.appDir, path), { force: true });
        }
      } catch (error) {
        healthy = false;
        throw error;
      }
    },
    async validate(signal) {
      try {
        await readSource(workspace.appDir);
        await runCommand({
          file: process.execPath,
          args: [
            join(repoRoot, "node_modules", "vite-plus", "bin", "vp"),
            "build",
            workspace.appDir,
            "--config",
            join(repoRoot, "server", "participant.config.ts"),
          ],
          cwd: repoRoot,
          env: {
            ...process.env,
            BOOTH_APP_DIR: workspace.appDir,
            BOOTH_BUILD_DIR: join(workspace.root, ".booth", "build"),
          },
          signal,
        });
      } catch {
        signal.throwIfAborted();
        throw new Error("変更したアプリを確認できなかったため、変更前に戻しました。");
      }
    },
  });

  return {
    queue,
    assertHealthy() {
      if (!healthy || resetting || closed)
        throw new Error("スタッフが「次の人へ」でリセットしてください。");
    },
    reset() {
      if (closed) return Promise.reject(new Error("アプリは終了しています。"));
      if (!resetting) {
        healthy = false;
        resetting = (async () => {
          await queue.reset();
          await workspace.reset();
          healthy = true;
        })().finally(() => {
          resetting = undefined;
        });
      }
      return resetting;
    },
    async close() {
      closed = true;
      await resetting;
      await queue.reset();
    },
  };
}
