import { onMounted, onUnmounted, ref } from "vue";
import { parseJobs } from "@booth-shared/jobs";
import type { Job } from "@booth-shared/jobs";

type Actions = { changed: () => void | Promise<void>; reset: () => void | Promise<void> };

export function useBoothJobs(actions: Actions) {
  const jobs = ref<Job[]>([]);
  const prompt = ref("");
  const connection = ref<"connecting" | "connected" | "reconnecting" | "invalid">("connecting");
  const requestBusy = ref(false);
  const error = ref("");
  const notice = ref("");
  const requests = new AbortController();
  let events: EventSource | undefined;
  let succeeded = new Set<string>();

  onMounted(() => {
    events = new EventSource("/api/events");
    events.addEventListener("jobs", (event: MessageEvent<string>) => {
      try {
        const next = parseJobs(JSON.parse(event.data));
        const completed = new Set(
          next.filter((job) => job.status === "succeeded").map((job) => job.id),
        );
        const changed = [...completed].some((id) => !succeeded.has(id));
        succeeded = completed;
        jobs.value = next;
        connection.value = "connected";
        if (changed) void actions.changed();
      } catch {
        connection.value = "invalid";
      }
    });
    events.onerror = () => {
      connection.value = "reconnecting";
    };
  });
  onUnmounted(() => {
    events?.close();
    requests.abort();
  });

  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requests.signal,
    }).catch(() => {
      throw new Error("サーバーに接続できませんでした。スタッフに確認してください。");
    });
    const result: unknown = await response.json().catch(() => {
      throw new Error("応答を読み取れませんでした。もう一度試してください。");
    });
    if (!response.ok) {
      throw new Error(
        typeof result === "object" &&
          result !== null &&
          "error" in result &&
          typeof result.error === "string"
          ? result.error
          : "操作を完了できませんでした。もう一度試してください。",
      );
    }
    return result;
  }

  async function perform(operation: () => Promise<void>) {
    if (requestBusy.value || connection.value !== "connected") return false;
    requestBusy.value = true;
    error.value = "";
    notice.value = "";
    try {
      await operation();
      return true;
    } catch (cause) {
      if (!requests.signal.aborted)
        error.value = cause instanceof Error ? cause.message : "操作を完了できませんでした。";
      return false;
    } finally {
      requestBusy.value = false;
    }
  }

  async function submit() {
    if (!prompt.value.trim()) return false;
    return perform(async () => {
      const submitted = parseJobs([await post("/api/chat", { prompt: prompt.value.trim() })]);
      for (const job of submitted)
        if (!jobs.value.some((existing) => existing.id === job.id)) jobs.value.push(job);
      prompt.value = "";
      notice.value = "「つぎに作る」に追加しました。カードの「作る」で進めよう。";
    });
  }

  function requestBuild(job: Job) {
    return perform(async () => {
      await post(`/api/chat/${encodeURIComponent(job.id)}/request`, {});
      notice.value = "スタッフに確認をお願いしました。";
    });
  }

  function decide(job: Job, decision: "approve" | "reject") {
    return perform(async () => {
      await post(`/api/chat/${encodeURIComponent(job.id)}/${decision}`, {});
    });
  }

  function reset() {
    return perform(async () => {
      await post("/api/reset", {});
      jobs.value = [];
      succeeded.clear();
      prompt.value = "";
      await actions.reset();
      notice.value = "新しい体験をはじめよう！";
    });
  }

  return {
    jobs,
    prompt,
    connection,
    requestBusy,
    error,
    notice,
    submit,
    requestBuild,
    decide,
    reset,
  };
}
