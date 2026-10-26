import { zh, type Dict, type DictPartial } from "./zh";
import { en } from "./en";

export type Locale = "zh" | "en";

/** 合并字典：en 缺失的 key 回落 zh（英文版最后补齐） */
export function getDict(locale: Locale = "zh"): Dict {
  if (locale === "zh") return zh;
  const merged: Record<string, unknown> = { ...zh };
  for (const [key, value] of Object.entries(en as DictPartial)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      merged[key] = value;
    } else {
      merged[key] = { ...(zh as Record<string, object>)[key], ...value };
    }
  }
  return merged as Dict;
}

/** 模板占位替换：format("{rank}", { rank: "1 / 100" }) */
export function format(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`,
  );
}
