import { parseFeatures } from "./features";

export function safeUrl(value: string) {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value))
    throw new Error("プレビューのURLが正しくありません。");
  new URL(value);
  return value;
}

export function parseWorkspaceState(value: unknown) {
  if (
    typeof value !== "object" ||
    value === null ||
    !("features" in value) ||
    !("previewUrl" in value) ||
    !("revision" in value) ||
    typeof value.previewUrl !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  )
    throw new Error("作業状態を読み取れません。スタッフに確認してください。");
  return {
    features: parseFeatures(value.features),
    previewUrl: safeUrl(value.previewUrl),
    revision: value.revision,
  };
}
