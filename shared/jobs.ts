export const jobStatusLabels = {
  draft: "つぎに作る",
  pending: "スタッフの確認待ち",
  queued: "順番待ち",
  running: "AIが作っています",
  succeeded: "完成",
  failed: "変更できませんでした",
  timed_out: "時間切れ",
  cancelled: "取り消しました",
};
export type JobStatus = keyof typeof jobStatusLabels;
export type Job = { id: string; prompt: string; status: JobStatus; message: string };

const columns = {
  draft: "todo",
  pending: "todo",
  queued: "doing",
  running: "doing",
  succeeded: "done",
  failed: "todo",
  timed_out: "todo",
  cancelled: null,
} satisfies Record<JobStatus, "todo" | "doing" | "done" | null>;

export function jobColumn(job: Job) {
  return columns[job.status];
}

export function canRequestJob(job: Job) {
  return job.status === "draft" || job.status === "failed" || job.status === "timed_out";
}

function isStatus(value: unknown): value is JobStatus {
  return typeof value === "string" && Object.hasOwn(jobStatusLabels, value);
}

export function parseJobs(input: unknown): Job[] {
  if (!Array.isArray(input) || input.length > 30)
    throw new Error("依頼の状態を読み取れませんでした。");
  const ids = new Set<string>();
  return input.map((value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id) ||
      ids.has(value.id) ||
      !("prompt" in value) ||
      typeof value.prompt !== "string" ||
      !value.prompt.trim() ||
      value.prompt.length > 1000 ||
      !("message" in value) ||
      typeof value.message !== "string" ||
      value.message.length > 500 ||
      !("status" in value) ||
      !isStatus(value.status)
    )
      throw new Error("依頼の状態を読み取れませんでした。");
    ids.add(value.id);
    return { id: value.id, prompt: value.prompt, status: value.status, message: value.message };
  });
}
