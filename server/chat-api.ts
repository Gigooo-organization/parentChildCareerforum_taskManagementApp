import type { IncomingMessage, ServerResponse } from "node:http";
import { assertLocalRequest, readJson, sendJson } from "./http";
import type { createBoothRuntime } from "./runtime";

type Runtime = ReturnType<typeof createBoothRuntime>;

export function createChatApi(runtime: Runtime) {
  const clients = new Set<ServerResponse>();
  const unsubscribe = runtime.queue.subscribe((jobs) => {
    const message = `event: jobs\ndata: ${JSON.stringify(jobs)}\n\n`;
    for (const client of clients) {
      if (client.destroyed || client.writableEnded || !client.write(message)) {
        clients.delete(client);
        if (!client.writableEnded) client.end();
      }
    }
  });
  return {
    middleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
      const path = req.url?.split("?", 1)[0] ?? "";
      if (path !== "/api/events" && path !== "/api/chat" && !path.startsWith("/api/chat/")) {
        next();
        return;
      }
      void (async () => {
        assertLocalRequest(req);
        if (path === "/api/events" && req.method === "GET") {
          if (clients.size >= 10) {
            sendJson(res, 429, {
              error: "開いている体験画面が多すぎます。不要なタブを閉じてください。",
            });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
            "x-content-type-options": "nosniff",
          });
          clients.add(res);
          res.write(`event: jobs\ndata: ${JSON.stringify(runtime.queue.jobs())}\n\n`);
          const keepalive = setInterval(() => {
            if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
          }, 15_000);
          keepalive.unref();
          res.on("close", () => {
            clearInterval(keepalive);
            clients.delete(res);
          });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "この操作は利用できません。" });
          return;
        }
        runtime.assertHealthy();
        const revision = runtime.revision;
        const body = await readJson(req);
        runtime.assertHealthy();
        if (runtime.revision !== revision)
          throw new Error("体験がリセットされました。画面を読み込みなおしてください。");
        if (path === "/api/chat") {
          const prompt =
            typeof body === "object" && body !== null && "prompt" in body ? body.prompt : undefined;
          sendJson(res, 201, runtime.queue.submit(prompt));
          return;
        }
        const match = /^\/api\/chat\/([a-f0-9-]{36})\/(request|approve|reject)$/.exec(path);
        if (!match?.[1]) {
          sendJson(res, 404, { error: "依頼が見つかりません。" });
          return;
        }
        sendJson(
          res,
          200,
          match[2] === "request"
            ? runtime.queue.request(match[1])
            : match[2] === "approve"
              ? runtime.queue.approve(match[1])
              : runtime.queue.reject(match[1]),
        );
      })().catch((error: unknown) => {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status =
          error instanceof Error && "status" in error && typeof error.status === "number"
            ? error.status
            : 400;
        sendJson(res, status, {
          error:
            error instanceof Error ? error.message.slice(0, 500) : "操作を完了できませんでした。",
        });
      });
    },
    close() {
      unsubscribe();
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
