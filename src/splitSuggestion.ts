export function suggestSplit(prompt: string): string[] {
  // Quoted text can contain punctuation or conjunctions that belong in one card.
  if (/[「」『』“”"]/u.test(prompt)) return [];
  const parts = prompt
    .split(/[。！？!?\n]+|(?<=[しけっ]て)[、,]|[、,]?(?:それから|ついでに|さらに)/u)
    .map((part) => part.trim().replace(/^(?:[-・]\s*|\d+[.．)）]\s*)/u, ""))
    .filter(Boolean);
  if (parts.length > 1)
    return parts.length <= 5 && new Set(parts).size === parts.length ? parts : [];

  const list =
    /^(?<target>[^、。\n]+?[にへ])?(?<items>[^、。\n]+)を(?<action>(?:追加|実装|作)[^。\n]*)。?$/u.exec(
      prompt.trim(),
    )?.groups;
  if (!list?.items || !list.action) return [];
  const items = list.items.split(/と|および/u).map((item) => item.trim());
  if (
    items.length < 2 ||
    items.length > 5 ||
    items.some((item) => !item || item.length > 20) ||
    new Set(items).size !== items.length
  )
    return [];
  return items.map((item) => `${list.target ?? ""}${item}を${list.action}`);
}
