import { randomUUID } from "node:crypto";
import type { AgentOutput } from "./agent";

export type JobStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";
export type Job = { id: string; prompt: string; status: JobStatus; message: string };
type Hooks<Snapshot> = {
  snapshot: () => Promise<Snapshot>;
  restore: (snapshot: Snapshot) => Promise<void>;
  execute: (prompt: string, signal: AbortSignal, progress: () => void) => Promise<AgentOutput>;
  apply: (output: AgentOutput) => Promise<void>;
  validate: (signal: AbortSignal) => Promise<void>;
  exclusive?: (operation: () => Promise<void>) => Promise<void>;
};

export function createQueue<Snapshot = unknown>(
  hooks: Hooks<Snapshot>,
  options: { timeoutMs?: number } = {},
) {
  let jobs: Job[] = [];
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
      if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 1000)
        throw new Error("依頼は1〜1000文字で入力してください。");
      while (jobs.length >= 30) {
        const index = jobs.findIndex(
          (job) => !["pending", "queued", "running"].includes(job.status),
        );
        if (index < 0) throw new Error("依頼がいっぱいです。スタッフに確認してください。");
        jobs.splice(index, 1);
      }
      const job: Job = {
        id: randomUUID(),
        prompt: prompt.trim(),
        status: "pending",
        message: "スタッフの確認を待っています。",
      };
      jobs.push(job);
      emit();
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
      if (job.status === "pending" || job.status === "queued") {
        job.status = "cancelled";
        job.message = "スタッフが依頼を取り消しました。";
        emit();
      }
      return { ...job };
    },
    async reset() {
      resetting = true;
      for (const job of jobs)
        if (job.status === "pending" || job.status === "queued") job.status = "cancelled";
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
