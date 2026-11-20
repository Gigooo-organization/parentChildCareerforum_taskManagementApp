import { randomUUID } from "node:crypto";
import type { AgentOutput } from "./agent";

import { canCancelJobRequest, canRequestJob, type Job } from "../shared/jobs";
type Hooks<Snapshot> = {
  snapshot: () => Promise<Snapshot>;
  restore: (snapshot: Snapshot) => Promise<void>;
  execute: (prompt: string, signal: AbortSignal, progress: () => void) => Promise<AgentOutput>;
  apply: (output: AgentOutput) => Promise<void>;
  validate: (signal: AbortSignal) => Promise<void>;
  exclusive?: (operation: () => Promise<void>) => Promise<void>;
};

function draftJob(value: unknown): Job {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 1000)
    throw new Error("依頼は1〜1000文字で入力してください。");
  return {
    id: randomUUID(),
    prompt: value.trim(),
    status: "draft",
    message: "「作る」を押すとスタッフに確認をお願いします。",
  };
}

export function createQueue<Snapshot = unknown>(
  hooks: Hooks<Snapshot>,
  options: { timeoutMs?: number } = {},
) {
  let jobs: Job[] = [];
  const beforeRequest = new WeakMap<Job, Pick<Job, "status" | "message">>();
  const listeners = new Set<(jobs: Job[]) => void>();
  let running: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let resetting = false;
  let halted = false;
  const snapshot = () => jobs.map((job) => ({ ...job }));
  const emit = () => {
    for (const listener of listeners) listener(snapshot());
  };

  async function execute(job: Job) {
    const abort = new AbortController();
    controller = abort;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, options.timeoutMs ?? 90_000);
    beforeRequest.delete(job);
    job.status = "running";
    job.message = "AIが考えています";
    emit();
    try {
      const previous = await hooks.snapshot();
      try {
        abort.signal.throwIfAborted();
        const output = await hooks.execute(job.prompt, abort.signal, () => {
          if (job.message !== "AIから応答を受け取っています") {
            job.message = "AIから応答を受け取っています";
            emit();
          }
        });
        abort.signal.throwIfAborted();
        await hooks.apply(output);
        abort.signal.throwIfAborted();
        job.message = "変更を確かめています";
        emit();
        await hooks.validate(abort.signal);
        abort.signal.throwIfAborted();
        job.status = "succeeded";
        job.message = output.message || "アプリを変更しました。";
      } catch (error) {
        try {
          await hooks.restore(previous);
        } catch {
          halted = true;
          throw new Error(
            "変更前に戻せませんでした。スタッフが「次の人へ」でリセットしてください。",
          );
        }
        throw error;
      }
    } catch (error) {
      job.status = halted
        ? "failed"
        : timedOut
          ? "timed_out"
          : abort.signal.aborted
            ? "cancelled"
            : "failed";
      job.message =
        halted && error instanceof Error
          ? error.message
          : timedOut
            ? "90秒で間に合わなかったため、変更前に戻しました。"
            : abort.signal.aborted
              ? "変更を中止して元に戻しました。"
              : error instanceof Error
                ? error.message
                : "AIの変更に失敗しました。";
      job.message = job.message.slice(0, 500);
    } finally {
      clearTimeout(timer);
      controller = undefined;
      emit();
    }
  }

  async function drain() {
    let next = jobs.find((job) => job.status === "queued");
    while (next && !resetting && !halted) {
      const job = next;
      const operation = async () => {
        if (!resetting && job.status === "queued") await execute(job);
      };
      try {
        if (hooks.exclusive) await hooks.exclusive(operation);
        else await operation();
      } catch {
        job.status = "failed";
        job.message = "作業フォルダを利用できません。スタッフがリセットしてください。";
        halted = true;
        emit();
      }
      next = jobs.find((job) => job.status === "queued");
    }
  }

  function start() {
    if (!running)
      running = drain().finally(() => {
        running = undefined;
        if (jobs.some((job) => job.status === "queued") && !resetting && !halted) start();
      });
  }

  function find(id: string) {
    const job = jobs.find((job) => job.id === id);
    if (!job) throw new Error("依頼が見つかりません。");
    return job;
  }

  function reserveSlots(count: number) {
    let overflow = jobs.length + count - 30;
    if (overflow <= 0) return;
    const kept = jobs.filter((job) => {
      if (overflow > 0 && (job.status === "succeeded" || job.status === "cancelled")) {
        overflow--;
        return false;
      }
      return true;
    });
    if (overflow > 0) throw new Error("依頼がいっぱいです。スタッフに確認してください。");
    jobs = kept;
  }

  return {
    jobs: snapshot,
    subscribe(listener: (jobs: Job[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    submit(prompt: unknown) {
      if (resetting || halted) throw new Error("スタッフがリセットしてから依頼してください。");
      const job = draftJob(prompt);
      reserveSlots(1);
      jobs.push(job);
      emit();
      return { ...job };
    },
    split(id: string, prompts: unknown) {
      if (resetting || halted) throw new Error("スタッフがリセットしてから依頼してください。");
      const original = find(id);
      if (original.status !== "pending")
        throw new Error("スタッフの確認待ちの依頼だけ分けられます。");
      if (!Array.isArray(prompts) || prompts.length < 2 || prompts.length > 5)
        throw new Error("分けた依頼を2〜5件入力してください。");
      const drafts = prompts.map(draftJob);
      if (new Set(drafts.map((draft) => draft.prompt)).size !== drafts.length)
        throw new Error("分けた依頼には、それぞれ別の変更を書いてください。");
      reserveSlots(drafts.length - 1);
      // The board displays the most recent draft first.
      jobs.splice(jobs.indexOf(original), 1, ...drafts.reverse());
      emit();
    },
    request(id: string) {
      if (resetting || halted) throw new Error("スタッフがリセットしてから依頼してください。");
      const job = find(id);
      if (canRequestJob(job)) {
        beforeRequest.set(job, { status: job.status, message: job.message });
        job.status = "pending";
        job.message = "スタッフの確認を待っています。";
        emit();
      }
      return { ...job };
    },
    approve(id: string) {
      const job = find(id);
      if (job.status === "pending" && !resetting) {
        job.status = "queued";
        job.message = "順番を待っています。";
        emit();
        start();
      }
      return { ...job };
    },
    reject(id: string) {
      const job = find(id);
      const previous = beforeRequest.get(job);
      if (!resetting && canCancelJobRequest(job) && previous) {
        job.status = previous.status;
        job.message = previous.message;
        beforeRequest.delete(job);
        emit();
      }
      return { ...job };
    },
    async reset() {
      resetting = true;
      for (const job of jobs)
        if (job.status === "draft" || job.status === "pending" || job.status === "queued")
          job.status = "cancelled";
      controller?.abort();
      try {
        await running;
        jobs = [];
        halted = false;
        emit();
      } finally {
        resetting = false;
      }
    },
  };
}
