<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { jobStatusLabels, parseJobs } from "@booth-shared/jobs";
import type { Job } from "@booth-shared/jobs";

const emit = defineEmits<{
  running: [value: boolean];
  changed: [];
  reset: [];
}>();
const jobs = ref<Job[]>([]);
const prompt = ref("");
const connection = ref<"connecting" | "connected" | "reconnecting" | "invalid">("connecting");
const requestBusy = ref(false);
const error = ref("");
const confirmReset = ref(false);
const staffOpen = ref(false);
const staffJobs = computed(() =>
  jobs.value.filter((job) => job.status === "pending" || job.status === "queued"),
);
const connected = computed(() => connection.value === "connected");
const suggestions = [
  "見出しを「わたしのチャレンジリスト」に変えて",
  "勉強を応援するひとことを追加して",
  "「本を10分読む」をタスクの候補に追加して",
];
const requests = new AbortController();
let events: EventSource | undefined;
let succeeded = new Set<string>();

function receiveJobs(value: unknown) {
  const next = parseJobs(value);
  const completed = new Set(next.filter((job) => job.status === "succeeded").map((job) => job.id));
  const changed = [...completed].some((id) => !succeeded.has(id));
  succeeded = completed;
  jobs.value = next;
  connection.value = "connected";
  emit(
    "running",
    next.some((job) => job.status === "running"),
  );
  if (changed) emit("changed");
}

onMounted(() => {
  events = new EventSource("/api/events");
  events.addEventListener("jobs", (event: MessageEvent<string>) => {
    try {
      receiveJobs(JSON.parse(event.data));
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
    const message =
      typeof result === "object" &&
      result !== null &&
      "error" in result &&
      typeof result.error === "string"
        ? result.error
        : "操作を完了できませんでした。もう一度試してください。";
    throw new Error(message);
  }
  return result;
}

async function submit() {
  if (requestBusy.value || !connected.value || !prompt.value.trim()) return;
  requestBusy.value = true;
  error.value = "";
  try {
    const submitted = parseJobs([await post("/api/chat", { prompt: prompt.value.trim() })]);
    for (const job of submitted)
      if (!jobs.value.some((existing) => existing.id === job.id)) jobs.value.push(job);
    prompt.value = "";
  } catch (cause) {
    if (!requests.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "依頼を送れませんでした。";
  } finally {
    requestBusy.value = false;
  }
}

async function decide(job: Job, decision: "approve" | "reject") {
  if (requestBusy.value || !connected.value) return;
  requestBusy.value = true;
  error.value = "";
  try {
    await post(`/api/chat/${encodeURIComponent(job.id)}/${decision}`, {});
  } catch (cause) {
    if (!requests.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "操作を完了できませんでした。";
  } finally {
    requestBusy.value = false;
  }
}

async function reset() {
  if (requestBusy.value || !connected.value) return;
  requestBusy.value = true;
  error.value = "";
  try {
    await post("/api/reset", {});
    jobs.value = [];
    succeeded.clear();
    prompt.value = "";
    confirmReset.value = false;
    emit("running", false);
    emit("reset");
  } catch (cause) {
    if (!requests.signal.aborted)
      error.value = cause instanceof Error ? cause.message : "リセットできませんでした。";
  } finally {
    requestBusy.value = false;
  }
}
</script>

<template>
  <div class="booth-chat">
    <h2>AI に頼む</h2>
    <p class="chat-note">自由なお願いは、スタッフが確認してからAIへ送ります。</p>
    <p v-if='connection === "connecting"' class="connection" role="status">依頼の状態を読み込んでいます。</p>
    <p v-else-if='connection === "reconnecting"' class="connection" role="status">再接続しています。カタログのカードはそのまま使えます。</p>
    <p v-else-if='connection === "invalid"' class="connection" role="alert">依頼の状態を読み取れません。スタッフに確認してください。</p>
    <p v-if="error" class="request-error" role="alert">{{ error }}</p>
    <div aria-live="polite" class="history">
      <slot></slot>
      <ol aria-label="AIへの依頼">
        <li v-for="job in jobs" :key="job.id" class="job">
          <p class="request">{{ job.prompt }}</p>
          <p class="reply"><strong>{{ jobStatusLabels[job.status] }}</strong> {{ job.status === "succeeded" ? "できあがったよ！ プレビューで試してみよう。" : job.message }}</p>
          <progress v-if='job.status === "running"' aria-label="AIが作成中です"></progress>
        </li>
      </ol>
    </div>
    <div aria-label="お願いの例" class="suggestions">
      <button
        v-for="suggestion in suggestions"
        :key="suggestion"
        :disabled="requestBusy"
        type="button"
        @click="prompt = suggestion"
      >{{ suggestion }}</button>
    </div>
    <form class="request-form" @submit.prevent="submit">
      <label class="sr-only" for="ai-request">AIへのお願い</label>
      <textarea
        id="ai-request"
        v-model="prompt"
        :disabled="requestBusy"
        maxlength="1000"
        placeholder="例：見出しを自分らしく変えて"
        rows="2"
      ></textarea>
      <button :disabled="requestBusy || !connected || !prompt.trim()" class="send" type="submit">確認をお願いする</button>
    </form>
    <div class="staff">
      <button
        class="staff-toggle"
        type="button"
        :aria-expanded="staffOpen"
        aria-controls="staff-panel"
        @click="staffOpen = !staffOpen; confirmReset = false"
      >スタッフ <span v-if="staffJobs.length">依頼 {{ staffJobs.length }}件</span></button>
      <div
        v-if="staffOpen"
        id="staff-panel"
        aria-label="スタッフ操作"
        class="staff-panel"
        role="region"
      >
        <h3>依頼を確認する</h3>
        <p v-if="!staffJobs.length">確認待ちの依頼はありません。</p>
        <ul>
          <li v-for="job in staffJobs" :key="job.id">
            <p>{{ job.prompt }}</p>
            <div class="staff-actions">
              <button
                v-if='job.status === "pending"'
                :disabled="requestBusy || !connected"
                class="send"
                type="button"
                @click='decide(job, "approve")'
              >承認してAIへ送る</button>
              <button
                :disabled="requestBusy || !connected"
                class="cancel"
                type="button"
                @click='decide(job, "reject")'
              >{{ job.status === "queued" ? "順番待ちを取り消す" : "送らずに取り消す" }}</button>
            </div>
          </li>
        </ul>
        <div v-if="confirmReset" class="reset-confirm">
          <p>いまの作品と依頼を消して、次の参加者の初期状態に戻します。</p>
          <div class="staff-actions">
            <button :disabled="requestBusy || !connected" class="send" type="button" @click="reset">リセットする</button>
            <button
              :disabled="requestBusy"
              class="cancel"
              type="button"
              @click="confirmReset = false"
            >戻る</button>
          </div>
        </div>
        <button
          v-else
          :disabled="requestBusy || !connected"
          class="cancel next"
          type="button"
          @click="confirmReset = true"
        >次の人へ</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.booth-chat {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

h2 {
  font-size: 16px;
  padding: 12px 16px 0;
}

.chat-note, .connection, .request-error {
  font-size: 12px;
  padding: 4px 16px;
}

.chat-note {
  color: #556070;
}

.connection {
  color: #895000;
}

.request-error {
  color: #8f1d45;
  background: #fdeef3;
}

.history {
  flex: 1;
  min-height: 64px;
  overflow-y: auto;
  padding: 4px 16px;
}

ol, ul {
  list-style: none;
}

.job {
  font-size: 13px;
  margin: 6px 0 10px;
  overflow-wrap: anywhere;
}

.request {
  background: #1756a6;
  color: #fff;
  border-radius: 12px;
  margin-left: 12%;
  padding: 7px 10px;
  white-space: pre-wrap;
}

.reply {
  background: #f1f4f8;
  border-radius: 12px;
  padding: 7px 10px;
  margin-top: 4px;
}

.reply strong {
  display: block;
}

progress {
  width: 100%;
  height: 8px;
  accent-color: #1756a6;
}

.suggestions {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 4px 16px;
}

.suggestions button {
  white-space: nowrap;
  border: 1px solid #737d8b;
  border-radius: 16px;
  font-size: 12px;
  padding: 4px 9px;
}

.request-form {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 4px 16px;
}

textarea {
  min-width: 0;
  flex: 1;
  resize: vertical;
  border: 1px solid #737d8b;
  border-radius: 10px;
  padding: 6px 10px;
  font-size: 13px;
}

.send, .cancel {
  border-radius: 10px;
  padding: 7px 10px;
  font-size: 12px;
}

.send {
  background: #1756a6;
  color: #fff;
}

.cancel {
  background: #e9edf2;
  color: #1f2a3a;
}

.staff {
  align-self: flex-end;
  padding: 4px 16px 8px;
  font-size: 12px;
}

.staff-toggle span {
  color: #895000;
  margin-left: 6px;
}

.staff-panel {
  position: absolute;
  z-index: 4;
  right: 12px;
  bottom: 32px;
  width: min(520px, 100vw - 60px);
  max-height: 65dvh;
  overflow-y: auto;
  border: 1px solid #737d8b;
  border-radius: 12px;
  padding: 14px;
  background: #fff;
  box-shadow: 0 8px 30px #141e3240;
}

h3 {
  font-size: 14px;
  margin-bottom: 8px;
}

.staff-panel li {
  border-top: 1px solid #d6dde6;
  padding: 10px 0;
}

.staff-panel p {
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.staff-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.next, .reset-confirm {
  margin-top: 14px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (width <= 500px) {
  .request-form {
    flex-wrap: wrap;
  }

  textarea {
    flex-basis: 100%;
  }

  .request-form .send {
    margin-left: auto;
  }
}
</style>
