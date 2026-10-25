<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import { actionFromAnswers, applyAction, catalog, instructionFor } from "@booth-shared/catalog";
import type { Answer, CatalogCard, CatalogId } from "@booth-shared/catalog";
import { parseFeatures } from "@booth-shared/features";
import type { Features } from "@booth-shared/features";
import { parseWorkspaceState, safeUrl } from "@booth-shared/workspace";
import { useBoothJobs } from "./useBoothJobs";
import { canRequestJob, jobColumn, jobStatusLabels } from "@booth-shared/jobs";
import type { Job } from "@booth-shared/jobs";
import { buildCatalog } from "./catalogBuild";

type Column = "todo" | "doing" | "done";
type WorkspaceCard = CatalogCard & { column: Column; answers: Answer[] };
const columns: { id: Column; title: string }[] = [
  { id: "todo", title: "つぎに作る" },
  { id: "doing", title: "作っている" },
  { id: "done", title: "完成" },
];
const cards = ref<WorkspaceCard[]>(
  catalog.map((card) => ({ ...card, column: "todo", answers: [] })),
);
const features = ref<Features>({ color: "blue" });
const selectedId = ref<CatalogId | null>(null);
const selected = computed(() => cards.value.find((card) => card.id === selectedId.value));
const action = computed(() =>
  selected.value ? actionFromAnswers(selected.value.id, selected.value.answers) : null,
);
const nextQuestion = computed(() => selected.value?.questions[selected.value.answers.length]);
const applying = ref(false);
const error = ref("");
const dialog = useTemplateRef<HTMLDialogElement>("cardDialog");
type DraggedCard = { kind: "catalog"; id: CatalogId } | { kind: "idea"; id: string };
const dragged = ref<DraggedCard | null>(null);
const over = ref(false);
const ready = ref(false);
const previewUrl = ref("");
const revision = ref(0);
const {
  jobs,
  prompt,
  connection,
  requestBusy,
  error: jobError,
  notice,
  submit,
  requestBuild,
  decide,
  reset: resetBooth,
} = useBoothJobs({ changed: loadState, reset: resetWorkspace });
const connected = computed(() => connection.value === "connected");
const aiRunning = computed(() => jobs.value.some((job) => job.status === "running"));
const busy = computed(() => applying.value || aiRunning.value);
const selectedIdeaId = ref<string | null>(null);
const selectedIdea = computed(() => jobs.value.find((job) => job.id === selectedIdeaId.value));
const ideaDialog = useTemplateRef<HTMLDialogElement>("ideaDialog");
const staffOpen = ref(false);
const confirmReset = ref(false);
const staffJobs = computed(() =>
  jobs.value.filter((job) => job.status === "pending" || job.status === "queued"),
);
const suggestions = [
  "見出しを「わたしのチャレンジリスト」に変えて",
  "勉強を応援するひとことを追加して",
  "「本を10分読む」をタスクの候補に追加して",
];

function jobsFor(column: Column) {
  return jobs.value.filter((job) => jobColumn(job) === column).reverse();
}
function openIdea(job: Job) {
  selectedIdeaId.value = job.id;
  ideaDialog.value?.showModal();
}
async function buildIdea(job: Job) {
  if (busy.value || requestBusy.value || !connected.value || !ready.value) return;
  if (await requestBuild(job)) ideaDialog.value?.close();
}
async function removeIdea(job: Job) {
  if (await decide(job, "reject")) ideaDialog.value?.close();
}

async function loadState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("作業状態を読み取れません。スタッフに確認してください。");
    const state = parseWorkspaceState(await response.json());
    features.value = state.features;
    previewUrl.value = state.previewUrl;
    revision.value = state.revision;
    for (const card of cards.value) {
      switch (card.id) {
        case "points":
          card.answers = state.features.points ? [state.features.points.per] : [];
          break;
        case "progress":
          card.answers = state.features.progress ? [state.features.progress.number] : [];
          break;
        case "celebrate":
          card.answers = state.features.celebrate
            ? [state.features.celebrate.face, state.features.celebrate.msg]
            : [];
          break;
        default:
          card.answers = [];
      }
      card.column = card.questions.length
        ? card.answers.length
          ? "done"
          : "todo"
        : card.id === state.features.color
          ? "done"
          : "todo";
    }
    error.value = "";
    ready.value = true;
  } catch (cause) {
    ready.value = false;
    error.value = cause instanceof Error ? cause.message : "接続できませんでした。";
  }
}
onMounted(loadState);
async function resetWorkspace() {
  selectedIdeaId.value = null;
  ideaDialog.value?.close();
  confirmReset.value = false;
  selectedId.value = null;
  dialog.value?.close();
  await loadState();
}

function openCard(card: CatalogCard) {
  if (busy.value || !ready.value) return;
  selectedId.value = card.id;
  error.value = "";
  dialog.value?.showModal();
}
function answer(value: Answer) {
  selected.value?.answers.push(value);
}
async function develop(id: CatalogId) {
  const card = cards.value.find((item) => item.id === id);
  if (!card || busy.value || !ready.value) return;
  const chosen = actionFromAnswers(card.id, card.answers);
  if (!chosen) {
    openCard(card);
    return;
  }
  error.value = "";
  applying.value = true;
  const previousColumn = card.column;
  const startedRevision = revision.value;
  card.column = "doing";
  dialog.value?.close();
  try {
    const updated = await buildCatalog(async () => {
      const response = await fetch("/api/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(applyAction(features.value, chosen)),
      });
      if (!response.ok)
        throw new Error("変更を反映できませんでした。スタッフに確認して、もう一度試してね。");
      return parseFeatures(await response.json());
    });
    if (revision.value !== startedRevision) return;
    features.value = updated;
    card.column = "done";
  } catch (cause) {
    if (revision.value !== startedRevision) return;
    card.column = previousColumn;
    error.value = cause instanceof Error ? cause.message : "変更を反映できませんでした。";
  } finally {
    applying.value = false;
  }
}
function dropCard() {
  over.value = false;
  const target = dragged.value;
  if (target?.kind === "catalog") void develop(target.id);
  else if (target) {
    const job = jobs.value.find((item) => item.id === target.id);
    if (job && canRequestJob(job)) void buildIdea(job);
  }
  dragged.value = null;
}
</script>

<template>
  <div class="workspace">
    <div class="left">
      <section aria-labelledby="board-title" class="panel board-panel">
        <h1 id="board-title">次の開発リスト <small>カードでくわしく決めたら「作る」を押そう</small></h1>
        <p v-if="error" class="error" role="alert">{{ error }} <button v-if="!ready" type="button" @click="loadState">再接続</button></p>
        <div class="cols">
          <section
            v-for="column in columns"
            :key="column.id"
            :class='["col", { over: column.id === "doing" && over }]'
            :aria-label="column.title"
            @dragover.prevent='over = column.id === "doing"'
            @dragleave="over = false"
            @drop.prevent='column.id === "doing" && dropCard()'
          >
            <h2>{{ column.title }} <span>{{
                  cards.filter((card) => card.column === column.id).length +
                    (column.id === "done" ? 2 : 0) +
                    jobsFor(column.id).length
                }}</span></h2>
            <ul class="cards">
              <template v-if='column.id === "done"'>
                <li class="card built-in"><strong>チェック機能</strong><small>完了したタスクにチェック</small></li>
                <li class="card built-in"><strong>タスク追加</strong><small>候補から選んで追加</small></li>
              </template>
              <li
                v-for="job in jobsFor(column.id)"
                :key="job.id"
                class="card idea-card"
                :draggable="canRequestJob(job) && !busy && connected && !requestBusy"
                @dragstart='dragged = { kind: "idea", id: job.id }'
                @dragend="dragged = null; over = false"
              >
                <button
                  class="card-detail"
                  type="button"
                  :aria-label='job.prompt + "の内容を見る"'
                  @click="openIdea(job)"
                ><span class="idea-label">自分のアイデア</span><strong class="idea-title">{{ job.prompt }}</strong><small>{{ jobStatusLabels[job.status] }}</small><span
                    v-if='job.status === "failed" || job.status === "timed_out"'
                    class="card-failure"
                  >内容を確認して、もう一度作れます</span></button>
                <button
                  v-if="canRequestJob(job)"
                  class="go"
                  :disabled="busy || requestBusy || !connected || !ready"
                  type="button"
                  :aria-label='job.prompt + "を作る"'
                  @click="buildIdea(job)"
                >{{ job.status === "draft" ? "作る" : "再試行" }}</button>
                <span
                  v-else-if='job.status === "running"'
                  aria-label="AIが作成中"
                  class="spinner"
                ></span>
              </li>
              <li
                v-for="card in cards.filter(item => item.column === column.id)"
                :key="card.id"
                class="card"
                :draggable="!busy && ready"
                @dragstart='dragged = { kind: "catalog", id: card.id }'
                @dragend="dragged = null; over = false"
              >
                <button
                  class="card-detail"
                  :disabled="busy || !ready"
                  type="button"
                  @click="openCard(card)"
                >
                  <strong>{{ card.title }}</strong><small>{{ card.description }}</small>
                  <span v-if="card.answers.length" class="spec">{{ actionFromAnswers(card.id, card.answers) ? "仕様が決まったよ" : "つづきを決めよう" }}</span>
                </button>
                <button
                  v-if='card.column !== "doing"'
                  class="go"
                  :disabled="busy || !ready"
                  type="button"
                  :aria-label='`${card.title}を${card.column === "done" ? "作り直す" : "作る"}`'
                  @click="develop(card.id)"
                >{{ card.column === "done" ? "作り直す" : "作る" }}</button>
                <span v-else aria-label="反映中" class="spinner"></span>
              </li>
            </ul>
          </section>
        </div>
      </section>
      <section aria-labelledby="idea-input-title" class="panel idea-input-panel">
        <h2 id="idea-input-title">作りたいものを追加しよう</h2>
        <p class="input-note">まず「つぎに作る」に追加。カードの「作る」を押して進めよう。</p>
        <p v-if='connection !== "connected"' class="connection" role="status">{{
            connection === "invalid"
              ? "カードの状態を読み取れません。スタッフに確認してください。"
              : "カードの状態に接続しています。カタログはそのまま使えます。"
          }}</p>
        <p v-if="jobError" class="request-error" role="alert">{{ jobError }}</p>
        <p v-if="notice" class="input-notice" role="status">{{ notice }}</p>
        <div aria-label="アイデアの例" class="suggestions"><button
            v-for="suggestion in suggestions"
            :key="suggestion"
            :disabled="requestBusy"
            type="button"
            @click="prompt = suggestion"
          >{{ suggestion }}</button></div>
        <form class="request-form" @submit.prevent="submit"><label class="sr-only" for="idea-input">作りたいもの</label><textarea
            id="idea-input"
            v-model="prompt"
            :disabled="requestBusy"
            maxlength="1000"
            placeholder="例：見出しを自分らしく変えて"
            rows="2"
          ></textarea><button :disabled="requestBusy || !connected || !prompt.trim()" class="send" type="submit">つぎに作るに追加</button></form>
        <div class="staff"><button
            class="staff-toggle"
            type="button"
            :aria-expanded="staffOpen"
            aria-controls="staff-panel"
            @click="staffOpen = !staffOpen; confirmReset = false"
          >スタッフ <span v-if="staffJobs.length">確認 {{ staffJobs.length }}件</span></button>
          <div
            v-if="staffOpen"
            id="staff-panel"
            aria-label="スタッフ操作"
            class="staff-panel"
            role="region"
          ><h3>作成の依頼を確認する</h3><p v-if="!staffJobs.length">確認待ちの依頼はありません。</p><ul><li v-for="job in staffJobs" :key="job.id"><p>{{ job.prompt }}</p><div class="staff-actions"><button
                    v-if='job.status === "pending"'
                    :disabled="requestBusy || !connected"
                    class="send"
                    type="button"
                    @click='decide(job, "approve")'
                  >承認してAIへ送る</button><button
                    :disabled="requestBusy || !connected"
                    class="cancel"
                    type="button"
                    @click='decide(job, "reject")'
                  >{{ job.status === "queued" ? "順番待ちを取り消す" : "送らずに取り消す" }}</button></div></li></ul>
            <div v-if="confirmReset" class="reset-confirm"><p>いまの作品とカードを消して、次の参加者の初期状態に戻します。</p><div class="staff-actions"><button
                  :disabled="requestBusy || !connected"
                  class="send"
                  type="button"
                  @click="resetBooth"
                >リセットする</button><button
                  :disabled="requestBusy"
                  class="cancel"
                  type="button"
                  @click="confirmReset = false"
                >戻る</button></div></div><button
              v-else
              :disabled="requestBusy || !connected"
              class="cancel next"
              type="button"
              @click="confirmReset = true"
            >次の人へ</button>
          </div>
        </div>
      </section>
    </div>
    <section aria-label="アプリのプレビュー" class="preview">
      <p class="preview-label">📱 プレビュー</p>
      <div :class='["phone", { building: busy }]' :aria-busy="busy">
        <iframe
          v-if="previewUrl"
          :key="revision"
          sandbox="allow-scripts"
          :src="safeUrl(previewUrl)"
          title="わたしの勉強リストのプレビュー"
        ></iframe>
        <div v-if="busy" class="building-overlay" role="status">
          <span aria-hidden="true" class="bot">🤖</span><strong>AIがアプリを作っています</strong><progress aria-label="アプリを作成中"></progress>
          <small>{{ aiRunning ? "できあがるまで、少し待ってね" : "選んだ内容を、アプリに組み込んでいます" }}</small>
        </div>
      </div>
    </section>
    <dialog ref="cardDialog" aria-labelledby="card-title" class="card-chat">
      <template v-if="selected">
        <header><div><h2 id="card-title">{{ selected.title }}</h2><p>{{ selected.description }}</p></div><button aria-label="とじる" type="button" @click="dialog?.close()">×</button></header>
        <div class="log">
          <template v-for="(question, index) in selected.questions" :key="question.text">
            <p v-if="index <= selected.answers.length" class="msg ai">{{ question.text }}</p>
            <p v-if="index < selected.answers.length" class="msg me">{{ question.options.find((option) => option.value === selected?.answers[index])?.label }}</p>
          </template>
          <p v-if="action" class="msg ai">これで作ってみよう！</p>
        </div>
        <div v-if="nextQuestion" class="choices"><button
            v-for="option in nextQuestion.options"
            :key="String(option.value)"
            type="button"
            @click="answer(option.value)"
          >{{ option.label }}</button></div>
        <div v-if="action" class="prompt"><strong>AI への指示</strong>{{ instructionFor(action) }}</div>
        <div class="card-actions">
          <button
            v-if="selected.answers.length"
            class="secondary"
            type="button"
            @click="selected.answers.pop()"
          >ひとつ戻る</button>
          <button v-if="action" class="primary" type="button" @click="develop(selected.id)">これで作る</button>
        </div>
      </template>
    </dialog>
    <dialog ref="ideaDialog" aria-labelledby="idea-title" class="card-chat idea-dialog">
      <header><div><h2 id="idea-title">自分のアイデア</h2><p v-if="selectedIdea">{{ jobStatusLabels[selectedIdea.status] }}</p></div><button aria-label="とじる" type="button" @click="ideaDialog?.close()">×</button></header>
      <template v-if="selectedIdea">
        <div class="idea-details"><p class="idea-prompt">{{ selectedIdea.prompt }}</p><p class="idea-result" role="status">{{
              selectedIdea.status === "draft"
                ? "「作る」でスタッフに確認をお願いしよう。"
                : selectedIdea.status === "succeeded"
                  ? "できあがったよ！ プレビューで試してみよう。"
                  : selectedIdea.message
            }}</p><p v-if="jobError" class="request-error" role="alert">{{ jobError }}</p><progress v-if='selectedIdea.status === "running"' aria-label="AIが作成中です"></progress></div>
        <div class="card-actions"><button
            v-if='jobColumn(selectedIdea) === "todo"'
            :disabled="requestBusy || !connected"
            class="secondary"
            type="button"
            @click="removeIdea(selectedIdea)"
          >カードを取り消す</button><button
            v-if="canRequestJob(selectedIdea)"
            :disabled="busy || requestBusy || !connected || !ready"
            class="primary"
            type="button"
            @click="buildIdea(selectedIdea)"
          >{{ selectedIdea.status === "draft" ? "これで作る" : "もう一度作る" }}</button></div>
      </template>
      <p v-else class="idea-details">このカードはリセットされました。</p>
    </dialog>
  </div>
</template>
