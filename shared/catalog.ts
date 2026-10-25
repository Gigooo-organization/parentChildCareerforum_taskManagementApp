import type { Color, Features } from "./features";

export type CatalogId = "points" | "progress" | "celebrate" | Color;
export type Answer = string | number | boolean;
export type CatalogAction =
  | { kind: "points"; per: 5 | 10 | 100 }
  | { kind: "progress"; number: boolean }
  | { kind: "celebrate"; face: "🥳" | "🐱" | "🚀"; msg: string }
  | { kind: "color"; color: Color };
export type Question = { text: string; options: { label: string; value: Answer }[] };
export type CatalogCard = {
  id: CatalogId;
  title: string;
  description: string;
  questions: Question[];
};

const praise = ["よくがんばりました！", "天才！", "明日もこの調子！"];
export const colorNames = { blue: "ブルー", pink: "ピンク", green: "グリーン", orange: "オレンジ" };
export const catalog: CatalogCard[] = [
  {
    id: "points",
    title: "ポイント機能",
    description: "タスクを終わらせるとポイントが貯まる",
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
    description: "今日の達成率を表示する",
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
    description: "全部終わったらお祝いしてくれる",
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
  ...(["pink", "green", "orange", "blue"] satisfies Color[]).map(
    (id): CatalogCard => ({
      id,
      title: `色を${colorNames[id]}に`,
      description: "自分だけのテーマカラーにしよう",
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
    case "color":
      return { ...features, color: action.color };
  }
}

export function instructionFor(action: CatalogAction) {
  switch (action.kind) {
    case "points":
      return `タスクを完了すると ${action.per} ポイント貯まる機能を追加して。合計ポイントはヘッダーの右に表示して。`;
    case "progress":
      return `今日のタスクの達成率を表示する進捗バーを、タスク一覧の上に追加して。${action.number ? "「60%」のように数字も表示して。" : "数字は出さずにバーだけにして。"}`;
    case "celebrate":
      return `すべてのタスクを完了したら、全画面でお祝いを表示する機能を追加して。キャラクターは ${action.face}、メッセージは「${action.msg}」にして。`;
    case "color":
      return `アプリのテーマカラーを${colorNames[action.color]}にして。`;
  }
}
