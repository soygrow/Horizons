import type { AITool, ChannelKey, TrafficMetrics, TrafficTrendPoint } from "@horizons/shared";
import type { SimilarwebRawItem } from "./sources/apify";

/**
 * 把 SimilarWeb 抓取结果写回工具对象。
 * 单站脚本（fetch-apify.ts）与批量补齐脚本（backfill-traffic.ts）共用，
 * 避免两处映射逻辑漂移。
 */

/** lergassy Actor 的 source 取值 → 站点渠道枚举 */
const CHANNEL_MAP: Record<string, ChannelKey> = {
  direct: "direct",
  organic: "organicSearch",
  paid: "paidSearch",
  referrals: "referral",
  social_organic: "organicSocial",
  social_paid: "paidSocial",
  mail: "email",
  affiliate: "affiliates",
  display_ads: "displayAds",
  gen_ai: "aiAssistants",
};

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** "US" → "United States"；无效代码原样返回 */
function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** 统一为「最近 6 个自然月」：以最大月为基准往前数 6 个月，缺失月份补 0 */
export function last6Months(trend: TrafficTrendPoint[]): TrafficTrendPoint[] {
  if (trend.length === 0) return [];
  const sorted = [...trend].sort((a, b) => (a.date < b.date ? -1 : 1));
  const [ly, lm] = sorted[sorted.length - 1].date.split("-").map(Number);
  const months: string[] = [];
  let y = ly;
  let m = lm;
  for (let i = 0; i < 6; i++) {
    months.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const byDate = new Map(sorted.map((t) => [t.date, t]));
  return months.map((d) => byDate.get(d) ?? { date: d, total: 0, organic: 0 });
}

/**
 * 写入 8 指标 + 渠道 / 国家 / 排名 / 趋势。
 * metrics 缺失月访问量时由调用方决定是否跳过。
 */
export function applyTraffic(tool: AITool, raw: SimilarwebRawItem | null, metrics: TrafficMetrics): void {
  tool.trafficMetrics = metrics;

  // 核心指标与流量源对齐：月访问量 / 自然搜索 / 环比同源，
  // 避免 enrich-site 写入的 DFS「搜索流量」口径与总访问量混在一张卡上
  tool.metrics = {
    ...(tool.metrics ?? {}),
    monthlyVisits: metrics.monthlyVisits,
    organicVisits: metrics.organicSearchVisits,
    organicShare:
      metrics.monthlyVisits && metrics.organicSearchVisits
        ? Math.round((metrics.organicSearchVisits / metrics.monthlyVisits) * 1000) / 10
        : undefined,
    directVisits: metrics.directVisits,
    momGrowth: metrics.monthlyVisitsGrowth,
  };

  if (!raw) return;

  const organicShare =
    metrics.monthlyVisits && metrics.organicSearchVisits
      ? metrics.organicSearchVisits / metrics.monthlyVisits
      : 0;

  const channelShares: Partial<Record<ChannelKey, number>> = {};
  for (const t of raw.trafficSources ?? []) {
    const key = CHANNEL_MAP[t.source ?? ""];
    if (key && typeof t.share === "number") channelShares[key] = Math.round(t.share * 1000) / 10;
  }
  if (Object.keys(channelShares).length) tool.channelShares = channelShares;

  if (raw.topCountries?.length) {
    const geo = raw.topCountries
      .filter((c) => c.countryCode && c.share != null)
      .map((c) => ({ country: countryName(c.countryCode!), share: Math.round((c.share as number) * 1000) / 10 }));
    if (geo.length) tool.geoDistribution = geo;
  }

  if (raw.globalRank || raw.countryRank) {
    tool.ranks = { global: raw.globalRank, country: raw.countryRank };
  }

  // 竞品：Similarweb similarSites（受众重叠站）替代 DFS ranked_keywords 的竞品口径。
  // 只在原值为空时写入，不覆盖已由 DFS 采到的竞品，避免同一字段两种口径混用。
  if (!tool.observations?.competitors?.length && raw.similarSites?.length) {
    const self = tool.domain.toLowerCase();
    const domains = raw.similarSites
      .map((s) => s.domain?.toLowerCase().trim())
      .filter((d): d is string => !!d && d !== self);
    const uniq = [...new Set(domains)].slice(0, 8);
    if (uniq.length) {
      tool.observations = { ...(tool.observations ?? {}), competitors: uniq };
    }
  }

  // 趋势：Actor 自带分月历史，直接取真实序列，不再用占比反推
  const rawTrend: TrafficTrendPoint[] = (raw.monthlyVisitsHistory ?? [])
    .map((m) => {
      const date = m.month ? m.month.slice(0, 7) : undefined;
      if (!date) return null;
      const total = m.visits ?? 0;
      return {
        date,
        total,
        organic: total > 0 && organicShare > 0 ? Math.round(total * organicShare) : 0,
      };
    })
    .filter((t): t is TrafficTrendPoint => t !== null);

  const trend = last6Months(rawTrend);
  if (trend.length >= 2) tool.trend = trend;
  else if (metrics.monthlyVisits && metrics.snapshotMonth) {
    // 无分月明细时，至少保留一个真实月份的点，不编造历史
    tool.trend = [
      {
        date: metrics.snapshotMonth,
        total: metrics.monthlyVisits,
        organic: metrics.organicSearchVisits ?? 0,
      },
    ];
  }
}