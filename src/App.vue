<script setup lang="ts">
import { computed, onMounted, ref, useTemplateRef } from "vue";
import { actionFromAnswers, applyAction, catalog, instructionFor } from "@booth-shared/catalog";
import type { Answer, CatalogCard, CatalogId } from "@booth-shared/catalog";
import { parseFeatures } from "@booth-shared/features";
import type { Features } from "@booth-shared/features";
import { parseWorkspaceState, safeUrl } from "@booth-shared/workspace";

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
const busy = ref(false);
const error = ref("");
const messages = ref([
  "カードを押して、作りたい機能を決めよう。プレビューで自分のアプリを試せるよ！",
]);
const dialog = useTemplateRef<HTMLDialogElement>("cardDialog");
const dragged = ref<CatalogId | null>(null);
const over = ref(false);
const ready = ref(false);
const previewUrl = ref("");
const revision = ref(0);

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
  busy.value = true;
  const previousColumn = card.column;
  card.column = "doing";
  dialog.value?.close();
  messages.value.push(`AI への指示：${instructionFor(chosen)}`);
  try {
    const response = await fetch("/api/features", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(applyAction(features.value, chosen)),
    });
    if (!response.ok)
      throw new Error("変更を反映できませんでした。スタッフに確認して、もう一度試してね。");
    features.value = parseFeatures(await response.json());
    card.column = "done";
    messages.value.push(`${card.title}が完成！ プレビューで試してみよう。`);
  } catch (cause) {
    card.column = previousColumn;
    error.value = cause instanceof Error ? cause.message : "変更を反映できませんでした。";
  } finally {
    busy.value = false;
  }
}
function dropCard() {
  over.value = false;
  if (dragged.value) void develop(dragged.value);
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
            <h2>{{ column.title }} <span>{{ cards.filter((card) => card.column === column.id).length + (column.id === "done" ? 2 : 0) }}</span></h2>
            <ul class="cards">
              <template v-if='column.id === "done"'>
                <li class="card built-in"><strong>チェック機能</strong><small>完了したタスクにチェック</small></li>
                <li class="card built-in"><strong>タスク追加</strong><small>候補から選んで追加</small></li>
              </template>
              <li
                v-for="card in cards.filter(item => item.column === column.id)"
                :key="card.id"
                class="card"
                :draggable="!busy && ready"
                @dragstart="dragged = card.id"
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
      <section aria-labelledby="chat-title" class="panel chat-panel">
        <h2 id="chat-title">AI に頼む</h2>
        <div aria-live="polite" class="log"><p v-for="(message, index) in messages" :key="index" class="msg ai">{{ message }}</p></div>
        <p class="chat-note">自由なお願いは、スタッフの確認後にAIへ送る機能を準備中です。</p>
      </section>
    </div>
    <section aria-label="アプリのプレビュー" class="preview">
      <p class="preview-label">📱 プレビュー</p>
      <div :class='["phone", { building: busy }]'>
        <iframe
          v-if="previewUrl"
          :key="revision"
          sandbox="allow-scripts"
          :src="safeUrl(previewUrl)"
          title="わたしの勉強リストのプレビュー"
        ></iframe>
        <div v-if="busy" class="building-overlay" role="status">
          <span aria-hidden="true" class="bot">🤖</span><strong>アプリに反映しています</strong><progress aria-label="変更を反映中"></progress>
          <small>決めた設定をプレビューに届けています</small>
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
  </div>
</template>
