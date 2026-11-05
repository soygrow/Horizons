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

/**
 * 上线时间的可信下限。
 *
 * 首快照取自 Wayback 最早上档时间：老域名（claude.com 1999、microsoft.com 1996）
 * 首快照记录的是域名前史（停放页/其他项目），不是 AI 产品上线，直接展示会误导。
 * 早于该日期的首快照一律降级为「—」，宁缺勿错。
 */
export const LAUNCH_PLAUSIBLE_FROM = "2017-01-01";

/** 首快照是否可当作产品上线时间（早于 2017 视为域名前史） */
export function isLaunchPlausible(value?: string | null): boolean {
  if (!value) return false;
  return value.slice(0, 10) >= LAUNCH_PLAUSIBLE_FROM;
}

/**
 * 环比展示上限：小基数站点会出现 +1133% 这类失真值，
 * 展示层截断为「200%+」，真实值放在 title 里。
 */
export const MOM_DISPLAY_CAP = 200;

/** 环比 % → 展示文本；超阈值截断为 "200%+" */
export function formatMom(value?: number | null): string {
  if (value === null || value === undefined) return "n/a";
  if (value > MOM_DISPLAY_CAP) return `${MOM_DISPLAY_CAP}%+`;
  return `${value > 0 ? "+" : ""}${value}%`;
}

/** 被截断时给出的真实值说明，供 title 使用 */
export function momCapHint(value?: number | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value <= MOM_DISPLAY_CAP) return undefined;
  return `上月基数偏小，实际环比 +${value}%`;
}

/** 数字缩写：5503 → 5.5K（对齐哥伦布展示口径） */
export function formatCount(value?: number | null): string {
  if (value === null || value === undefined) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}
