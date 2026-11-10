/**
 * 趋势榜的评分与排位口径。
 *
 * 这套算法有三个使用者：静态站点（排序展示）、后台（发布前预览「谁的名次会变」）、
 * 发布脚本（真正合并时再算一遍）。三处各写一份的话，预览说升 3 名、发布却升 5 名，
 * 用户没法信任这个按钮。所以权重和排序逻辑只在这里定义一次。
 */
import type { AITrend } from "./types";

/** 趋势强度五项：增长 30 / 持续 25 / 爆发 20 / 新颖 15 / 可靠 10 */
export const TREND_WEIGHT_MAP = {
  growth: 0.3,
  persistence: 0.25,
  breakout: 0.2,
  novelty: 0.15,
  reliability: 0.1,
} as const;

/** 机会潜力五项：需求 30 / 切入 25 / SEO 20 / 可行 15 / 时机 10 */
export const OPP_WEIGHT_MAP = {
  demand: 0.3,
  wedge: 0.25,
  seo: 0.2,
  feasibility: 0.15,
  timing: 0.1,
} as const;

/** 综合分：趋势强度 60% + 机会潜力 40% */
export const OVERALL_WEIGHT_MAP = { trend: 0.6, opportunity: 0.4 } as const;

/** 名字次变动超过这个数才算「显著」，其余视为插入导致的顺延 */
export const SIGNIFICANT_DELTA = 3;
/** 前 N 名的任何变动都要提醒 */
export const TOP_N = 50;

/**
 * 榜单代表词上限（不含别名）。
 *
 * 榜单是「可发现性」资产，不是数据库：过了一千条，尾部既没人点也没人维护，
 * 还会拖慢构建。超出就按排位规则淘汰尾部，别名跟着代表词一起留或一起走。
 */
export const MAX_BOARD_SIZE = 1000;

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function trendScore(t: AITrend): number {
  const parts = t.trendParts as unknown as Record<string, number>;
  return round1(
    Object.entries(TREND_WEIGHT_MAP).reduce((s, [k, w]) => s + w * (parts[k] ?? 0), 0),
  );
}

export function opportunityScore(t: AITrend): number {
  const parts = t.oppParts as unknown as Record<string, number>;
  return round1(Object.entries(OPP_WEIGHT_MAP).reduce((s, [k, w]) => s + w * (parts[k] ?? 0), 0));
}

export function overallScore(t: AITrend): number {
  return round1(
    OVERALL_WEIGHT_MAP.trend * trendScore(t) +
      OVERALL_WEIGHT_MAP.opportunity * opportunityScore(t),
  );
}

/** 采样少于 14 个点不参与排名（数据不足，分数不可信）。前台体检与后台富化门槛共用这一处 */
export const MIN_SERIES_POINTS = 14;

export function hasEnoughTrendData(t: AITrend): boolean {
  return (t.series?.values?.length ?? 0) >= MIN_SERIES_POINTS;
}

/**
 * 排位所需的极简信息。
 *
 * 榜单文件是 5MB（每词带 200 天序列、证据、文案），后台预览不可能每次都把它拉下来解析。
 * 所以候选池里会附一份「当前榜单的计分快照」，只留这五个字段，
 * 300 多个词也就几十 KB，Worker 里现算现出。
 */
export interface TrendRankRow {
  slug: string;
  keyword: string;
  /** 趋势强度分，已 round1 */
  trend: number;
  /** 机会潜力分，已 round1 */
  opportunity: number;
  /** 数据点是否够 14 个 */
  enough: boolean;
  variantOf?: string;
}

export function toRankRow(t: AITrend): TrendRankRow {
  return {
    slug: t.slug,
    keyword: t.keyword,
    trend: trendScore(t),
    opportunity: opportunityScore(t),
    enough: hasEnoughTrendData(t),
    ...(t.variantOf ? { variantOf: t.variantOf } : {}),
  };
}

export function rowOverall(r: TrendRankRow): number {
  return round1(
    OVERALL_WEIGHT_MAP.trend * r.trend + OVERALL_WEIGHT_MAP.opportunity * r.opportunity,
  );
}

/**
 * 名次表。别名（variantOf）不占名次。
 * 排序规则：数据充足的在前 → 综合分降序 → 趋势分降序 → slug 字典序，
 * 与 scripts/build/artifacts.ts 的 orderedTrends 完全一致。
 */
export function rankRows(rows: TrendRankRow[]): Map<string, number> {
  const listed = rows.filter((r) => !r.variantOf);
  const ordered = [...listed].sort((a, b) => {
    const sa = a.enough ? rowOverall(a) : -1;
    const sb = b.enough ? rowOverall(b) : -1;
    if (sb !== sa) return sb - sa;
    if (sa >= 0 && b.trend !== a.trend) return b.trend - a.trend;
    return a.slug.localeCompare(b.slug);
  });
  return new Map(ordered.map((r, i) => [r.slug, i + 1]));
}

export function rankTrends(list: AITrend[]): Map<string, number> {
  return rankRows(list.map(toRankRow));
}

export interface TrendRankChange {
  slug: string;
  keyword: string;
  /** 发布前名次，null = 新进榜 */
  from: number | null;
  /** 发布后名次，null = 出榜 */
  to: number | null;
  /** 正数上升、负数下降；新进/出榜为 0 */
  delta: number;
  /**
   * 是否值得提醒用户。
   * 一次发布往往会牵动上百个词的位次（插入一个词，后面全部顺延一名），
   * 全部列出来等于没列。只把「涉及前 50」或「变动 >= 3 名」算作显著。
   */
  significant: boolean;
}

export interface TrendRankReport {
  boardBefore: number;
  boardAfter: number;
  entered: TrendRankChange[];
  exited: TrendRankChange[];
  ups: TrendRankChange[];
  downs: TrendRankChange[];
  /** 涉及前 TOP_N 的变动 */
  top: TrendRankChange[];
  /** 显著变动（前 50 或 >= SIGNIFICANT_DELTA 名） */
  significant: TrendRankChange[];
  /** 仅顺延、不值得提醒的条数 */
  shifted: number;
  changes: TrendRankChange[];
}

/** 对比两份榜单快照，算出每个词的位次变化 */
export function diffRankRows(before: TrendRankRow[], after: TrendRankRow[]): TrendRankReport {
  const beforeRanks = rankRows(before);
  const afterRanks = rankRows(after);
  const bySlug = new Map<string, TrendRankRow>();
  for (const t of before) bySlug.set(t.slug, t);
  for (const t of after) bySlug.set(t.slug, t);

  const changes: TrendRankChange[] = [];
  const push = (slug: string, from: number | null, to: number | null): void => {
    const t = bySlug.get(slug);
    const delta = from !== null && to !== null ? from - to : 0;
    const significant =
      from === null ||
      to === null ||
      (from <= TOP_N && from !== to) ||
      (to <= TOP_N && from !== to) ||
      Math.abs(delta) >= SIGNIFICANT_DELTA;
    changes.push({ slug, keyword: t?.keyword ?? slug, from, to, delta, significant });
  };

  for (const [slug, to] of afterRanks) {
    const from = beforeRanks.get(slug) ?? null;
    if (from !== to) push(slug, from, to);
  }
  for (const [slug, from] of beforeRanks) {
    if (!afterRanks.has(slug)) push(slug, from, null);
  }

  const entered = changes.filter((c) => c.from === null).sort((a, b) => (a.to ?? 0) - (b.to ?? 0));
  const exited = changes.filter((c) => c.to === null).sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  const ups = changes.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta);
  const downs = changes.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta);
  const top = changes.filter(
    (c) => (c.from !== null && c.from <= TOP_N) || (c.to !== null && c.to <= TOP_N),
  );
  const significant = changes.filter((c) => c.significant);

  return {
    boardBefore: beforeRanks.size,
    boardAfter: afterRanks.size,
    entered,
    exited,
    ups,
    downs,
    top,
    significant,
    shifted: changes.length - significant.length,
    changes,
  };
}

/** 便捷包装：直接拿完整词条算 */
export function diffTrendRanks(before: AITrend[], after: AITrend[]): TrendRankReport {
  return diffRankRows(before.map(toRankRow), after.map(toRankRow));
}

/**
 * 按排位规则把代表词压到上限以内。
 *
 * 别名（variantOf）不占名次，但不能单独判断去留：代表词被淘汰后，
 * 它的详情页和 canonical 链接就没了，所以别名必须跟着走。
 * 返回的 kept 保持原数组顺序（榜单文件的顺序不影响展示，站点自己会排）。
 */
export function trimBoard<T extends { slug: string; variantOf?: string }>(
  list: T[],
  rowOf: (t: T) => TrendRankRow,
  max: number = MAX_BOARD_SIZE,
): { kept: T[]; dropped: T[] } {
  const reps = list.filter((t) => !t.variantOf).length;
  if (reps <= max) return { kept: list, dropped: [] };

  const ranks = rankRows(list.map(rowOf));
  const keep = new Set<string>();
  for (const [slug, rank] of ranks) if (rank <= max) keep.add(slug);

  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of list) {
    const alive = t.variantOf ? keep.has(t.variantOf) : keep.has(t.slug);
    (alive ? kept : dropped).push(t);
  }
  return { kept, dropped };
}