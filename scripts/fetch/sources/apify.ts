/**
 * Apify Similarweb 流量数据源（主备双 Actor 策略）。
 * 主：pintostudio/similarweb-scraper-v2；备：lergassy/similarweb-traffic-scraper。
 * 获取「产品表现」8 指标；低流量站渠道份额 null 时兜底为 0。
 */
import { config } from "../config";
import { hasDataForSEO, fetchOrganicSearchETV } from "./dataforseo";

/* ------------------------------- 原始类型 ------------------------------- */

/** 主 Actor：pintostudio/similarweb-scraper-v2 */
export interface SimilarwebV2Item {
  EstimatedMonthlyVisits?: { monthly?: number; change?: number } | { monthly?: number; change?: number }[];
  TrafficSources?: Record<string, number | null>;
  Engagments?: { PagePerVisit?: number; AvgVisitDuration?: string | null; BounceRate?: number };
  GlobalRank?: number;
  CountryRank?: number;
  Domain?: string;
  SnapshotMonth?: string;
}

/** 备选 Actor：lergassy/similarweb-traffic-scraper */
export interface SimilarwebRawItem {
  type?: string;
  notice?: string;
  domain?: string;
  url?: string;
  snapshotMonth?: string;
  monthlyVisits?: number;
  monthlyVisitsChange?: number;
  pagesPerVisit?: number;
  avgVisitDuration?: string | null;
  avgVisitDurationSeconds?: number | null;
  bounceRate?: number;
  globalRank?: number;
  countryRank?: number;
  trafficSources?: { source?: string; rank?: number | null; share?: number | null }[];
  topCountries?: { countryCode?: string; share?: number | null }[];
  topKeywords?: { keyword?: string; cpc?: number | null; volume?: number | null }[];
  similarSites?: string[];
  technologies?: { category?: string; topTechnology?: string; count?: number }[];
  organicSearchShare?: number;
  paidSearchShare?: number;
  keywordsTotal?: number;
}

/* ------------------------------- 指标类型 ------------------------------- */

/** 主 Actor：vortex_data/similarweb-scraper（字段最全，渠道份额为顶层 0-1 小数） */
export interface VortexItem {
  domain?: string;
  url?: string;
  totalVisits?: number;
  directTraffic?: number;        // 直接访问份额
  searchTraffic?: number;        // 搜索总份额
  searchOrganicTraffic?: number; // 自然搜索份额
  searchPaidTraffic?: number;    // 付费搜索份额
  referralTraffic?: number;      // 引荐份额
  socialTraffic?: number;        // 社媒总份额
  socialOrganicTraffic?: number;
  socialPaidTraffic?: number;
  displayAdsTraffic?: number;
  mailTraffic?: number;
  genAiTraffic?: number;
  pagesPerVisit?: number;
  timeOnSite?: number;           // 秒；0 表示低流量站未采集
  bounceRate?: number;
  monthlyVisits?: { month?: string; visits?: number }[];
  rankGlobal?: number;
  countryRank?: number;
  topKeywords?: { keyword?: string; searchVolume?: number; cpc?: number | null; estimatedValue?: number }[];
  website_traffic_by_country?: { country?: string; countryName?: string; share?: number }[];
  snapshotDate?: string;
  title?: string;
  description?: string;
}

export interface TrafficMetrics {
  monthlyVisits?: number;
  monthlyVisitsGrowth?: number;
  organicSearchVisits?: number;
  directVisits?: number;
  referralVisits?: number;
  socialVisits?: number;
  monthlyPageviews?: number;
  avgVisitDurationSec?: number;
  snapshotMonth?: string;
  actor?: string;
}

export function hasApify(): boolean {
  return !!process.env.APIFY_TOKEN;
}

/* ------------------------------- 工具函数 ------------------------------- */

function shareToVisits(visits: number, share: number | null | undefined): number | undefined {
  if (visits <= 0) return undefined;
  if (share == null) return 0; // null 兜底为 0（低流量站该渠道趋近 0）
  return Math.round(visits * share);
}

function parseDuration(d: string | null | undefined): number | undefined {
  if (!d) return undefined;
  const parts = d.split(":").map((x) => parseInt(x, 10));
  if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return undefined;
}

/** 增长率统一转百分数：0.0955→9.6，60.83→60.8 */
function normalizeGrowth(change: number | null | undefined): number | undefined {
  if (change == null) return undefined;
  const pct = Math.abs(change) <= 1 ? change * 100 : change;
  return Math.round(pct * 10) / 10;
}

/* ------------------------------- 提取逻辑 ------------------------------- */

export function extractV2(item: SimilarwebV2Item): TrafficMetrics {
  const emv = Array.isArray(item.EstimatedMonthlyVisits)
    ? item.EstimatedMonthlyVisits[0]
    : item.EstimatedMonthlyVisits;
  const visits = emv?.monthly ?? 0;
  const sources = item.TrafficSources ?? {};
  const eng = item.Engagments ?? {};

  return {
    monthlyVisits: visits > 0 ? visits : undefined,
    monthlyVisitsGrowth: normalizeGrowth(emv?.change),
    organicSearchVisits: shareToVisits(visits, sources["Organic Search"]),
    directVisits: shareToVisits(visits, sources["Direct"]),
    referralVisits: shareToVisits(visits, sources["Referrals"]),
    socialVisits: shareToVisits(visits, sources["Social"]),
    monthlyPageviews: eng.PagePerVisit != null && visits > 0 ? Math.round(visits * eng.PagePerVisit) : undefined,
    avgVisitDurationSec: parseDuration(eng.AvgVisitDuration),
    snapshotMonth: item.SnapshotMonth,
    actor: "pintostudio/similarweb-scraper-v2",
  };
}

export function extractTrafficMetrics(item: SimilarwebRawItem): TrafficMetrics {
  const visits = item.monthlyVisits ?? 0;
  const shareOf = (source: string): number | null | undefined =>
    item.trafficSources?.find((t) => t.source === source)?.share;
  // 该 actor 只给变化率、无分月明细：0 无法区分「真零增长」与「上月无数据」，
  // 按用户规则一律视为无数据（页面显示 n/a），避免把无基数写成 0%
  const change = item.monthlyVisitsChange;

  return {
    monthlyVisits: visits > 0 ? visits : undefined,
    monthlyVisitsGrowth: change === 0 ? undefined : normalizeGrowth(change),
    organicSearchVisits: shareToVisits(visits, shareOf("organic")),
    directVisits: shareToVisits(visits, shareOf("direct")),
    referralVisits: shareToVisits(visits, shareOf("referrals")),
    socialVisits: shareToVisits(visits, shareOf("social_organic")),
    monthlyPageviews: item.pagesPerVisit != null && visits > 0 ? Math.round(visits * item.pagesPerVisit) : undefined,
    avgVisitDurationSec: item.avgVisitDurationSeconds ?? undefined,
    snapshotMonth: item.snapshotMonth,
    actor: "lergassy/similarweb-traffic-scraper",
  };
}

/* ------------------------------- 获取逻辑 ------------------------------- */

/** 主 Actor（同步端点） */
async function fetchV2(domain: string): Promise<SimilarwebV2Item | null> {
  const token = process.env.APIFY_TOKEN!;
  const url = `https://api.apify.com/v2/acts/pintostudio~similarweb-scraper-v2/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify({ url: `https://${domain}` }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as SimilarwebV2Item[] | SimilarwebV2Item | { error?: unknown };
    if (Array.isArray(data)) return data[0] ?? null;
    if ((data as { error?: unknown }).error) return null;
    return (data as SimilarwebV2Item) ?? null;
  } catch {
    return null;
  }
}

/** 备选 Actor（异步 run + 轮询 + 取 dataset） */
async function fetchLergassy(domain: string): Promise<SimilarwebRawItem | null> {
  const token = process.env.APIFY_TOKEN!;
  const ACTOR = "lergassy~similarweb-traffic-scraper";
  const base = "https://api.apify.com/v2";

  try {
    const runRes = await fetch(`${base}/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify({ websites: [domain] }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!runRes.ok) return null;
    const runData = (await runRes.json()) as { data?: { id?: string } };
    const runId = runData.data?.id;
    if (!runId) return null;

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const stRes = await fetch(`${base}/actor-runs/${runId}?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(30_000),
      });
      const st = (await stRes.json()) as { data?: { status?: string } };
      const status = st.data?.status;
      if (status === "SUCCEEDED") break;
      if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") return null;
    }

    const dsRes = await fetch(`${base}/actor-runs/${runId}/dataset/items?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const items = (await dsRes.json()) as SimilarwebRawItem[];
    return (
      items.find((i) => i.type !== "notice" && i.domain === domain) ??
      items.find((i) => i.type !== "notice" && (i.monthlyVisits ?? 0) > 0) ??
      null
    );
  } catch {
    return null;
  }
}

/** 主 Actor：vortex_data/similarweb-scraper（字段最全，渠道份额为顶层 0-1 小数） */
export async function fetchVortex(domain: string): Promise<VortexItem | null> {
  const token = process.env.APIFY_TOKEN!;
  const url = `https://api.apify.com/v2/acts/vortex_data~similarweb-scraper/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify({ domains: [domain] }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as VortexItem[] | { error?: unknown };
    if (!Array.isArray(data)) return null;
    return data.find((i) => i.domain === domain || i.totalVisits) ?? data[0] ?? null;
  } catch {
    return null;
  }
}

/** 从 vortex 条目提取 8 指标；增长率由 monthlyVisits 历史自算 */
export function extractVortex(item: VortexItem): TrafficMetrics {
  const visits = item.totalVisits ?? 0;

  // 增长率：从 monthlyVisits 历史最后两个月自算
  let growth: number | undefined;
  const hist = (item.monthlyVisits ?? []).filter((m) => (m.visits ?? 0) > 0);
  if (hist.length >= 2) {
    const prev = hist[hist.length - 2].visits ?? 0;
    const last = hist[hist.length - 1].visits ?? 0;
    if (prev > 0) growth = Math.round(((last - prev) / prev) * 1000) / 10;
  }

  const snap = item.snapshotDate?.slice(0, 7);

  return {
    monthlyVisits: visits > 0 ? visits : undefined,
    monthlyVisitsGrowth: growth,
    organicSearchVisits: shareToVisits(visits, item.searchOrganicTraffic),
    directVisits: shareToVisits(visits, item.directTraffic),
    referralVisits: shareToVisits(visits, item.referralTraffic),
    socialVisits: shareToVisits(visits, item.socialTraffic),
    monthlyPageviews: item.pagesPerVisit != null && visits > 0 ? Math.round(visits * item.pagesPerVisit) : undefined,
    avgVisitDurationSec: item.timeOnSite && item.timeOnSite > 0 ? item.timeOnSite : undefined,
    snapshotMonth: snap,
    actor: "vortex_data/similarweb-scraper",
  };
}

/**
 * Apify Actor：datascraperes/bulk-domain-rating-checker
 * 取 Ahrefs Domain Rating（域名权重，0~100），作为「域名权重」主口径。
 * 输入 targets 需为完整 URL 字符串，输出 { target, domainRating, fetchedAt }。
 */
export interface DomainRatingItem {
  target?: string;
  domainRating?: number;
  fetchedAt?: string;
}

export async function fetchDomainRating(domain: string): Promise<number | null> {
  const token = process.env.APIFY_TOKEN!;
  const ACTOR = "datascraperes~bulk-domain-rating-checker";
  const base = "https://api.apify.com/v2";
  const body = { targets: [`https://${domain}`] };

  // 1) 同步端点
  try {
    const res = await fetch(`${base}/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (res.ok) {
      const arr = (await res.json()) as DomainRatingItem[];
      const it = arr.find((x) => x.target?.includes(domain));
      if (it && typeof it.domainRating === "number") return it.domainRating;
    }
  } catch {
    /* fallthrough to async */
  }

  // 2) 异步 run + 轮询（同步端点偶发超时）
  try {
    const runRes = await fetch(`${base}/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!runRes.ok) return null;
    const runData = (await runRes.json()) as { data?: { id?: string } };
    const runId = runData.data?.id;
    if (!runId) return null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const st = (await (await fetch(`${base}/actor-runs/${runId}?token=${encodeURIComponent(token)}`)).json()) as {
        data?: { status?: string };
      };
      const s = st.data?.status;
      if (s === "SUCCEEDED") break;
      if (s === "FAILED" || s === "ABORTED" || s === "TIMED-OUT") return null;
    }
    const items = (await (await fetch(`${base}/actor-runs/${runId}/dataset/items?token=${encodeURIComponent(token)}`)).json()) as DomainRatingItem[];
    const it = items.find((x) => x.target?.includes(domain));
    if (it && typeof it.domainRating === "number") return it.domainRating;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 主入口：vortex（字段最全）→ lergassy 备选 → DataForSEO 自然搜索兜底。
 * 自然搜索份额 Apify 拿不到时，用 DataForSEO domain_rank_overview 的 organic.etv 补齐。
 */
export async function fetchTrafficMetrics(
  domain: string,
  /** 调用方已拿到的 vortex 结果，传 undefined 才会真正发起 actor 调用（避免同一域名跑两次） */
  preloaded?: VortexItem | null,
): Promise<TrafficMetrics | null> {
  let m: TrafficMetrics | null = null;

  // 1. 主 Actor：vortex_data（完整渠道份额）
  const v = preloaded !== undefined ? preloaded : await fetchVortex(domain);
  if (v) m = extractVortex(v);

  // 2. 备选：lergassy（若 vortex 无有效月访问量）
  if (!m?.monthlyVisits) {
    const fb = await fetchLergassy(domain);
    if (fb) m = extractTrafficMetrics(fb);
  }

  // 3. 自然搜索兜底：Apify 份额缺失（0/undefined）时用 DataForSEO organic.etv
  if (m && !m.organicSearchVisits && hasDataForSEO()) {
    try {
      const etv = await fetchOrganicSearchETV(domain);
      if (etv) m = { ...m, organicSearchVisits: etv };
    } catch {
      /* ignore */
    }
  }

  return m?.monthlyVisits ? m : null;
}
