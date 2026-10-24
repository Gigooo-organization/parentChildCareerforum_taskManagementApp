import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import vize from "@vizejs/vite-plugin";
import { Workspace } from "./workspace";
import { previewBoundary } from "./preview";
import { createBoothRuntime } from "./runtime";
import { createChatApi } from "./chat-api";

import { HttpError, assertLocalRequest, readJson, sendJson } from "./http";

export function createBoothMiddleware(
  workspace: Workspace,
  previewUrl: () => string,
  runtime?: ReturnType<typeof createBoothRuntime>,
  resetPreview?: () => Promise<void>,
) {
  const state = async () => ({
    features: await workspace.readFeatures(),
    previewUrl: previewUrl(),
    revision: workspace.revision,
  });
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = req.url?.split("?", 1)[0];
    if (!path?.startsWith("/api/")) {
      next();
      return;
    }
    void (async () => {
      assertLocalRequest(req);
      if (path === "/api/state" && req.method === "GET") {
        sendJson(res, 200, await state());
      } else if (path === "/api/features" && req.method === "POST") {
        runtime?.assertHealthy();
        const revision = workspace.revision;
        const body = await readJson(req);
        sendJson(
          res,
          200,
          await workspace.writeFeatures(body, () => {
            runtime?.assertHealthy();
            if (workspace.revision !== revision)
              throw new HttpError(
                409,
                "体験がリセットされました。画面を読み込みなおしてください。",
              );
          }),
        );
      } else if (path === "/api/reset" && req.method === "POST") {
        await readJson(req);
        if (runtime) await runtime.reset();
        else await workspace.reset();
        await resetPreview?.();
        sendJson(res, 200, await state());
      } else if (["/api/state", "/api/features", "/api/reset"].includes(path)) {
        throw new HttpError(405, "この操作は利用できません。");
      } else {
        throw new HttpError(404, "この操作は見つかりませんでした。");
      }
    })().catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 400;
      sendJson(res, status, {
        error: error instanceof Error ? error.message : "操作に失敗しました。",
      });
    });
  };
}

export function boothPlugin(): Plugin {
  let preview: ViteDevServer | undefined;
  let runtime: ReturnType<typeof createBoothRuntime> | undefined;
  let chat: ReturnType<typeof createChatApi> | undefined;
  async function closePreview() {
    const current = preview;
    preview = undefined;
    chat?.close();
    chat = undefined;
    const currentRuntime = runtime;
    runtime = undefined;
    await currentRuntime?.close();
    await current?.close();
  }
  return {
    name: "booth-workspace",
    apply: (_config, environment) => environment.command === "serve" && environment.mode !== "test",
    async configureServer(server) {
      const provider = process.env.BOOTH_AI_PROVIDER ?? "codex";
      if (provider !== "codex" && provider !== "claude")
        throw new Error("BOOTH_AI_PROVIDERはcodexかclaudeを指定してください。");
      const restart = server.restart.bind(server);
      server.restart = async (forceOptimize) => {
        await closePreview();
        await restart(forceOptimize);
      };
      const close = server.close.bind(server);
      server.close = async () => {
        await closePreview();
        await close();
      };
      const workspace = new Workspace(server.config.root);
      await workspace.reset();
      const port = Number(process.env.BOOTH_PREVIEW_PORT ?? "5174");
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("BOOTH_PREVIEW_PORTは1〜65535で指定してください。");
      const previewUrl = `http://127.0.0.1:${port}/`;
      preview = await createServer({
        configFile: false,
        root: workspace.appDir,
        envDir: false,
        envPrefix: [],
        cacheDir: join(workspace.root, "node_modules", ".vite-booth"),
        plugins: [
          previewBoundary(workspace.appDir, [
            join(workspace.root, "shared"),
            join(workspace.root, "node_modules"),
          ]),
          {
            name: "booth-preview-boundary",
            configureServer(previewServer) {
              previewServer.middlewares.use((req, res, next) => {
                res.setHeader(
                  "Content-Security-Policy",
                  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*`,
                );
                res.setHeader("X-Content-Type-Options", "nosniff");
                if (req.url?.startsWith("/api/")) {
                  res.writeHead(404);
                  res.end();
                  return;
                }
                next();
              });
            },
          },
          vize(),
        ],
        resolve: { alias: { "@booth-shared": join(workspace.root, "shared") } },
        server: {
          host: "127.0.0.1",
          port,
          strictPort: true,
          cors: { origin: /^null$/ },
          fs: {
            strict: true,
            allow: [
              workspace.appDir,
              join(workspace.root, "shared"),
              join(workspace.root, "node_modules"),
            ],
          },
        },
      });
      try {
        await preview.listen();
      } catch (error) {
        await preview.close();
        preview = undefined;
        throw error;
      }
      runtime = createBoothRuntime(workspace, provider);
      chat = createChatApi(runtime);
      server.middlewares.use(chat.middleware);
      server.middlewares.use(
        createBoothMiddleware(
          workspace,
          () => previewUrl,
          runtime,
          async () => {
            await preview?.restart();
          },
        ),
      );
    },
    closeBundle: closePreview,
  };
}
