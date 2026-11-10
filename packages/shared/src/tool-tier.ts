/**
 * AI 工具榜收录判定 —— 全仓库唯一实现。
 *
 * 这段逻辑此前散在 5 个文件里各自维护：
 *   apps/site/src/lib/data.ts
 *   apps/api/src/routes/admin-tools.ts
 *   scripts/admin/tool-stats.ts
 *   scripts/fetch/enrich.ts
 *   scripts/fetch/backfill-traffic.ts
 *
 * 其中 admin-tools.ts 那份漏了 isBlockedDomain 检查，导致后台显示「已收录」、
 * 站点却因为黑名单不上榜 —— 同一份数据两个口径。收拢到这里之后不会再漂。
 *
 * 判定顺序不可调整：黑名单 → 规模门槛 → 分层。
 */

import { isBlockedDomain } from "./blocklist";

/** 主榜门槛：月访问 ≥ 1 万直接进 */
export const MIN_VISITS_CORE = 10_000;
/** 观察区门槛：月访问 ≥ 1000，且环比为负才降级 */
export const MIN_VISITS_WATCH = 1_000;
/** 无月访问数据时，靠 Product Hunt 热度进观察区 */
export const WATCH_PH_UPVOTES = 300;

export type ToolTier = "core" | "watch";

/**
 * 最小输入结构。AITool 与后台从 D1 / 快照里解析出的宽松对象都满足它，
 * 因此不需要为每种来源准备不同签名。
 */
export interface TierInput {
  domain: string;
  /** 上游可能给 null（未采到），与 undefined 同义，别让调用方为此转一遍 */
  phUpvotes?: number | null;
  trafficMetrics?: { monthlyVisits?: number | null; monthlyVisitsGrowth?: number | null };
  metrics?: { monthlyVisits?: number | null; momGrowth?: number | null };
}

/** 月访问量：vortex（trafficMetrics）优先，回退 DFS（metrics）；null 归一成 undefined */
export function visitsOf(t: TierInput): number | undefined {
  return t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits ?? undefined;
}

/** 环比增长 %：vortex 优先，回退 DFS；null 归一成 undefined */
export function momOf(t: TierInput): number | undefined {
  return t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth ?? undefined;
}

/**
 * 分层判定，null 表示不收录。
 *
 * - 黑名单：A1/A2，永远不收录
 * - 无月访问：只能靠 PH 热度进观察区，不占主榜名次
 * - ≥ 1 万：进主榜
 * - 1000–1 万：环比为负则降级到观察区，否则进主榜
 *
 * 120 天新星窗口暂不校验（launchedAt 缺失率 23%，补齐后再启用）。
 */
export function tierOf(t: TierInput): ToolTier | null {
  if (isBlockedDomain(t.domain)) return null;

  const v = visitsOf(t);
  if (v === undefined) {
    return (t.phUpvotes ?? 0) >= WATCH_PH_UPVOTES ? "watch" : null;
  }
  if (v >= MIN_VISITS_CORE) return "core";
  if (v >= MIN_VISITS_WATCH) {
    const g = momOf(t);
    return typeof g === "number" && g < 0 ? "watch" : "core";
  }
  return null;
}

/** 是否进入榜单展示 */
export function isListed(t: TierInput): boolean {
  return tierOf(t) !== null;
}