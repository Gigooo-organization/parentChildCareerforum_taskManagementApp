import { describe, expect, it } from "vite-plus/test";
import { createQueue } from "./queue";
import type { AgentOutput } from "./agent";

const output: AgentOutput = { files: [{ path: "src/App.vue", content: "new" }], message: "完成" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function finished(queue: ReturnType<typeof createQueue>) {
  for (
    let i = 0;
    i < 100 && queue.jobs().some((job) => job.status === "queued" || job.status === "running");
    i++
  )
    await tick();
}

describe("approved serial queue", () => {
  it("keeps new ideas as drafts until build is requested and staff approves", async () => {
    let calls = 0;
    const queue = createQueue({
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => {
        calls++;
        return output;
      },
      apply: async () => {},
      validate: async () => {},
    });
    const job = queue.submit("見出しを変えて");
    expect(job.status).toBe("draft");
    expect(queue.approve(job.id).status).toBe("draft");
    expect(queue.request(job.id).status).toBe("pending");
    expect(queue.request(job.id).status).toBe("pending");
    expect(calls).toBe(0);
    queue.approve(job.id);
    await finished(queue);
    expect(calls).toBe(1);
    expect(queue.request(job.id).status).toBe("succeeded");
    expect(queue.jobs()).toHaveLength(1);
  });

  it("requires a new staff review before retrying a failed card", async () => {
    let calls = 0;
    let valid = false;
    const queue = createQueue({
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => {
        calls++;
        return output;
      },
      apply: async () => {},
      validate: async () => {
        if (!valid) throw new Error("invalid");
      },
    });
    const job = queue.submit("試して");
    queue.request(job.id);
    queue.approve(job.id);
    await finished(queue);
    expect(queue.jobs()[0]?.status).toBe("failed");
    valid = true;
    expect(queue.request(job.id).status).toBe("pending");
    expect(calls).toBe(1);
    queue.approve(job.id);
    await finished(queue);
    expect(calls).toBe(2);
    expect(queue.jobs()).toHaveLength(1);
    expect(queue.jobs()[0]?.status).toBe("succeeded");
  });

  it("never evicts unfinished draft cards at capacity", () => {
    const queue = createQueue({
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => output,
      apply: async () => {},
      validate: async () => {},
    });
    const first = queue.submit("アイデア0");
    const cards = [
      first,
      ...Array.from({ length: 29 }, (_, index) => queue.submit(`アイデア${index + 1}`)),
    ];
    expect(() => queue.submit("追加できない")).toThrow(/いっぱい/);
    expect(queue.jobs().map((job) => job.id)).toEqual(cards.map((job) => job.id));
    queue.reject(first.id);
    expect(queue.submit("取り消し後").status).toBe("draft");
    expect(queue.jobs()).toHaveLength(30);
  });

  const failures: ("failed" | "timed_out")[] = ["failed", "timed_out"];
  it.each(failures)("never evicts retryable %s cards at capacity", async (status) => {
    const queue = createQueue(
      {
        snapshot: async () => null,
        restore: async () => {},
        execute: async (_prompt, signal) => {
          if (status === "failed") throw new Error("failed");
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
          return output;
        },
        apply: async () => {},
        validate: async () => {},
      },
      { timeoutMs: 20 },
    );
    const first = queue.submit("失敗しても残す");
    queue.request(first.id);
    queue.approve(first.id);
    await finished(queue);
    expect(queue.jobs()[0]?.status).toBe(status);
    for (let i = 0; i < 29; i++) queue.submit(`残り${i}`);
    expect(() => queue.submit("追加できない")).toThrow(/いっぱい/);
    expect(queue.jobs()[0]?.id).toBe(first.id);
    expect(queue.request(first.id).status).toBe("pending");
  });
  it("requires approval, runs once and serially, and keeps events", async () => {
    let active = 0;
    let calls = 0;
    const queue = createQueue({
      snapshot: async () => "old",
      restore: async () => {},
      execute: async () => {
        expect(active++).toBe(0);
        calls++;
        await tick();
        active--;
        return output;
      },
      apply: async () => {},
      validate: async () => {},
    });
    const events: string[] = [];
    queue.subscribe((jobs) => events.push(jobs.map((job) => job.status).join(",")));
    const first = queue.submit("タイトルを変えて");
    const second = queue.submit("ボタンを丸くして");
    expect(calls).toBe(0);
    queue.request(first.id);
    queue.approve(first.id);
    queue.approve(first.id);
    queue.request(second.id);
    queue.approve(second.id);
    await finished(queue);
    expect(calls).toBe(2);
    expect(queue.jobs().map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(events.some((event) => event.includes("running"))).toBe(true);
  });

  it("restores the snapshot after validation failure and continues the queue", async () => {
    let source = "old";
    const queue = createQueue({
      snapshot: async () => source,
      restore: async (value) => {
        source = value;
      },
      execute: async () => output,
      apply: async () => {
        source = "bad";
      },
      validate: async () => {
        throw new Error("ビルドに失敗".repeat(120));
      },
    });
    const requested1 = queue.submit("変更して");
    queue.request(requested1.id);
    queue.approve(requested1.id);
    await finished(queue);
    expect(source).toBe("old");
    expect(queue.jobs()[0]?.status).toBe("failed");
    expect(queue.jobs()[0]?.message).toHaveLength(500);
  });

  it("times out and restores; reset waits for active cancellation and clears all jobs", async () => {
    let restored = 0;
    const queue = createQueue(
      {
        snapshot: async () => "old",
        restore: async () => {
          restored++;
        },
        execute: async (_prompt, signal) => {
          await new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return output;
        },
        apply: async () => {},
        validate: async () => {},
      },
      { timeoutMs: 20 },
    );
    const requested2 = queue.submit("時間切れにして");
    queue.request(requested2.id);
    queue.approve(requested2.id);
    await finished(queue);
    expect(queue.jobs()[0]?.status).toBe("timed_out");
    expect(restored).toBe(1);
    const requested3 = queue.submit("止めて");
    queue.request(requested3.id);
    queue.approve(requested3.id);
    queue.submit("まだ承認しない");
    await tick();
    await queue.reset();
    expect(queue.jobs()).toEqual([]);
    expect(restored).toBe(2);
  });

  it("rejects blank or long prompts and lets staff reject pending requests", () => {
    const queue = createQueue({
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => output,
      apply: async () => {},
      validate: async () => {},
    });
    expect(() => queue.submit(" ")).toThrow();
    expect(() => queue.submit("a".repeat(1001))).toThrow();
    const job = queue.submit("試して");
    queue.reject(job.id);
    expect(queue.jobs()[0]?.status).toBe("cancelled");
    expect(() => queue.approve("unknown")).toThrow();
  });
});

it("halts after failed rollback instead of claiming a successful restore", async () => {
  let calls = 0;
  const queue = createQueue({
    snapshot: async () => "old",
    restore: async () => {
      throw new Error("disk failed");
    },
    execute: async () => {
      calls++;
      throw new Error("agent failed");
    },
    apply: async () => {},
    validate: async () => {},
  });
  const requested4 = queue.submit("ひとつめ");
  queue.request(requested4.id);
  queue.approve(requested4.id);
  const second = queue.submit("ふたつめ");
  queue.request(second.id);
  queue.approve(second.id);
  for (let i = 0; i < 20 && queue.jobs()[0]?.status !== "failed"; i++) await tick();
  expect(calls).toBe(1);
  expect(queue.jobs()[0]?.message).toContain("戻せません");
  expect(queue.jobs()[1]?.status).toBe("queued");
  expect(() => queue.submit("みっつめ")).toThrow(/リセット/);
  expect(() => queue.request(second.id)).toThrow(/リセット/);
  await queue.reset();
  expect(queue.submit("リセット後").status).toBe("draft");
});

it("does not start a cancelled job after its workspace lock becomes available", async () => {
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const queue = createQueue({
    snapshot: async () => "old",
    restore: async () => {},
    execute: async () => {
      calls++;
      return output;
    },
    apply: async () => {},
    validate: async () => {},
    exclusive: async (operation) => {
      await lock;
      await operation();
    },
  });
  const requested5 = queue.submit("待機中");
  queue.request(requested5.id);
  queue.approve(requested5.id);
  const reset = queue.reset();
  expect(() => queue.request(requested5.id)).toThrow(/リセット/);
  release?.();
  await reset;
  expect(calls).toBe(0);
  expect(queue.jobs()).toEqual([]);
});
