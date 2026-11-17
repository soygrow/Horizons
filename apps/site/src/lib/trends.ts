/**
 * 榜单数据的入口：静态 import 构建期产物，并派生「按 slug 查 / 名次表 / 相关词」。
 *
 * 这里唯一的重活是那 5MB JSON。凡是**不需要数据**的字典与计算都在 ./trends-meta，
 * SSR 页面（`/preview/trend/[slug]`）只引那个，避免把整份榜单打进 Worker bundle。
 * 二者用 `export *` 合流，所以老的 `from "../lib/trends"` 写法全部继续有效。
 */
import type {
  AITrend,
  EntryPolicy,
  TrendDataset,
  TrendStatus,
} from "@horizons/shared";
import trendsData from "@content/trends.json";
import {
  compareByOverall,
  daysSinceFrom,
  hasEnoughData,
  sortTrends,
  trendScore,
} from "./trends-meta";

export * from "./trends-meta";

const ds = trendsData as unknown as TrendDataset;

export const trendKeywords: AITrend[] = ds.keywords ?? [];
/** seed = 结构演示数据；live = 已接入真实采集 */
export const trendDataMode = ds.mode ?? "seed";
export const trendsUpdatedAt = ds.updatedAt ?? "";
export const trendRegion = ds.region ?? "US";
/** 榜单收录标准：会随每次审计演进，页面上直接展示当前版本 */
export const trendPolicy: EntryPolicy | null = ds.policy ?? null;

/* ------------------------------- 查询 ------------------------------- */

export function getTrendBySlug(slug: string): AITrend | undefined {
  return trendKeywords.find((t) => t.slug === slug);
}

let rankMapCache: Map<string, number> | null = null;

/** 全站名次表：slug → 名次（1 起）。数据不足的词不入表。 */
export function trendRankMap(): Map<string, number> {
  if (rankMapCache) return rankMapCache;
  const map = new Map<string, number>();
  let rank = 0;
  for (const t of [...trendKeywords].sort(compareByOverall)) {
    if (!hasEnoughData(t)) continue;
    map.set(t.slug, ++rank);
  }
  rankMapCache = map;
  return map;
}

/** 详情页用：名次，未参与排名返回 null */
export function trendRank(slug: string): number | null {
  return trendRankMap().get(slug) ?? null;
}

export function trendsByStatus(status: TrendStatus, limit?: number): AITrend[] {
  const list = sortTrends(
    trendKeywords.filter((t) => t.status === status),
    "trend",
  );
  return limit ? list.slice(0, limit) : list;
}

/** 同类别优先，其次按趋势分 */
export function getRelatedTrends(t: AITrend, limit = 4): AITrend[] {
  return [...trendKeywords]
    .filter((x) => x.slug !== t.slug)
    .sort((a, b) => {
      const ca = a.category === t.category ? 1 : 0;
      const cb = b.category === t.category ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return trendScore(b) - trendScore(a);
    })
    .slice(0, limit);
}

/** 首次发现距今多少天（以数据集快照时间为基准，避免构建期漂移） */
export function daysSince(dateStr: string): number | null {
  return daysSinceFrom(dateStr, trendsUpdatedAt);
}