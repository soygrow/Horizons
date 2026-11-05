/**
 * 展示格式化。
 *
 * 日期一律输出 YYYY-MM-DD，全站只走这里。
 * 不要在页面里直接调 `toLocaleDateString` / `Intl.DateTimeFormat`：输出会随
 * 浏览器 locale 变成 "Nov 4, 2026" 或 "2026/11/04"，同一份数据在不同页面
 * 出现不同写法，且难以整体纠正。新增日期展示时只调 `formatDate`。
 */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 任意日期字符串 / ISO 时间戳 → YYYY-MM-DD，无法解析时返回 null */
function toYMD(value?: string | null): string | null {
  if (!value) return null;
  // 已是日期字符串（含日期前缀）时直接取，避免 new Date("2026-11-04") 按 UTC
  // 解析后在西半球时区被减成前一天
  const plain = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (plain) return `${plain[1]}-${plain[2]}-${plain[3]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 统一日期展示：2026-11-04 */
export function formatDate(value?: string | null): string {
  return toYMD(value) ?? "—";
}

/** 兼容旧调用，行为与 formatDate 完全一致 */
export function formatDateZh(value?: string | null): string {
  return formatDate(value);
}

/** 兼容旧调用，行为与 formatDate 完全一致 */
export function formatDateShort(value?: string | null): string {
  return formatDate(value);
}

export function toISODate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** 数字缩写：5503 → 5.5K */
export function formatCount(value?: number | null): string {
  if (value === null || value === undefined) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}