import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createServer, request, ServerResponse } from "node:http";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChatApi } from "./chat-api";
import { createBoothMiddleware } from "./plugin";
import { createBoothRuntime } from "./runtime";
import { Workspace } from "./workspace";
import { parseJobs, type Job } from "../shared/jobs";
import { parseWorkspaceState } from "../shared/workspace";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(execute?: Parameters<typeof createBoothRuntime>[2]) {
  const root = await mkdtemp(join(tmpdir(), "booth-chat-api-"));
  await cp(join(repoRoot, "booth-app"), join(root, "booth-app"), { recursive: true });
  const workspace = new Workspace(root);
  await workspace.reset();
  const original = await readFile(join(workspace.appDir, "src", "App.vue"), "utf8");
  let calls = 0;
  const runtime = createBoothRuntime(workspace, "codex", async (options) => {
    calls++;
    if (execute) return execute(options);
    return {
      files: [
        {
          path: "src/App.vue",
          content: original.replaceAll("わたしの勉強リスト", "チャレンジリスト"),
        },
      ],
      message: "見出しを変えました。",
    };
  });
  const chat = createChatApi(runtime);
  const base = createBoothMiddleware(workspace, () => "http://127.0.0.1:5174/", runtime);
  const server = createServer((req, res) =>
    chat.middleware(req, res, () =>
      base(req, res, () => {
        res.writeHead(404);
        res.end();
      }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test address");
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    chat.close();
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: { origin: url, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const submit = async () => {
    const response = await post("/api/chat", { prompt: "見出しを変えて" });
    expect(response.status).toBe(201);
    const job = parseJobs([await response.json()])[0];
    if (!job) throw new Error("No submitted job");
    return job;
  };
  const events = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(url + "/api/events", { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    if (!response.body) throw new Error("No event stream");
    const reader = response.body.getReader();
    cleanups.push(async () => {
      clearTimeout(timeout);
      controller.abort();
      await reader.cancel().catch(() => {});
    });
    const snapshots: Job[][] = [];
    let buffered = "";
    const decoder = new TextDecoder();
    async function until(predicate: (jobs: Job[]) => boolean): Promise<Job[]> {
      while (true) {
        const boundary = buffered.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const data = frame.split("\n").find((line) => line.startsWith("data: "));
          if (frame.startsWith("event: jobs") && data) {
            const jobs = parseJobs(JSON.parse(data.slice(6)));
            snapshots.push(jobs);
            if (predicate(jobs)) return jobs;
          }
          continue;
        }
        const next = await reader.read();
        if (next.done) throw new Error("Event stream ended before expected state");
        buffered += decoder.decode(next.value, { stream: true });
      }
    }
    return { until, snapshots };
  };
  return { workspace, runtime, original, url, post, submit, events, calls: () => calls };
}

describe("staff-approved chat HTTP flow", () => {
  it("disconnects a full SSE response before another update can write to it", async () => {
    const app = await fixture();
    const stream = await app.events();
    await stream.until(() => true);
    const write = vi.spyOn(ServerResponse.prototype, "write").mockReturnValue(false);
    try {
      app.runtime.queue.submit("最初の依頼");
      app.runtime.queue.submit("次の依頼");
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    { path: "/api/chat", prefix: '{"prompt":', suffix: '"前の参加者の依頼"}', status: 400 },
    { path: "/api/features", prefix: '{"color":', suffix: '"pink"}', status: 409 },
  ])(
    "rejects a delayed $path body after participant reset",
    async ({ path, prefix, suffix, status }) => {
      const app = await fixture();
      const original = app.runtime.assertHealthy.bind(app.runtime);
      const health = vi.spyOn(app.runtime, "assertHealthy").mockImplementation(original);
      const req = request(app.url + path, {
        method: "POST",
        headers: { origin: app.url, "content-type": "application/json" },
      });
      const response = new Promise<number | undefined>((resolve, reject) => {
        req.on("error", reject);
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
      });
      req.setTimeout(5000, () => req.destroy(new Error("Delayed request timed out")));
      try {
        req.write(prefix);
        await vi.waitFor(() => expect(health).toHaveBeenCalled(), { timeout: 2000 });
        await app.runtime.reset();
        req.end(suffix);
        expect(await response).toBe(status);
        expect(app.runtime.queue.jobs()).toEqual([]);
        expect(await app.workspace.readFeatures()).toEqual({ color: "blue" });
        expect(app.calls()).toBe(0);
      } finally {
        req.destroy();
        health.mockRestore();
      }
    },
  );

  it("publishes initial and reconnected snapshots and executes approval only once", async () => {
    const app = await fixture();
    const stream = await app.events();
    expect(await stream.until(() => true)).toEqual([]);
    const job = await app.submit();
    expect(job.status).toBe("pending");
    await stream.until((jobs) =>
      jobs.some((item) => item.id === job.id && item.status === "pending"),
    );
    expect(app.calls()).toBe(0);
    expect((await app.post(`/api/chat/${job.id}/approve`, {})).status).toBe(200);
    expect((await app.post(`/api/chat/${job.id}/approve`, {})).status).toBe(200);
    await stream.until((jobs) =>
      jobs.some((item) => item.id === job.id && item.status === "succeeded"),
    );
    expect(stream.snapshots.some((jobs) => jobs.some((item) => item.status === "running"))).toBe(
      true,
    );
    expect(app.calls()).toBe(1);
    expect(await readFile(join(app.workspace.appDir, "src", "App.vue"), "utf8")).toContain(
      "チャレンジリスト",
    );
    const reconnected = await app.events();
    expect((await reconnected.until(() => true))[0]?.status).toBe("succeeded");
  }, 30_000);

  it("never executes rejected work and reset cancels active work before restoring the participant", async () => {
    let started = () => {};
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const app = await fixture(async ({ signal }) => {
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const rejected = await app.submit();
    expect((await app.post(`/api/chat/${rejected.id}/reject`, {})).status).toBe(200);
    expect((await app.post(`/api/chat/${rejected.id}/approve`, {})).status).toBe(200);
    expect(app.calls()).toBe(0);
    await app.workspace.writeFeatures({ color: "pink", points: { per: 10 } });
    const active = await app.submit();
    const stream = await app.events();
    await stream.until(() => true);
    await app.post(`/api/chat/${active.id}/approve`, {});
    await executing;
    await app.submit();
    const response = await app.post("/api/reset", {});
    expect(response.status).toBe(200);
    expect(parseWorkspaceState(await response.json()).features).toEqual({ color: "blue" });
    expect(await stream.until((jobs) => jobs.length === 0)).toEqual([]);
    expect(app.runtime.queue.jobs()).toEqual([]);
    expect(await readFile(join(app.workspace.appDir, "src", "App.vue"), "utf8")).toBe(app.original);
    expect(app.calls()).toBe(1);
  });

  it("rejects cross-origin stream and approval requests and malformed chat input", async () => {
    const app = await fixture();
    const job = await app.submit();
    for (const origin of ["null", "https://example.com", "http://127.0.0.1:5174"]) {
      expect((await fetch(app.url + "/api/events", { headers: { origin } })).status).toBe(403);
      expect((await app.post(`/api/chat/${job.id}/approve`, {}, { origin })).status).toBe(403);
    }
    expect((await app.post("/api/chat", { prompt: " " })).status).toBe(400);
    expect((await app.post("/api/chat", { prompt: "x".repeat(1001) })).status).toBe(400);
    expect((await fetch(app.url + "/api/chat")).status).toBe(405);
    expect(app.calls()).toBe(0);
    expect(app.runtime.queue.jobs()[0]?.status).toBe("pending");
  });
});
