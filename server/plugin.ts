import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import vize from "@vizejs/vite-plugin";
import { Workspace } from "./workspace";
import { previewBoundary } from "./preview";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function assertLocalRequest(req: IncomingMessage) {
  const host = req.headers.host;
  const peer = req.socket.remoteAddress;
  if (
    !host ||
    !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) ||
    !peer ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)
  ) {
    throw new HttpError(403, "この操作はこのPCからのみ利用できます。");
  }
  const origin = req.headers.origin;
  if (
    (origin !== undefined && origin !== `http://${host}`) ||
    (req.method !== "GET" && origin === undefined)
  ) {
    throw new HttpError(403, "この画面から操作しなおしてください。");
  }
  if (req.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "この画面から操作しなおしてください。");
  }
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "JSONで送信してください。");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new HttpError(413, "送信する内容が長すぎます。");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "送信した内容を読み取れませんでした。");
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

export function createBoothMiddleware(workspace: Workspace, previewUrl: () => string) {
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
        sendJson(res, 200, await workspace.writeFeatures(await readJson(req)));
      } else if (path === "/api/reset" && req.method === "POST") {
        await readJson(req);
        await workspace.reset();
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
  async function closePreview() {
    const current = preview;
    preview = undefined;
    await current?.close();
  }
  return {
    name: "booth-workspace",
    apply: (_config, environment) => environment.command === "serve" && environment.mode !== "test",
    async configureServer(server) {
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
      server.middlewares.use(createBoothMiddleware(workspace, () => previewUrl));
    },
    closeBundle: closePreview,
  };
}
