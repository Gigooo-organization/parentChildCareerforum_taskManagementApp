import { afterEach, describe, expect, it } from "vite-plus/test";
import { createServer, request, type Server } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { createBoothMiddleware } from "./plugin";
import { parseWorkspaceState } from "../shared/workspace";

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "booth-api-"));
  roots.push(root);
  await mkdir(join(root, "booth-app"), { recursive: true });
  await writeFile(join(root, "booth-app", "features.json"), '{"color":"blue"}');
  const workspace = new Workspace(root);
  await workspace.reset();
  const handler = createBoothMiddleware(workspace, () => "http://127.0.0.1:5174/");
  const server = createServer((req, res) =>
    handler(req, res, () => {
      res.writeHead(404);
      res.end();
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const url = `http://127.0.0.1:${address.port}`;
  const post = (path: string, input: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json", ...headers },
      body: JSON.stringify(input),
    });
  return { url, post, workspace };
}

describe("booth HTTP API", () => {
  it("applies catalog settings and resets them without touching the template", async () => {
    const { url, post } = await fixture();
    expect(
      await (await post("/api/features", { color: "green", progress: { number: false } })).json(),
    ).toEqual({ color: "green", progress: { number: false } });
    const state = parseWorkspaceState(await (await fetch(url + "/api/state")).json());
    expect(state.features.color).toBe("green");
    expect(state.previewUrl).toBe("http://127.0.0.1:5174/");
    const reset = parseWorkspaceState(await (await post("/api/reset", {})).json());
    expect(reset.features).toEqual({ color: "blue" });
    expect(reset.revision).toBe(state.revision + 1);
  });
  it("rejects invalid settings and malformed JSON with no mutation", async () => {
    const { url, post, workspace } = await fixture();
    expect((await post("/api/features", { color: "purple" })).status).toBe(400);
    const malformed = await fetch(url + "/api/features", {
      method: "POST",
      headers: { origin: url, "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await workspace.readFeatures()).toEqual({ color: "blue" });
  });
  it("rejects cross-site and preview origins, missing origins, unsafe hosts and non-JSON requests", async () => {
    const { url, post } = await fixture();
    for (const origin of [
      "null",
      "https://example.com",
      "http://127.0.0.1:5174",
      "http://localhost:5174",
    ]) {
      expect((await post("/api/features", { color: "pink" }, { origin })).status).toBe(403);
    }
    expect((await fetch(url + "/api/state", { headers: { origin: "null" } })).status).toBe(403);
    const unsafeHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/api/state", { headers: { host: "attacker.example" } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
    expect(unsafeHostStatus).toBe(403);
    expect(
      (
        await fetch(url + "/api/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect((await post("/api/reset", {}, { "content-type": "text/plain" })).status).toBe(415);
  });
  it("limits bodies and rejects unsupported methods", async () => {
    const { url, post } = await fixture();
    expect((await post("/api/features", { color: "blue", extra: "x".repeat(17_000) })).status).toBe(
      413,
    );
    expect((await fetch(url + "/api/features")).status).toBe(405);
  });
});
