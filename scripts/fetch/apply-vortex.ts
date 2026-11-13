/**
 * vortex `base_data` 原始响应 → 判定所需字段。
 *
 * 为什么单独一个文件：
 *
 *   1. 结构解析（月份名、数组/对象/数字三种形态）比字段映射更容易出错，
 *      单独放一处，改一次全局生效；
 *   2. 富化阶段（`enrich-site`）也要读同一份缓存，必须共用同一个解析器，
 *      否则「准入算出的月访问量」和「页面上显示的」可能对不上。
 *
 * 这里只产出一个快照对象，**不改 AITool 之外任何状态、不发请求**。
 */
import type { AITool } from "@horizons/shared";
import type { SimilarwebItem } from "../field-collect/apify";
import { monthKey, type TrafficMonth } from "./collect-store";

export interface VortexSnapshot {
  /** 快照所属月份 YYYY-MM（取自 period 或最近一个有值的月份） */
  period: string;
  /** 当月访问量：优先 totalVisits，其次月度序列里最新一个月 */
  monthlyVisits?: number;
  /** 月度序列，按月份升序；用于写 traffic_history */
  months: TrafficMonth[];
  rankGlobal?: number;
  countryRank?: number;
  country?: string;
  category?: string;
  categoryRank?: number;
  /** Similarweb 自评数据覆盖度："full" | "partial" */
  dataCoverage?: string;
  /** Similarweb 自评小站 */
  isSmall?: boolean;
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * 月份标签 → 'YYYY-MM'。
 *
 * vortex 的 `monthlyVisits` 在不同版本里给过四种写法，实测都出现过：
 *   "August 2026" / "Aug 2026" / "2026-08" / "2026-08-01"
 * 解析不出来就返回空串，由调用方丢弃该月 —— 宁可少一个月，也不要写错月份。
 */
export function parseMonthLabel(label: unknown): string {
  const s = String(label ?? "").trim();
  if (!s) return "";

  // 2026-08 / 2026-08-01
  const iso = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (iso) {
    const m = Number(iso[2]);
    if (m >= 1 && m <= 12) return `${iso[1]}-${String(m).padStart(2, "0")}`;
    return "";
  }

  // August 2026 / Aug 2026 / August, 2026
  const named = /^([A-Za-z]+)[,\s]+(\d{4})$/.exec(s);
  if (named) {
    const idx = MONTH_NAMES.findIndex((n) => n.startsWith(named[1].toLowerCase().slice(0, 3)));
    if (idx >= 0) return `${named[2]}-${String(idx + 1).padStart(2, "0")}`;
  }

  return "";
}

/**
 * 解析 `monthlyVisits`。
 *
 * 兼容四种形态（vortex 换过一次结构，老缓存里还有旧形态）：
 *   [{ month: "August 2026", visits: 320 }]
 *   [{ "August 2026": 320 }]
 *   { "August 2026": 320 }
 *   58351
 * 数字形态没有月份信息，返回空数组，由 `parseVortexBase` 用 period 兜底。
 */
export function parseMonthlyVisits(raw: unknown): TrafficMonth[] {
  const out = new Map<string, number>();

  const push = (label: unknown, value: unknown) => {
    const month = parseMonthLabel(label);
    const visits = typeof value === "number" ? value : Number(value);
    if (!month || !Number.isFinite(visits) || visits <= 0) return;
    // 同月重复时保留较大值：vortex 偶尔同时给「估算值」和「精确值」
    out.set(month, Math.max(out.get(month) ?? 0, visits));
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const obj = entry as Record<string, unknown>;
      if ("month" in obj || "visits" in obj) {
        push(obj.month, obj.visits);
        continue;
      }
      for (const [k, v] of Object.entries(obj)) push(k, v);
    }
  } else if (raw !== null && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) push(k, v);
  }

  return [...out.entries()]
    .map(([month, visits]) => ({ month, visits }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** 环比：最后两个月都 >0 时才算；上月为 0 无法算增长率，返回 undefined */
export function momGrowthOf(months: readonly TrafficMonth[]): number | undefined {
  if (months.length < 2) return undefined;
  const last = months[months.length - 1];
  const prev = months[months.length - 2];
  if (!prev.visits || prev.visits <= 0) return undefined;
  return Math.round(((last.visits - prev.visits) / prev.visits) * 1000) / 10;
}

/**
 * `base_data` 原始项 → 快照。
 *
 * `period` 由调用方传当前快照月份：月度序列里最新月份可能与 period 不一致
 * （3 号前后拿到的还是上月数据），此时以 period 为准写 collect_raw，
 * 但 traffic_history 照写序列里的真实月份。
 */
export function parseVortexBase(item: SimilarwebItem, period: string): VortexSnapshot {
  const months = parseMonthlyVisits(item.monthlyVisits);
  const latest = months.length ? months[months.length - 1].visits : undefined;
  const total = typeof item.totalVisits === "number" && item.totalVisits > 0 ? item.totalVisits : undefined;

  // 当月值优先 totalVisits；两者都在但不一致时以 totalVisits 为准 ——
  // 它是 vortex 的顶层字段，月度序列里那个数是画图用的。
  const monthlyVisits = total ?? latest;

  // totalVisits 与序列最新月对不上时，用 totalVisits 校正最后一个月，
  // 否则图表末端会和 01 第 1 格显示两个数。
  const normalized =
    total && months.length && months[months.length - 1].visits !== total
      ? [...months.slice(0, -1), { month: months[months.length - 1].month, visits: total }]
      : months;

  return {
    period: period || (normalized.length ? normalized[normalized.length - 1].month : ""),
    monthlyVisits,
    months: normalized,
    rankGlobal: item.rankGlobal,
    countryRank: item.countryRank,
    country: item.country,
    category: item.category || undefined,
    categoryRank: item.categoryRank,
    dataCoverage: item.dataCoverage,
    isSmall: item.isSmall,
  };
}

/**
 * 把判定必需字段写回 AITool。
 *
 * 只写 `metrics.monthlyVisits` / `momGrowth` / `trafficMetrics` 的空位，
 * 不碰其余字段：完整映射在富化阶段（apply-fields）统一做，
 * 这里多写一处就多一处口径分叉的机会。
 */
export function applyVortexAdmission(tool: AITool, snap: VortexSnapshot): void {
  if (snap.monthlyVisits === undefined) return;

  const growth = momGrowthOf(snap.months);
  tool.metrics = {
    ...(tool.metrics ?? {}),
    monthlyVisits: snap.monthlyVisits,
    ...(growth !== undefined ? { momGrowth: growth } : {}),
  };

  // visitsOf() 优先读 trafficMetrics，所以这里必须同步写，
  // 否则库里残留的旧 trafficMetrics 会盖掉刚采到的新值。
  tool.trafficMetrics = {
    ...(tool.trafficMetrics ?? {}),
    monthlyVisits: snap.monthlyVisits,
    ...(growth !== undefined ? { monthlyVisitsGrowth: growth } : {}),
    ...(snap.period ? { snapshotMonth: snap.period } : {}),
  };
}

/** 快照日期字符串，写 traffic_history.snapshot_date 用 */
export function snapshotDateOf(now: Date = new Date()): string {
  return `${monthKey(now)}-${String(now.getUTCDate()).padStart(2, "0")}`;
}