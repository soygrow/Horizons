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
  return (toYMD(value) ?? value) >= LAUNCH_PLAUSIBLE_FROM;
}

/**
 * 环比展示上限：小基数站点会出现 +1133% 这类失真值，
 * 展示层截断为「200%+」，真实值放在 title 里，避免榜单数字被极端项带偏。
 */
export const MOM_DISPLAY_CAP = 200;

/** 环比 % → 展示文本；超阈值截断为 "200%+" */
export function formatMom(value?: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value > MOM_DISPLAY_CAP) {
    /*
     * 超过 200% 后百分数已经读不出量级：cliputils 从 435 涨到 58,351
     * 是 +13,314%，写成「+13,314%」没人能一眼看懂，写成「↑133 倍」立刻有体感。
     * 涨幅不到 3 倍时仍用 200%+，因为「↑2 倍」这种精度反而更差。
     */
    const times = Math.round(value / 100);
    if (times >= 3) return `↑${times} 倍`;
    return `${MOM_DISPLAY_CAP}%+`;
  }
  return `${value > 0 ? "+" : ""}${value}%`;
}

/** 被截断时给出的真实值说明，供 title 使用 */
export function momCapHint(value?: number | null): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value <= MOM_DISPLAY_CAP) return undefined;
  return `上月基数偏小，实际环比 +${value.toLocaleString("en-US")}%`;
}

/** 数字缩写：5503 → 5.5K */
export function formatCount(value?: number | null): string {
  if (value === null || value === undefined) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/**
 * 完整数字（千分位）：19222 → 19,222。
 *
 * 指标卡不缩写：19.2K 看不出量级细节，而流量类数字（月访问、渠道访问量）
 * 本来就是读者要核对的原始值，K 只是把信息抹掉了一层。
 */
export function formatNum(value?: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString("en-US");
}