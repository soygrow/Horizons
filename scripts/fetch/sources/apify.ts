/**
 * Apify 平台上的第三方 Similarweb 抓取 Actor（非 Similarweb 官方 API，按结果计费）。
 * 主：vortex_data/similarweb-scraper；备：lergassy/similarweb-traffic-scraper。
 * 获取「产品表现」8 指标；低流量站渠道份额 null 时兜底为 0。
 */
import { createHash } from "node:crypto";
import type { KeywordItem } from "@horizons/shared";
import { config } from "../config";
import { cachedCall } from "../api-cache";

/** Apify 按次计费近似单价（付费 Actor 每次查询），仅用于台账估算，不影响业务逻辑 */
const APIFY_COST_PER_DOMAIN = 0.0028;

/* ------------------------------- 原始类型 ------------------------------- */

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
  similarSites?: { domain?: string; category?: string; categoryRank?: number; affinity?: number }[];
  technologies?: { category?: string; topTechnology?: string; count?: number }[];
  organicSearchShare?: number;
  paidSearchShare?: number;
  keywordsTotal?: number;
  /** 分月总访问量历史（lergassy 提供，用于还原真实趋势） */
  monthlyVisitsHistory?: { month?: string; visits?: number }[];
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
  // 数据源没给该渠道份额（null）说明「未采集」，不是「访问量为 0」。
  // 兜底成 0 会把 399K 访问的站显示成「直接访问量 0」，误导性极强。
  if (share == null) return undefined;
  return Math.round(visits * share);
}



/** 增长率统一转百分数：0.0955→9.6，60.83→60.8 */
function normalizeGrowth(change: number | null | undefined): number | undefined {
  if (change == null) return undefined;
  const pct = Math.abs(change) <= 1 ? change * 100 : change;
  return Math.round(pct * 10) / 10;
}

/* ------------------------------- 提取逻辑 ------------------------------- */



export function extractTrafficMetrics(item: SimilarwebRawItem): TrafficMetrics {
  const visits = item.monthlyVisits ?? 0;
  const shareOf = (source: string): number | null | undefined =>
    item.trafficSources?.find((t) => t.source === source)?.share;
  // 该 actor 只给变化率、无分月明细：0 无法区分「真零增长」与「上月无数据」，
  // 按用户规则一律视为无数据（页面显示 n/a），避免把无基数写成 0%
  const change = item.monthlyVisitsChange;

  const shares = {
    organic: shareOf("organic"),
    direct: shareOf("direct"),
    referrals: shareOf("referrals"),
    social: shareOf("social_organic"),
  };
  // 该 Actor 只给「份额最大渠道」的真实值，其余渠道返回 0 或 null。
  // 份额总和明显不足 100% 时说明数据不完整，此时的 0 不能当作「真 0 访问」——
  // 否则会出现「15.6M 直接访问 + 自然搜索占比 0%」这种自相矛盾的展示。
  const shareSum = Object.values(shares).reduce<number>((a, s) => a + (s ?? 0), 0);
  const incomplete = visits > 0 && shareSum < 0.95;
  const toVisits = (share: number | null | undefined) => {
    const v = shareToVisits(visits, share);
    return v === 0 && incomplete ? undefined : v;
  };

  return {
    monthlyVisits: visits > 0 ? visits : undefined,
    monthlyVisitsGrowth: change === 0 ? undefined : normalizeGrowth(change),
    organicSearchVisits: toVisits(shares.organic),
    directVisits: toVisits(shares.direct),
    referralVisits: toVisits(shares.referrals),
    socialVisits: toVisits(shares.social),
    monthlyPageviews: item.pagesPerVisit != null && visits > 0 ? Math.round(visits * item.pagesPerVisit) : undefined,
    avgVisitDurationSec: item.avgVisitDurationSeconds ?? undefined,
    snapshotMonth: item.snapshotMonth,
    actor: "lergassy/similarweb-traffic-scraper",
  };
}

/* ------------------------------- 获取逻辑 ------------------------------- */



/**
 * 备选 Actor（异步 run + 轮询 + 取 dataset），经缓存。
 * 2026-10 实测：这是当前唯一可用的 SimilarWeb 数据源，且不产生 Apify 费用。
 */
export async function fetchLergassy(domain: string): Promise<SimilarwebRawItem | null> {
  return cachedCall(
    {
      provider: "apify",
      endpoint: "lergassy/similarweb-traffic-scraper",
      key: domain,
      costUsd: 0, // 实测该 Actor 不产生费用（usd=0），台账按 0 记
      ttlDays: 30,
      cacheNull: false, // 免费源：超时/抖动不固化成「无数据」
    },
    () => fetchLergassyRaw(domain),
  );
}

async function runLergassyBatch(websites: string[]): Promise<SimilarwebRawItem[]> {
  const token = process.env.APIFY_TOKEN!;
  const ACTOR = "lergassy~similarweb-traffic-scraper";
  const base = "https://api.apify.com/v2";

  const runRes = await fetch(`${base}/acts/${ACTOR}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
    body: JSON.stringify({ websites }),
    signal: AbortSignal.timeout(60_000),
  });
  // 请求失败必须抛错：调用方需区分「网络/平台故障」与「真的查不到」，
  // 否则一次网络抖动会把整批站写成「无数据」并永久跳过
  if (!runRes.ok) throw new Error(`lergassy 启动失败 HTTP ${runRes.status}`);
  const runId = ((await runRes.json()) as { data?: { id?: string } }).data?.id;
  if (!runId) throw new Error("lergassy 未返回 runId");

  // 实测单站 run 需 40~90s，批量更多域名会更久，上限给到 8 分钟
  const deadline = Date.now() + 480_000;
  let status = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const stRes = await fetch(`${base}/actor-runs/${runId}?token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(30_000),
    });
    status = ((await stRes.json()) as { data?: { status?: string } }).data?.status ?? "";
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      throw new Error(`lergassy run 失败：${status}`);
    }
  }
  if (status !== "SUCCEEDED") throw new Error(`lergassy run 超时：${status || "unknown"}`);

  const dsRes = await fetch(`${base}/actor-runs/${runId}/dataset/items?token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(60_000),
  });
  return (await dsRes.json()) as SimilarwebRawItem[];
}

async function fetchLergassyRaw(domain: string): Promise<SimilarwebRawItem | null> {
  try {
    const items = await runLergassyBatch([domain]);
    return (
      items.find((i) => i.type !== "notice" && i.domain === domain) ??
      items.find((i) => i.type !== "notice" && (i.monthlyVisits ?? 0) > 0) ??
      null
    );
  } catch {
    return null;
  }
}

/**
 * 单次 run 可容纳的域名数量。
 * 实测 25 个遇到拥堵时会超过 5 分钟被判定超时，12 个稳定在 60~90s，整体更省时间。
 */
const LERGASSY_BATCH = 12;

/**
 * 批量查询月访问量：一次 run 查多个域名，把「N × 42s」压到「N/25 × 90s」。
 * 仅用于初筛与批量补齐，不写单域缓存；需要进入长期缓存的数据走 fetchLergassy。
 */
export async function fetchLergassyMulti(
  domains: string[],
): Promise<Map<string, SimilarwebRawItem | null | undefined>> {
  const out = new Map<string, SimilarwebRawItem | null | undefined>();
  for (let i = 0; i < domains.length; i += LERGASSY_BATCH) {
    const chunk = domains.slice(i, i + LERGASSY_BATCH);
    // 网络抖动常见（undici 对解析出的多个 IP 依次尝试，全部超时才失败），重试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const items = await runLergassyBatch(chunk);
        const byDomain = new Map<string, SimilarwebRawItem>();
        for (const it of items) {
          if (it.type !== "notice" && it.domain) byDomain.set(it.domain.toLowerCase(), it);
        }
        // null 表示平台确实没有该站数据
        for (const d of chunk) out.set(d, byDomain.get(d.toLowerCase()) ?? null);
        break;
      } catch (e) {
        const msg = (e as Error).message;
        if (attempt === 3) {
          // undefined 表示网络/平台故障，调用方不得据此判定「无数据」
          console.warn(`[apify] 批次放弃（${chunk.length} 个域名）：${msg}`);
          for (const d of chunk) out.set(d, undefined);
        } else {
          console.warn(`[apify] 第 ${attempt} 次失败，5s 后重试：${msg}`);
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
    }
  }
  return out;
}

/**
 * 主 Actor：vortex_data/similarweb-scraper（字段最全，渠道份额为顶层 0-1 小数）。
 * 经缓存：30 天内同一域名不再真实调用（SimilarWeb 本身按月更新）。
 */
export async function fetchVortex(domain: string): Promise<VortexItem | null> {
  return cachedCall(
    {
      provider: "apify",
      endpoint: "vortex_data/similarweb-scraper",
      key: domain,
      costUsd: APIFY_COST_PER_DOMAIN,
      ttlDays: 30,
    },
    () => fetchVortexRaw(domain),
  );
}

async function fetchVortexRaw(domain: string): Promise<VortexItem | null> {
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

/**
 * 从 Similarweb 条目提取关键词（含搜索量）。
 *
 * 两口径字段不同：lergassy 用 { keyword, volume, cpc }，
 * vortex 用 { keyword, searchVolume, cpc, estimatedValue }，此处统一成 KeywordItem。
 * 只保留有搜索量的词：无 volume 的词（如站点自身的长尾乱码）没有展示价值，
 * 这也是详情页关键词表格的渲染前提（见 TrafficSection.astro）。
 */
export function extractSimilarwebKeywords(
  item: SimilarwebRawItem | VortexItem,
): KeywordItem[] {
  const raw = item.topKeywords ?? [];
  const seen = new Set<string>();
  const out: KeywordItem[] = [];

  for (const k of raw) {
    const term = (k.keyword ?? "").trim();
    if (!term || seen.has(term)) continue;
    // 两种口径同一份数据里可能混着出现，两个字段都取，别用 `in` 窄化 ——
    // 交叉联合类型下 TS 窄不到那一支，取值逻辑本身也不该依赖类型窄化。
    const kv = k as { volume?: number; searchVolume?: number };
    const volume = kv.searchVolume ?? kv.volume;
    if (volume == null || volume <= 0) continue;
    seen.add(term);
    out.push({
      term,
      volume,
      cpc: typeof k.cpc === "number" ? k.cpc : undefined,
    });
  }

  return out.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
}

/**
 * 取域名的关键词（Similarweb 口径），DFS 不可用/欠费时的替代源。
 *
 * 复用 fetchLergassy / fetchVortex 的缓存 key，同域名 30 天内命中缓存，
 * 不会因为「先取流量再取关键词」而重复扣费。
 */
export async function fetchSimilarwebKeywords(domain: string): Promise<KeywordItem[]> {
  try {
    const lg = await fetchLergassy(domain);
    const kws = lg ? extractSimilarwebKeywords(lg) : [];
    if (kws.length) return kws;
  } catch (e) {
    // 额度超限会在这一层暴露（platform-feature-disabled），不要静默
    console.warn("[apify] lergassy 取词失败：", e instanceof Error ? e.message : e);
  }
  try {
    const vx = await fetchVortex(domain);
    return vx ? extractSimilarwebKeywords(vx) : [];
  } catch (e) {
    console.warn("[apify] vortex 取词失败：", e instanceof Error ? e.message : e);
    return [];
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
  return cachedCall(
    {
      provider: "apify",
      endpoint: "datascraperes/bulk-domain-rating-checker",
      key: domain,
      costUsd: APIFY_COST_PER_DOMAIN,
      ttlDays: 90, // DR 变化慢，三个月内复用
    },
    () => fetchDomainRatingRaw(domain),
  );
}

async function fetchDomainRatingRaw(domain: string): Promise<number | null> {
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
 * 批量取 Ahrefs DR。
 * 该 Actor 名为 bulk-domain-rating-checker，一次可传多个 targets，只付一次启动开销。
 * 逐域计价仍为 $0.0028，批量只省时间不省钱，但能把 178 站从 ~1 小时压到几分钟。
 */
export async function fetchDomainRatingBatch(domains: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (domains.length === 0) return out;
  const key = createHash("sha256").update(domains.join("|")).digest("hex").slice(0, 16);
  const items = await cachedCall<DomainRatingItem[]>(
    {
      provider: "apify",
      endpoint: "datascraperes/bulk-domain-rating-checker#batch",
      key,
      costUsd: APIFY_COST_PER_DOMAIN * domains.length,
      ttlDays: 90,
    },
    async () => {
      const token = process.env.APIFY_TOKEN!;
      const res = await fetch(
        `https://api.apify.com/v2/acts/datascraperes~bulk-domain-rating-checker/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
          body: JSON.stringify({ targets: domains.map((d) => `https://${d}`) }),
          signal: AbortSignal.timeout(600_000),
        },
      );
      if (!res.ok) throw new Error(`DR batch ${res.status}`);
      return (await res.json()) as DomainRatingItem[];
    },
  );
  for (const it of items ?? []) {
    const host = it.target?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
    if (host && typeof it.domainRating === "number" && Number.isFinite(it.domainRating)) {
      out.set(host, it.domainRating);
    }
  }
  return out;
}

/* --------------------------- Wayback 首快照（上线时间） --------------------------- */

export interface WaybackSnapshotItem {
  queryUrl?: string;
  archiveDate?: string;
  timestamp?: string;
  statusCode?: string;
}

/**
 * 取每个域名在 Wayback Machine 的最早快照时间（网站第一次被公开存档）。
 * 这是「网站上线时间」目前唯一可大规模获得的客观证据：
 *   - Product Hunt 的 createdAt 按名字搜到的是最近一条 post，实测全部落在采集当月，不可用；
 *   - 域名注册时间只说明域名被注册，老域名改造的站会早出数年。
 * 无存档记录返回空 Map（新站常见），调用方需自行兜底。
 */
export async function fetchWaybackFirstSnapshots(domains: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (domains.length === 0) return out;
  const key = createHash("sha256").update(domains.join("|")).digest("hex").slice(0, 16);
  const items = await cachedCall<WaybackSnapshotItem[]>(
    {
      provider: "apify",
      endpoint: "ryanclinton/wayback-machine-search#batch",
      key,
      costUsd: 0.001 * domains.length,
      ttlDays: 365, // 首快照是历史事实，不会变
    },
    async () => {
      const token = process.env.APIFY_TOKEN!;
      const res = await fetch(
        `https://api.apify.com/v2/acts/ryanclinton~wayback-machine-search/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": config.userAgent },
          body: JSON.stringify({
            urls: domains,
            maxResults: 1,
            includeInsights: false,
            generateReport: false,
            statusFilter: "200",
          }),
          signal: AbortSignal.timeout(900_000),
        },
      );
      if (!res.ok) throw new Error(`wayback batch ${res.status}`);
      return (await res.json()) as WaybackSnapshotItem[];
    },
  );
  for (const it of items ?? []) {
    const host = it.queryUrl?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").toLowerCase();
    const date = it.archiveDate ?? (it.timestamp ? `${it.timestamp.slice(0, 4)}-${it.timestamp.slice(4, 6)}-${it.timestamp.slice(6, 8)}` : undefined);
    if (!host || !date) continue;
    const prev = out.get(host);
    if (!prev || date < prev) out.set(host, date);
  }
  return out;
}

/**
 * 主入口：vortex（字段最全）→ lergassy 备选。
 *
 * DataForSEO 已于 2026-11 下线：它给的是「搜索流量」口径，与页面展示的
 * 「总访问量」不是一回事；缺自然搜索份额时保留缺失，不再跨源补齐 ——
 * 两个口径混在一起，页面上的数就对不上任何一份原始数据了。
 */
export async function fetchTrafficMetrics(
  domain: string,
  /** 调用方已拿到的 vortex 结果，传 undefined 才会真正发起 actor 调用（避免同一域名跑两次） */
  preloaded?: VortexItem | null,
): Promise<TrafficMetrics | null> {
  let m: TrafficMetrics | null = null;
  // 2026-10 实测：vortex_data/similarweb-scraper 对所有域名（含 picvo.ai、claude.com）
  // 均返回空数组，已不可用；lergassy 正常且不产生费用。故默认 lergassy 优先，
  // 需要时用 APIFY_PRIMARY=vortex 切回旧顺序。
  const preferVortex = (process.env.APIFY_PRIMARY ?? "lergassy").toLowerCase() === "vortex";

  if (preferVortex) {
    const v = preloaded !== undefined ? preloaded : await fetchVortex(domain);
    if (v) m = extractVortex(v);
    if (!m?.monthlyVisits) {
      const fb = await fetchLergassy(domain);
      if (fb) m = extractTrafficMetrics(fb);
    }
  } else {
    // 1) 当前唯一可用源
    const fb = await fetchLergassy(domain);
    if (fb) m = extractTrafficMetrics(fb);
    // 2) 兜底：vortex（已失效，保留以便 Actor 恢复后无需改代码）
    if (!m?.monthlyVisits) {
      const v = preloaded !== undefined ? preloaded : await fetchVortex(domain);
      if (v) m = extractVortex(v);
    }
  }

  // 自然搜索份额缺失时不做跨源补齐：页面展示的 organicShare 必须来自同一个快照，
  // 否则「总访问量」和「自然搜索占比」会分别来自两个不同月份，算出来的自然搜索量是假的。
  return m?.monthlyVisits ? m : null;
}
