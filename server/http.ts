import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
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
