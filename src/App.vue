<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from "vue";
import { actionFromAnswers, applyAction, catalog, instructionFor } from "@booth-shared/catalog";
import type { Answer, CatalogCard, CatalogId } from "@booth-shared/catalog";
import { parseFeatures } from "@booth-shared/features";
import type { Features } from "@booth-shared/features";
import { parseWorkspaceState, safeUrl } from "@booth-shared/workspace";
import { useBoothJobs } from "./useBoothJobs";
import {
  canCancelJobRequest,
  canRequestJob,
  clarificationLimit,
  jobColumn,
  jobStatusLabels,
} from "@booth-shared/jobs";
import type { Job } from "@booth-shared/jobs";
import { buildCatalog } from "./catalogBuild";
import { aiProviders, aiSelectionLabel, parseAiSelection } from "@booth-shared/ai";
import type { AiSelection } from "@booth-shared/ai";
import { suggestSplit } from "./splitSuggestion";

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
  clarify,
  retryCheck,
  split,
  reset: resetBooth,
} = useBoothJobs({ changed: loadState, reset: resetWorkspace });
const connected = computed(() => connection.value === "connected");
const aiRunning = computed(() => jobs.value.some((job) => job.status === "running"));
const busy = computed(() => applying.value || aiRunning.value);
const selectedIdeaId = ref<string | null>(null);
const selectedIdea = computed(() => jobs.value.find((job) => job.id === selectedIdeaId.value));
const clarification = ref("");
const answerLimit = computed(() =>
  selectedIdea.value ? clarificationLimit(selectedIdea.value) : 0,
);
watch(selectedIdeaId, () => {
  clarification.value = "";
});
const ideaDialog = useTemplateRef<HTMLDialogElement>("ideaDialog");
const staffDialog = useTemplateRef<HTMLDialogElement>("staffDialog");
const staffClose = useTemplateRef<HTMLButtonElement>("staffClose");
const staffOpen = ref(false);
const confirmReset = ref(false);
const aiSettingsOpen = ref(false);
const ai = ref<AiSelection>({ provider: "codex", model: "default" });
const draftProvider = ref<AiSelection["provider"]>("codex");
const draftModel = ref("default");
const savingAi = ref(false);
const aiError = ref("");
const aiNotice = ref("");
const aiLocked = computed(() =>
  jobs.value.some((job) => job.status === "queued" || job.status === "running"),
);
const modelOptions = computed(() =>
  draftProvider.value === "codex" ? aiProviders[0].models : aiProviders[1].models,
);
const splitIdea = ref<{ id: string; prompts: string[] } | null>(null);
const staffJobs = computed(() => jobs.value.filter(canCancelJobRequest));
const staffPendingCount = computed(
  () => staffJobs.value.filter((job) => job.status === "pending").length,
);
const splitSuggestions = computed(
  () =>
    new Map(
      staffJobs.value
        .filter((job) => job.status === "pending")
        .map((job) => [job.id, suggestSplit(job.prompt)]),
    ),
);
const suggestions = [
  "見出しを「わたしのチャレンジリスト」に変えて",
  "勉強を応援するひとことを追加して",
  "「本を10分読む」をタスクの候補に追加して",
];

function jobsFor(column: Column) {
  return jobs.value.filter((job) => jobColumn(job) === column).reverse();
}
function openStaff() {
  if (!staffDialog.value) return;
  staffDialog.value.showModal();
  staffOpen.value = true;
  void loadAiSelection();
}
function closeStaff() {
  staffOpen.value = false;
  confirmReset.value = false;
  aiSettingsOpen.value = false;
  splitIdea.value = null;
}
async function openSplit(job: Job) {
  const suggested = splitSuggestions.value.get(job.id);
  splitIdea.value = { id: job.id, prompts: suggested?.length ? [...suggested] : ["", ""] };
  await nextTick();
  staffDialog.value?.querySelector("textarea")?.focus();
}
async function saveSplit(job: Job) {
  const draft = splitIdea.value;
  if (draft?.id !== job.id || draft.prompts.some((part) => !part.trim())) return;
  if (await split(job, draft.prompts)) {
    splitIdea.value = null;
    staffClose.value?.focus();
  }
}
async function reviewIdea(job: Job, decision: "approve" | "reject") {
  if (await decide(job, decision)) staffClose.value?.focus();
}
function openIdea(job: Job) {
  selectedIdeaId.value = job.id;
  ideaDialog.value?.showModal();
}
async function buildIdea(job: Job) {
  if (busy.value || requestBusy.value || !connected.value || !ready.value) return;
  if (await requestBuild(job)) ideaDialog.value?.close();
}
async function answerIdea(job: Job) {
  if (await clarify(job, clarification.value)) clarification.value = "";
}
function setAi(selected: AiSelection) {
  ai.value = selected;
  draftProvider.value = selected.provider;
  draftModel.value = selected.model;
}

async function loadState() {
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error("作業状態を読み取れません。スタッフに確認してください。");
    const state = parseWorkspaceState(await response.json());
    features.value = state.features;
    previewUrl.value = state.previewUrl;
    revision.value = state.revision;
    setAi(state.ai);
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
        case "taskOrder":
          card.answers = state.features.taskOrder ? [state.features.taskOrder] : [];
          break;
        case "goal":
          card.answers = state.features.goal ? [state.features.goal] : [];
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
async function saveAi() {
  if (savingAi.value || aiLocked.value || !ready.value) return;
  savingAi.value = true;
  aiError.value = "";
  aiNotice.value = "";
  try {
    const selected = parseAiSelection({ provider: draftProvider.value, model: draftModel.value });
    const response = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selected),
    }).catch(() => {
      throw new Error("サーバーに接続できませんでした。もう一度試してください。");
    });
    const body: unknown = await response.json().catch(() => {
      throw new Error("応答を読み取れませんでした。もう一度試してください。");
    });
    if (!response.ok)
      throw new Error(
        typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
          ? body.error
          : "作成用AIを変更できませんでした。もう一度試してください。",
      );
    setAi(parseWorkspaceState(body).ai);
    aiNotice.value = "作成用AIを変更しました。";
  } catch (cause) {
    aiError.value = cause instanceof Error ? cause.message : "作成用AIを変更できませんでした。";
  } finally {
    savingAi.value = false;
  }
}
async function loadAiSelection() {
  if (savingAi.value) return;
  savingAi.value = true;
  try {
    const response = await fetch("/api/state");
    if (!response.ok) throw new Error();
    setAi(parseWorkspaceState(await response.json()).ai);
    aiError.value = "";
  } catch {
    aiError.value = "作成用AIの設定を読み取れませんでした。開きなおしてください。";
  } finally {
    savingAi.value = false;
  }
}
async function resetWorkspace() {
  selectedIdeaId.value = null;
  ideaDialog.value?.close();
  confirmReset.value = false;
  splitIdea.value = null;
  staffDialog.value?.close();
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
        <header class="board-head">
          <h1 id="board-title">次の開発リスト <small>カードでくわしく決めたら「作る」を押そう</small></h1>
          <button
            :class='["staff-trigger", { "has-pending": staffPendingCount }]'
            aria-haspopup="dialog"
            type="button"
            @click="openStaff"
          >スタッフ確認<span v-if="staffPendingCount" class="staff-count">{{ staffPendingCount }}件待ち</span></button>
        </header>
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
                  v-else-if='job.status === "running" || job.status === "checking"'
                  :aria-label='job.status === "checking" ? "内容を確認中" : "AIが作成中"'
                  class="spinner"
                ></span>
                <button
                  v-else-if='job.status === "hearing" || job.status === "check_failed"'
                  class="go"
                  type="button"
                  @click="openIdea(job)"
                >{{ job.status === "hearing" ? "教える" : "内容を見る" }}</button>
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
        <p class="input-note">まず「つぎに作る」に追加。内容を確認して、必要なことを聞いてから作ろう。</p>
        <p v-if='connection !== "connected"' class="connection" role="status">{{
            connection === "invalid"
              ? "カードの状態を読み取れません。スタッフに確認してください。"
              : "カードの状態に接続しています。カタログはそのまま使えます。"
          }}</p>
        <p v-if="jobError && !staffOpen" class="request-error" role="alert">{{ jobError }}</p>
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
    <dialog
      ref="staffDialog"
      aria-labelledby="staff-title"
      class="card-chat staff-dialog"
      @close="closeStaff"
    >
      <header>
        <div><h2 id="staff-title">スタッフ確認</h2><p v-if="staffPendingCount">{{ staffPendingCount }}件の依頼が確認待ち</p></div>
        <button ref="staffClose" aria-label="閉じる" type="button" @click="staffDialog?.close()">×</button>
      </header>
      <div class="staff-body">
        <p v-if="jobError && staffOpen" class="request-error" role="alert">{{ jobError }}</p>
        <p v-if="!connected" class="connection" role="status">カードの状態に接続しています。</p>
        <p v-else-if="!staffJobs.length" class="staff-empty">確認待ちや順番待ちの依頼はありません。</p>
        <ul v-if="staffJobs.length" class="staff-requests">
          <li v-for="job in staffJobs" :key="job.id" class="staff-request">
            <span :class='["staff-status", { "is-pending": job.status === "pending" }]'>{{ jobStatusLabels[job.status] }}</span>
            <p class="staff-prompt">{{ job.prompt }}</p>
            <form
              v-if='job.status === "pending" && splitIdea?.id === job.id'
              class="split-form"
              @submit.prevent="saveSplit(job)"
            >
              <p>カードの文面を確認して「つぎに作る」に追加します。</p>
              <template v-for="(_, index) in splitIdea.prompts" :key="index">
                <label :for='"split-part-" + index'>カード {{ index + 1 }}</label>
                <textarea
                  :id='"split-part-" + index'
                  v-model="splitIdea.prompts[index]"
                  :disabled="requestBusy"
                  maxlength="1000"
                  rows="2"
                ></textarea>
              </template>
              <div class="staff-actions">
                <button
                  :disabled="requestBusy"
                  class="cancel"
                  type="button"
                  @click="splitIdea = null"
                >戻る</button>
                <button
                  :disabled="requestBusy || !connected || splitIdea.prompts.some((part) => !part.trim())"
                  class="send"
                  type="submit"
                >分けて一覧に追加</button>
              </div>
            </form>
            <div v-else class="staff-actions">
              <button
                :disabled="requestBusy || !connected"
                class="staff-withdraw"
                type="button"
                @click='reviewIdea(job, "reject")'
              >{{ job.status === "queued" ? "順番待ちを取り消す" : "確認依頼を取り消す" }}</button>
              <template v-if='job.status === "pending"'>
                <button
                  :disabled="requestBusy || !connected"
                  class="cancel"
                  type="button"
                  @click="openSplit(job)"
                >{{
                    splitSuggestions.get(job.id)?.length ? "分割案を見る" : "依頼を分ける"
                  }}</button>
                <button
                  :disabled="requestBusy || !connected || savingAi"
                  class="send"
                  type="button"
                  @click='reviewIdea(job, "approve")'
                >承認してAIへ送る</button>
              </template>
            </div>
          </li>
        </ul>
        <div class="staff-ai">
          <button
            aria-controls="staff-ai-settings"
            class="staff-ai-toggle"
            type="button"
            :aria-expanded="aiSettingsOpen"
            @click="aiSettingsOpen = !aiSettingsOpen"
          >作成用AI <span v-if="ready">{{ aiSelectionLabel(ai) }}</span></button>
          <form
            v-show="aiSettingsOpen"
            id="staff-ai-settings"
            class="ai-settings"
            @submit.prevent="saveAi"
          >
            <p v-if="ready">適用中：{{ aiSelectionLabel(ai) }}</p>
            <label for="ai-provider">AI</label>
            <select
              id="ai-provider"
              v-model="draftProvider"
              :disabled="savingAi || aiLocked || !ready"
              @change='draftModel = "default"'
            >
              <option v-for="provider in aiProviders" :key="provider.id" :value="provider.id">{{ provider.label }}</option>
            </select>
            <label for="ai-model">モデル</label>
            <select id="ai-model" v-model="draftModel" :disabled="savingAi || aiLocked || !ready">
              <option v-for="model in modelOptions" :key="model.id" :value="model.id">{{ model.label }}</option>
            </select>
            <button class="send" type="submit" :disabled="savingAi || aiLocked || !ready">{{ savingAi ? "更新中…" : "このAIとモデルを使う" }}</button>
            <p v-if="aiLocked">作成が終わってから変更できます。</p>
            <p v-else>次に承認する作成に使います。参加者をリセットしても選択は残ります。</p>
            <p v-if="aiError" class="ai-settings-error" role="alert">{{ aiError }}</p>
            <p v-if="aiNotice" role="status">{{ aiNotice }}</p>
          </form>
        </div>
      </div>
      <footer class="staff-footer">
        <template v-if="confirmReset">
          <p>いまの作品とカードを消して、次の参加者の初期状態に戻します。</p>
          <div class="staff-actions">
            <button
              :disabled="requestBusy"
              class="cancel"
              type="button"
              @click="confirmReset = false"
            >戻る</button>
            <button
              :disabled="requestBusy || !connected"
              class="staff-reset"
              type="button"
              @click="resetBooth"
            >リセットする</button>
          </div>
        </template>
        <button
          v-else
          :disabled="requestBusy || !connected"
          class="cancel"
          type="button"
          @click="confirmReset = true"
        >次の人へ</button>
      </footer>
    </dialog>
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
            }}</p><p v-if="jobError" class="request-error" role="alert">{{ jobError }}</p><progress
            v-if='selectedIdea.status === "running" || selectedIdea.status === "checking"'
            :aria-label='selectedIdea.status === "checking" ? "内容を確認中です" : "AIが作成中です"'
          ></progress>
          <form
            v-if='selectedIdea.status === "hearing"'
            class="hearing-form"
            @submit.prevent="answerIdea(selectedIdea)"
          >
            <label for="hearing-answer">追加の説明</label>
            <textarea
              id="hearing-answer"
              v-model="clarification"
              :maxlength="answerLimit"
              :disabled="requestBusy || !connected || answerLimit === 0"
              aria-describedby="hearing-limit"
              placeholder="例：背景をピンクにして、見出しに花をつけたい"
              rows="3"
            ></textarea>
            <small id="hearing-limit">最初の内容と合わせて1000文字まで。追加できるのは{{ answerLimit }}文字です。</small>
            <p v-if="answerLimit === 0">最初の内容を短くまとめて、新しいカードとして追加してね。</p>
            <button
              class="primary"
              type="submit"
              :disabled="!clarification.trim() || clarification.length > answerLimit || requestBusy || !connected"
            >説明を追加して確認する</button>
          </form>
          <button
            v-if='selectedIdea.status === "check_failed"'
            class="primary retry-check"
            :disabled="requestBusy || !connected"
            type="button"
            @click="retryCheck(selectedIdea)"
          >もう一度確認する</button>
        </div>
        <div class="card-actions"><button
            v-if="canCancelJobRequest(selectedIdea)"
            :disabled="requestBusy || !connected"
            class="secondary"
            type="button"
            @click='decide(selectedIdea, "reject")'
          >{{ selectedIdea.status === "queued" ? "順番待ちを取り消す" : "確認依頼を取り消す" }}</button><button
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
