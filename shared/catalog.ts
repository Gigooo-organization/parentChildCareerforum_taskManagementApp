import type { Color, Features, TaskOrder } from "./features";

export type CatalogId = "points" | "progress" | "celebrate" | "taskOrder" | "goal" | Color;
export type Answer = string | number | boolean;
export type CatalogAction =
  | { kind: "points"; per: 5 | 10 | 100 }
  | { kind: "progress"; number: boolean }
  | { kind: "celebrate"; face: "🥳" | "🐱" | "🚀"; msg: string }
  | { kind: "taskOrder"; order: TaskOrder }
  | { kind: "goal"; text: string }
  | { kind: "color"; color: Color };
export type Question = { text: string; options: { label: string; value: Answer }[] };
export type CatalogCard = {
  id: CatalogId;
  title: string;
  description: string;
  questions: Question[];
};

const praise = ["よくがんばりました！", "天才！", "明日もこの調子！"];
const goalOptions = [
  "今日の宿題を全部終わらせる",
  "あと回しにしていたタスクを1つ終わらせる",
  "苦手な教科を10分だけやる",
];
export const colorNames = { blue: "ブルー", pink: "ピンク", green: "グリーン", orange: "オレンジ" };
export const catalog: CatalogCard[] = [
  {
    id: "points",
    title: "ポイント機能",
    description: "タスクを完了するとポイントが貯まり、合計が見出しの右に出る",
    questions: [
      {
        text: "タスクを1つ終わらせたら、何ポイントもらえるようにする？",
        options: [5, 10, 100].map((value) => ({ label: `${value}ポイント`, value })),
      },
    ],
  },
  {
    id: "progress",
    title: "進捗バー",
    description: "タスク一覧の上に、今日の達成率を表示する",
    questions: [
      {
        text: "達成率はどうやって見せる？",
        options: [
          { label: "数字（60%）とバー", value: true },
          { label: "バーだけ", value: false },
        ],
      },
    ],
  },
  {
    id: "celebrate",
    title: "お祝い機能",
    description: "すべてのタスクを完了すると、お祝い画面が開く",
    questions: [
      {
        text: "お祝いしてくれるキャラクターはどれにする？",
        options: [
          { label: "🥳 パーティー", value: "🥳" },
          { label: "🐱 ねこ", value: "🐱" },
          { label: "🚀 ロケット", value: "🚀" },
        ],
      },
      { text: "なんてほめてもらう？", options: praise.map((value) => ({ label: value, value })) },
    ],
  },
  {
    id: "taskOrder",
    title: "タスクを並べ替える",
    description: "タスク一覧を未完了が先か追加した順に並べる",
    questions: [
      {
        text: "タスクはどんな順番が見やすい？",
        options: [
          { label: "まだ終わっていないタスクを上に", value: "unfinished-first" },
          { label: "追加した順", value: "added" },
        ],
      },
    ],
  },
  {
    id: "goal",
    title: "今日の目標を表示する",
    description: "勉強リストの上に目標を出す",
    questions: [
      {
        text: "今日の目標はどれにする？",
        options: goalOptions.map((text) => ({ label: text, value: text })),
      },
    ],
  },
  ...(["pink", "green", "orange", "blue"] satisfies Color[]).map(
    (id): CatalogCard => ({
      id,
      title: `テーマカラーを${colorNames[id]}に`,
      description: "勉強リストの背景や「タスクを追加」ボタンの色を変える",
      questions: [],
    }),
  ),
];

export function actionFromAnswers(id: CatalogId, answers: readonly Answer[]): CatalogAction | null {
  const [first, second] = answers;
  switch (id) {
    case "points":
      return first === 5 || first === 10 || first === 100 ? { kind: "points", per: first } : null;
    case "progress":
      return typeof first === "boolean" ? { kind: "progress", number: first } : null;
    case "celebrate":
      return (first === "🥳" || first === "🐱" || first === "🚀") &&
        typeof second === "string" &&
        praise.includes(second)
        ? { kind: "celebrate", face: first, msg: second }
        : null;
    case "taskOrder":
      return first === "added" || first === "unfinished-first"
        ? { kind: "taskOrder", order: first }
        : null;
    case "goal":
      return typeof first === "string" && goalOptions.includes(first)
        ? { kind: "goal", text: first }
        : null;
    default:
      return { kind: "color", color: id };
  }
}

export function applyAction(features: Features, action: CatalogAction): Features {
  switch (action.kind) {
    case "points":
      return { ...features, points: { per: action.per } };
    case "progress":
      return { ...features, progress: { number: action.number } };
    case "celebrate":
      return { ...features, celebrate: { face: action.face, msg: action.msg } };
    case "taskOrder":
      return { ...features, taskOrder: action.order };
    case "goal":
      return { ...features, goal: action.text };
    case "color":
      return { ...features, color: action.color };
  }
}

export function instructionFor(action: CatalogAction) {
  switch (action.kind) {
    case "taskOrder":
      return action.order === "unfinished-first"
        ? "まだ終わっていないタスクを一覧の上にまとめて。同じグループでは追加した順に並べて。"
        : "タスクは完了しているかに関係なく、追加した順に並べて。";
    case "goal":
      return `勉強リストの上に、今日の目標「${action.text}」を表示して。`;
    case "points":
      return `タスクを完了すると ${action.per} ポイント貯まる機能を追加して。合計ポイントはヘッダーの右に表示して。`;
    case "progress":
      return `今日のタスクの達成率を表示する進捗バーを、タスク一覧の上に追加して。${action.number ? "「60%」のように数字も表示して。" : "数字は出さずにバーだけにして。"}`;
    case "celebrate":
      return `すべてのタスクを完了したら、全画面でお祝いを表示する機能を追加して。キャラクターは ${action.face}、メッセージは「${action.msg}」にして。`;
    case "color":
      return `勉強リストの背景や「タスクを追加」ボタンに使うテーマカラーを${colorNames[action.color]}にして。`;
  }
}
