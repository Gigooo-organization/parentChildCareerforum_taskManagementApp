<script setup lang="ts">
import { computed, ref, shallowRef, useTemplateRef, watch } from "vue";
import { parseFeatures, summarizeTasks } from "@booth-shared/features";
import initialFeatures from "../features.json";
import { candidates, initialTasks } from "./tasks";

const features = shallowRef(parseFeatures(initialFeatures));
const tasks = ref(initialTasks());
const summary = computed(() => summarizeTasks(tasks.value, features.value));
const addedTitles = computed(() => new Set(tasks.value.map((task) => task.title)));
const addDialog = useTemplateRef<HTMLDialogElement>("addDialog");
const celebrateDialog = useTemplateRef<HTMLDialogElement>("celebrateDialog");

watch(
  () => summary.value.celebrate,
  (complete) => {
    if (complete) celebrateDialog.value?.showModal();
    else celebrateDialog.value?.close();
  },
  { flush: "post" },
);

function addTask(title: string) {
  if (!addedTitles.value.has(title)) tasks.value.push({ title, done: false });
  addDialog.value?.close();
}

function resetTasks() {
  tasks.value.forEach((task) => {
    task.done = false;
  });
}

if (import.meta.hot) {
  import.meta.hot.accept("../features.json", (module: { default: unknown } | undefined) => {
    if (module) features.value = parseFeatures(module.default);
  });
}
</script>

<template>
  <div :class='["study-app", features.color]'>
    <main>
      <header class="head">
        <span aria-hidden="true" class="icon">📖</span>
        <div><h1>わたしの勉強リスト</h1><p>コツコツ続けてがんばろう！</p></div>
        <span v-if="features.points" aria-live="polite" class="points"><i aria-hidden="true">P</i><span>{{ summary.points }}<span class="sr-only">ポイント</span></span></span>
      </header>
      <section v-if="features.progress" aria-label="今日の達成率" class="rate">
        <div>今日の達成率 <b v-if="features.progress.number">{{ summary.percent }}%</b></div>
        <progress :value="summary.percent" aria-label="タスクの達成率" max="100">{{ summary.percent }}%</progress>
      </section>
      <ul class="tasks">
        <li v-for="task in tasks" :key="task.title">
          <label><input v-model="task.done" type="checkbox" />{{ task.title }}<span v-if="features.points && task.done" class="plus">+{{ features.points.per }}P</span></label>
        </li>
      </ul>
      <button class="primary" type="button" @click="addDialog?.showModal()">＋ タスクを追加</button>
    </main>
    <nav aria-label="アプリのメニュー">
      <button aria-current="page" type="button"><b aria-hidden="true">⌂</b>ホーム</button>
      <button disabled type="button"><b aria-hidden="true">▦</b>カレンダー</button>
      <button disabled type="button"><b aria-hidden="true">◷</b>タイマー</button>
      <button disabled type="button"><b aria-hidden="true">⚙</b>設定</button>
    </nav>
    <dialog ref="celebrateDialog" aria-labelledby="celebrate-title" class="celebrate">
      <div aria-hidden="true" class="face">{{ features.celebrate?.face }}</div>
      <h2 id="celebrate-title">すべてのタスクを<br />完了しました！</h2>
      <p>{{ features.celebrate?.msg }}</p>
      <button class="primary" type="button" @click="resetTasks">つぎの目標を設定する</button>
    </dialog>
    <dialog ref="addDialog" aria-labelledby="add-title">
      <h2 id="add-title">追加するタスクをえらぼう</h2>
      <section v-for="(items, group) in candidates" :key="group">
        <h3>{{ group }}</h3>
        <div class="options"><button
            v-for="title in items"
            :key="title"
            type="button"
            :disabled="addedTitles.has(title)"
            @click="addTask(title)"
          >{{ title }}</button></div>
      </section>
      <button class="primary" type="button" @click="addDialog?.close()">とじる</button>
    </dialog>
  </div>
</template>
