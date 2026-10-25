import { describe, expect, it, vi } from "vite-plus/test";
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
      assess: async () => "ready",
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
    await tick();
    expect(job.status).toBe("checking");
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
      assess: async () => "ready",
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
    await tick();
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

  it("never evicts unfinished draft cards at capacity", async () => {
    const queue = createQueue({
      assess: async () => "ready",
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => output,
      apply: async () => {},
      validate: async () => {},
    });
    const first = queue.submit("アイデア0");
    await tick();
    const cards = [
      first,
      ...Array.from({ length: 29 }, (_, index) => queue.submit(`アイデア${index + 1}`)),
    ];
    expect(() => queue.submit("追加できない")).toThrow(/いっぱい/);
    expect(queue.jobs().map((job) => job.id)).toEqual(cards.map((job) => job.id));
    queue.reject(first.id);
    expect(queue.submit("取り消し後").status).toBe("checking");
    expect(queue.jobs()).toHaveLength(30);
  });

  const failures: ("failed" | "timed_out")[] = ["failed", "timed_out"];
  it.each(failures)("never evicts retryable %s cards at capacity", async (status) => {
    const queue = createQueue(
      {
        assess: async () => "ready",
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
    await tick();
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
      assess: async () => "ready",
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
    await tick();
    const second = queue.submit("ボタンを丸くして");
    await tick();
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
      assess: async () => "ready",
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
    await tick();
    queue.request(requested1.id);
    queue.approve(requested1.id);
    await finished(queue);
    expect(source).toBe("old");
    expect(queue.jobs()[0]?.status).toBe("failed");
    expect(queue.jobs()[0]?.message).toHaveLength(500);
  });

  it("allows three minutes including validation before timing out and restoring", async () => {
    vi.useFakeTimers();
    let source = "old";
    const queue = createQueue({
      assess: async () => "ready",
      snapshot: async () => source,
      restore: async (previous) => {
        source = previous;
      },
      execute: async () => output,
      apply: async () => {
        source = "new";
      },
      validate: (signal) =>
        new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    });
    try {
      const job = queue.submit("確認が終わるまで待って");
      await vi.advanceTimersByTimeAsync(0);
      queue.request(job.id);
      queue.approve(job.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(source).toBe("new");
      await vi.advanceTimersByTimeAsync(179_999);
      expect(queue.jobs()[0]?.status).toBe("running");
      expect(source).toBe("new");
      await vi.advanceTimersByTimeAsync(1);
      expect(queue.jobs()[0]?.status).toBe("timed_out");
      expect(queue.jobs()[0]?.message).toContain("3分");
      expect(source).toBe("old");
    } finally {
      await queue.reset();
      vi.useRealTimers();
    }
  });

  it("times out and restores; reset waits for active cancellation and clears all jobs", async () => {
    let restored = 0;
    const queue = createQueue(
      {
        assess: async () => "ready",
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
    await tick();
    queue.request(requested2.id);
    queue.approve(requested2.id);
    await finished(queue);
    expect(queue.jobs()[0]?.status).toBe("timed_out");
    expect(restored).toBe(1);
    const requested3 = queue.submit("止めて");
    await tick();
    queue.request(requested3.id);
    queue.approve(requested3.id);
    queue.submit("まだ承認しない");
    await tick();
    await queue.reset();
    expect(queue.jobs()).toEqual([]);
    expect(restored).toBe(2);
  });

  it("rejects blank or long prompts and lets staff reject pending requests", async () => {
    const queue = createQueue({
      assess: async () => "ready",
      snapshot: async () => null,
      restore: async () => {},
      execute: async () => output,
      apply: async () => {},
      validate: async () => {},
    });
    expect(() => queue.submit(" ")).toThrow();
    expect(() => queue.submit("a".repeat(1001))).toThrow();
    const job = queue.submit("試して");
    await tick();
    queue.reject(job.id);
    expect(queue.jobs()[0]?.status).toBe("cancelled");
    expect(() => queue.approve("unknown")).toThrow();
  });
});

it("halts after failed rollback instead of claiming a successful restore", async () => {
  let calls = 0;
  const queue = createQueue({
    assess: async () => "ready",
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
  await tick();
  const second = queue.submit("ふたつめ");
  await tick();
  queue.request(requested4.id);
  queue.request(second.id);
  queue.approve(requested4.id);
  queue.approve(second.id);
  for (let i = 0; i < 20 && queue.jobs()[0]?.status !== "failed"; i++) await tick();
  expect(calls).toBe(1);
  expect(queue.jobs()[0]?.message).toContain("戻せません");
  expect(queue.jobs()[1]?.status).toBe("queued");
  expect(() => queue.submit("みっつめ")).toThrow(/リセット/);
  expect(() => queue.request(second.id)).toThrow(/リセット/);
  await queue.reset();
  expect(queue.submit("リセット後").status).toBe("checking");
});

it("does not start a cancelled job after its workspace lock becomes available", async () => {
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const queue = createQueue({
    assess: async () => "ready",
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
  await tick();
  queue.request(requested5.id);
  queue.approve(requested5.id);
  const reset = queue.reset();
  expect(() => queue.request(requested5.id)).toThrow(/リセット/);
  release?.();
  await reset;
  expect(calls).toBe(0);
  expect(queue.jobs()).toEqual([]);
});

function hearingQueue(assess: Parameters<typeof createQueue>[0]["assess"]) {
  let executions = 0;
  const queue = createQueue({
    assess,
    snapshot: async () => null,
    restore: async () => {},
    execute: async () => {
      executions++;
      return output;
    },
    apply: async () => {},
    validate: async () => {},
  });
  return { queue, executions: () => executions };
}

describe("hearing before a build", () => {
  it("creates a card immediately and cannot request or approve a checking card", async () => {
    let resolve: ((value: "ready") => void) | undefined;
    const { queue, executions } = hearingQueue(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const job = queue.submit("背景をピンクにして");
    expect(job.status).toBe("checking");
    expect(queue.request(job.id).status).toBe("checking");
    expect(queue.approve(job.id).status).toBe("checking");
    expect(executions()).toBe(0);
    resolve?.("ready");
    await tick();
    expect(queue.jobs()[0]?.status).toBe("draft");
    expect(executions()).toBe(0);
    expect(queue.request(job.id).status).toBe("pending");
  });
  it("retains the request, adds a bounded answer, and assesses the same card again", async () => {
    const prompts: string[] = [];
    const { queue, executions } = hearingQueue(async (prompt) => {
      prompts.push(prompt);
      return prompts.length === 1 ? "required" : "ready";
    });
    const job = queue.submit("かわいくして");
    await tick();
    expect(queue.request(job.id).status).toBe("hearing");
    expect(queue.approve(job.id).status).toBe("hearing");
    expect(() => queue.clarify(job.id, " ")).toThrow();
    expect(() => queue.clarify(job.id, "a".repeat(1000))).toThrow(/1000/);
    expect(queue.jobs()[0]?.prompt).toBe("かわいくして");
    expect(queue.clarify(job.id, " 背景をピンクに ").status).toBe("checking");
    expect(() => queue.clarify(job.id, "二重送信")).toThrow();
    await tick();
    expect(prompts).toEqual(["かわいくして", "かわいくして\n追加の説明: 背景をピンクに"]);
    expect(queue.jobs()[0]?.status).toBe("draft");
    expect(queue.jobs()).toHaveLength(1);
    expect(executions()).toBe(0);
  });
  it("keeps a failed assessment unresolved and retries once without building", async () => {
    let checks = 0;
    const { queue, executions } = hearingQueue(async () => {
      if (++checks === 1) throw new Error("secret");
      return "ready";
    });
    const job = queue.submit("変更して");
    await tick();
    expect(queue.jobs()[0]?.status).toBe("check_failed");
    expect(queue.jobs()[0]?.message).not.toContain("secret");
    expect(queue.request(job.id).status).toBe("check_failed");
    queue.retryCheck(job.id);
    queue.retryCheck(job.id);
    await tick();
    expect(checks).toBe(2);
    expect(queue.jobs()[0]?.status).toBe("draft");
    expect(executions()).toBe(0);
  });
  it.each(["reject", "reset"] as const)(
    "aborts %s checks and ignores a provider that resolves after cancellation",
    async (operation) => {
      let resolve: ((value: "ready") => void) | undefined;
      let signal: AbortSignal | undefined;
      const { queue } = hearingQueue((_prompt, current) => {
        signal = current;
        return new Promise((done) => {
          resolve = done;
        });
      });
      const job = queue.submit("前の参加者");
      if (operation === "reject") queue.reject(job.id);
      else await queue.reset();
      expect(signal?.aborted).toBe(true);
      resolve?.("ready");
      await tick();
      if (operation === "reject") expect(queue.jobs()[0]?.status).toBe("cancelled");
      else expect(queue.jobs()).toEqual([]);
    },
  );
});
