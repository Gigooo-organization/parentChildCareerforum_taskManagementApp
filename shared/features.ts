export type Color = "blue" | "pink" | "green" | "orange";
export type Features = {
  color: Color;
  points?: { per: 5 | 10 | 100 };
  progress?: { number: boolean };
  celebrate?: { face: "🥳" | "🐱" | "🚀"; msg: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseFeatures(input: unknown): Features {
  if (!isRecord(input) || !onlyKeys(input, ["color", "points", "progress", "celebrate"])) {
    throw new Error("機能の設定が正しくありません。");
  }
  const { color, points, progress, celebrate } = input;
  if (color !== "blue" && color !== "pink" && color !== "green" && color !== "orange") {
    throw new Error("色はブルー・ピンク・グリーン・オレンジから選んでください。");
  }
  const features: Features = { color };
  if (points !== undefined) {
    if (
      !isRecord(points) ||
      !onlyKeys(points, ["per"]) ||
      (points.per !== 5 && points.per !== 10 && points.per !== 100)
    ) {
      throw new Error("ポイントは5・10・100から選んでください。");
    }
    features.points = { per: points.per };
  }
  if (progress !== undefined) {
    if (
      !isRecord(progress) ||
      !onlyKeys(progress, ["number"]) ||
      typeof progress.number !== "boolean"
    ) {
      throw new Error("達成率の表示設定が正しくありません。");
    }
    features.progress = { number: progress.number };
  }
  if (celebrate !== undefined) {
    if (
      !isRecord(celebrate) ||
      !onlyKeys(celebrate, ["face", "msg"]) ||
      (celebrate.face !== "🥳" && celebrate.face !== "🐱" && celebrate.face !== "🚀") ||
      typeof celebrate.msg !== "string" ||
      !celebrate.msg.trim() ||
      celebrate.msg.length > 80
    ) {
      throw new Error("お祝いのキャラクターと1〜80文字のメッセージを選んでください。");
    }
    features.celebrate = { face: celebrate.face, msg: celebrate.msg };
  }
  return features;
}

export function summarizeTasks(tasks: readonly { done: boolean }[], features: Features) {
  const done = tasks.filter((task) => task.done).length;
  return {
    done,
    percent: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    points: done * (features.points?.per ?? 0),
    celebrate: Boolean(features.celebrate && done > 0 && done === tasks.length),
  };
}
