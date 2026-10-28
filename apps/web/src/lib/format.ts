/** Date formatting utilities */

export function formatDate(value?: string | null): string {
  if (!value) return "Unknown";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** 中文日期 YYYY-MM-DD（GitHub 榜使用，避免英文月份） */
export function formatDateZh(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

/** ISO date for <time> tags */
export function toISODate(value?: string | null): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** 注册时间统一格式 YYYY-MM-DD（列表页使用） */
export function formatDateShort(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** 数字缩写：5503 → 5.5K（对齐哥伦布展示口径） */
export function formatCount(value?: number | null): string {
  if (value === null || value === undefined) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
