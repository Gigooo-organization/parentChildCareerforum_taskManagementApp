import { expect, it } from "vite-plus/test";
import { suggestSplit } from "./splitSuggestion";

it("suggests separate cards while retaining a shared target and action", () => {
  expect(suggestSplit("宿題に締切と通知とカレンダーを追加して。")).toEqual([
    "宿題に締切を追加して",
    "宿題に通知を追加して",
    "宿題にカレンダーを追加して",
  ]);
});

it("keeps the wording of separate requests", () => {
  expect(suggestSplit("宿題に締切をつけて、期限切れの宿題を先頭に出して")).toEqual([
    "宿題に締切をつけて",
    "期限切れの宿題を先頭に出して",
  ]);
});

it("leaves a single request or quoted text available for manual review", () => {
  expect(suggestSplit("宿題に締切をつけて")).toEqual([]);
  expect(suggestSplit("見出しを「勉強しよう！応援してる！」に変えて")).toEqual([]);
});
