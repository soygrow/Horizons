import type { KeywordItem, GeoItem } from "@horizons/shared";
import { config } from "../config";

/**
 * DataForSEO 采集源（流量估算 + 关键词）。
 *
 * 口径说明（重要）：DataForSEO Labs 提供的是「搜索流量」（organic + paid search
 * 的估算），不是 SimilarWeb 的「总访问量」（含直接访问/社媒/外链）。因此：
 *   - 月访问量（总）          → DataForSEO 无法提供（SimilarWeb 独有）
 *   - 月搜索流量              → bulk_traffic_estimation 可提供
 *   - 关键词/CPC/竞争         → ranked_keywords 可提供
 *   - 国家分布（搜索流量）     → domain_rank_overview 可提供
 *   - 流量趋势（搜索流量历史） → historical_rank_overview 可提供
 * 跳出率/访问时长/页数/渠道占比 → DataForSEO 无法提供，保持「待接入」。
 *
 * 认证：Basic Auth（DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD）。
 */

const LOCATION_CODE = 2840; // US
const LANGUAGE_CODE = "en";

function getCreds(): { login: string; password: string } | null {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  return login && password ? { login, password } : null;
}

export function hasDataForSEO(): boolean {
  return getCreds() !== null;
}

interface DfsResponse {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    id?: string;
    status_code?: number;
    status_message?: string;
    result?: Array<Record<string, unknown>>;
  }>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`DataForSEO ${path} 失败：HTTP ${status}`);
  }
}

/** 单次 HTTP 调用（POST 带 body，GET 不带） */
async function send(path: string, body?: unknown[]): Promise<DfsResponse> {
  const creds = getCreds();
  if (!creds) throw new Error("未配置 DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD");
  const auth = `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`;

  const res = await fetch(`https://api.dataforseo.com/v3/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: auth,
      ...(body ? { "Content-Type": "application/json" } : {}),
      "User-Agent": config.userAgent,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new HttpError(res.status, path);
  const data = (await res.json()) as DfsResponse;
  if (data.status_code && data.status_code >= 30000) {
    throw new Error(`DataForSEO 错误 ${data.status_code}: ${data.status_message ?? ""}`);
  }
  return data;
}

/* ------------------------------- 队列策略 -------------------------------
 * 2026-10 实测：DataForSEO Labs / Backlinks / Domain Analytics 全系端点
 * 只有 live，没有 standard 队列（task_post 一律返回 40400 Not Found）。
 * 因此默认走 live；DFS_QUEUE=standard 仅供将来端点支持时启用，
 * 探明不支持的端点会缓存到 liveOnly，后续直接走 live，不再重复试探。
 * 真正的降本手段是 bulk 端点（一次请求多域名），见 bulk-estimate.ts。
 * ---------------------------------------------------------------------- */

/** task_post 不被支持（端点无 standard 队列）时抛出，用于触发回退 */
class QueueUnsupportedError extends Error {}

/** 已确认无 standard 队列的端点前缀，避免每次请求都白跑一次 404 */
const liveOnly = new Set<string>();

const POLL_INTERVAL_MS = Number(process.env.DFS_POLL_MS ?? 5000);
const QUEUE_TIMEOUT_MS = Number(process.env.DFS_QUEUE_TIMEOUT_MS ?? 15 * 60 * 1000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function liveRequest<T>(path: string, body: unknown[]): Promise<T> {
  return (await send(path, body)) as T;
}

async function standardRequest<T>(path: string, body: unknown[]): Promise<T> {
  const postPath = path.replace(/\/live$/, "/task_post");
  if (postPath === path) return liveRequest<T>(path, body); // 非 /live 结尾，保持原样

  let posted: DfsResponse;
  try {
    posted = await send(postPath, body);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) {
      throw new QueueUnsupportedError("task_post 不存在（HTTP 404）");
    }
    throw e;
  }

  const taskId = posted.tasks?.[0]?.id;
  if (!taskId) {
    const code = posted.tasks?.[0]?.status_code ?? posted.status_code ?? 0;
    throw new QueueUnsupportedError(
      `task_post 未返回任务 ID（${code} ${posted.tasks?.[0]?.status_message ?? posted.status_message ?? ""}）`,
    );
  }

  const getPath = `${postPath.replace(/\/task_post$/, "/task_get")}/${taskId}`;
  const deadline = Date.now() + QUEUE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const got = await send(getPath);
    const task = got.tasks?.[0];
    // 有 result 即已完成（standard 队列排队中时 result 为 null）
    if (Array.isArray(task?.result)) return got as T;
    const code = task?.status_code ?? 0;
    // 40601/40602 是「排队中/处理中」，其余 >=40000 视为任务失败
    if (code >= 40000 && code !== 40601 && code !== 40602) {
      throw new Error(`standard 任务失败 ${code}: ${task?.status_message ?? ""}`);
    }
  }
  throw new Error(`standard 队列等待超时（${QUEUE_TIMEOUT_MS / 1000}s）`);
}

async function request<T = unknown>(path: string, body: unknown[]): Promise<T> {
  const mode = (process.env.DFS_QUEUE ?? "live").toLowerCase();
  const base = path.replace(/\/live$/, "");
  if (mode !== "standard" || liveOnly.has(base)) return liveRequest<T>(path, body);

  try {
    return await standardRequest<T>(path, body);
  } catch (e) {
    if (e instanceof QueueUnsupportedError) {
      liveOnly.add(base);
      console.warn(`[dfs] ${base} 无 standard 队列，后续改用 live：${e.message}`);
      return liveRequest<T>(path, body);
    }
    throw e;
  }
}

export interface SearchTraffic {
  organicVisits: number;
  paidVisits: number;
}

/** 批量估算搜索流量（一次最多 1000 个域名） */
export async function fetchTrafficEstimate(
  domains: string[],
): Promise<Map<string, SearchTraffic>> {
  const map = new Map<string, SearchTraffic>();
  if (domains.length === 0) return map;

  const body = [
    {
      targets: domains,
      location_code: LOCATION_CODE,
      language_code: LANGUAGE_CODE,
    },
  ];
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          target?: string;
          metrics?: {
            organic?: { etv?: number };
            paid?: { etv?: number };
          };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/bulk_traffic_estimation/live", body);

  for (const item of data.tasks?.[0]?.result?.[0]?.items ?? []) {
    const domain = item.target;
    if (!domain) continue;
    const organic = item.metrics?.organic?.etv ?? 0;
    const paid = item.metrics?.paid?.etv ?? 0;
    map.set(domain, { organicVisits: organic, paidVisits: paid });
  }
  return map;
}

/** 域名排名关键词（含搜索量/CPC/竞争） */
export async function fetchKeywords(
  domain: string,
  limit = 20,
): Promise<KeywordItem[]> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          keyword_data?: {
            keyword?: string;
            search_volume?: number;
            cpc?: number;
            competition?: string;
          };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/ranked_keywords/live", [
    { target: domain, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE, limit },
  ]);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .map((it) => {
      const k = it.keyword_data;
      return {
        term: k?.keyword ?? "",
        volume: k?.search_volume,
        cpc: k?.cpc,
        competition: k?.competition,
      } as KeywordItem;
    })
    .filter((k) => k.term);
}

/** 按国家搜索流量分布 */
export async function fetchGeoDistribution(domain: string): Promise<GeoItem[]> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          location_name?: string;
          metrics?: { organic?: { etv?: number } };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/domain_rank_overview/live", [
    { target: domain, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE, limit: 1000 },
  ]);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  const total = items.reduce(
    (sum, it) => sum + (it.metrics?.organic?.etv ?? 0),
    0,
  );
  if (total <= 0) return [];

  return items
    .map((it) => ({
      country: it.location_name ?? "",
      share: Math.round(((it.metrics?.organic?.etv ?? 0) / total) * 1000) / 10,
    }))
    .filter((g) => g.country && g.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, 10);
}

/** 关键词排名分布（域名在各排名位置段的关键词数量） */
export interface KeywordRankBucket {
  label: string;
  count: number;
}

export interface TrafficHistoryResult {
  history: { date: string; total: number; organic: number }[];
  keywordCount: number;
  rankDistribution: KeywordRankBucket[];
}

const POS_BUCKETS: [key: string, label: string][] = [
  ["pos_1", "第 1 名"],
  ["pos_2_3", "2-3 名"],
  ["pos_4_10", "4-10 名"],
  ["pos_11_20", "11-20 名"],
  ["pos_21_30", "21-30 名"],
  ["pos_31_40", "31-40 名"],
  ["pos_41_50", "41-50 名"],
  ["pos_51_60", "51-60 名"],
  ["pos_61_70", "61-70 名"],
  ["pos_71_80", "71-80 名"],
  ["pos_81_90", "81-90 名"],
  ["pos_91_100", "91-100 名"],
];

/**
 * 历史流量趋势 + 最新月关键词排名分布。
 * 关键：用 clickstream_etv（基于点击流数据的估算流量，比普通 etv 更接近真实流量）。
 * 普通 etv 只基于 Google 关键词排名，对新站（DR 低、排名少）严重低估。
 */
export async function fetchTrafficHistory(domain: string): Promise<TrafficHistoryResult> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          month?: number;
          year?: number;
          metrics?: {
            organic?: { etv?: number; clickstream_etv?: number; count?: number } & Record<string, number>;
            paid?: { etv?: number; clickstream_etv?: number } & Record<string, number>;
          };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/historical_rank_overview/live", [
    {
      target: domain,
      location_code: LOCATION_CODE,
      language_code: LANGUAGE_CODE,
      include_clickstream_data: true,
    },
  ]);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  const history = items
    .map((it) => {
      const month = it.month ? String(it.month).padStart(2, "0") : "01";
      const year = it.year ?? 2000;
      const o = it.metrics?.organic;
      const p = it.metrics?.paid;
      const organic = Math.round(o?.clickstream_etv ?? o?.etv ?? 0);
      const paid = Math.round(p?.clickstream_etv ?? p?.etv ?? 0);
      return { date: `${year}-${month}-01`, total: organic + paid, organic };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // 最新月关键词排名分布
  const latest = items[items.length - 1];
  const organic = latest?.metrics?.organic;
  const keywordCount = organic?.count ?? 0;
  const rankDistribution: KeywordRankBucket[] = POS_BUCKETS.map(([key, label]) => ({
    label,
    count: organic?.[key] ?? 0,
  })).filter((b) => b.count > 0);

  return { history, keywordCount, rankDistribution };
}

export interface BacklinkSummary {
  total: number;
  totalDofollowShare: number;
  refDomains: number;
  refDofollowShare: number;
  domainWeight: number; // DFS rank（0~1000 权重，替代 DR）
}

/** 外链汇总（backlinks summary） */
export async function fetchBacklinksSummary(domain: string): Promise<BacklinkSummary | null> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          target?: string;
          rank?: number;
          backlinks?: number;
          dofollow?: number;
          refdomains?: number;
          refdomains_dofollow?: number;
        }>;
      }>;
    }>;
  }>("backlinks/summary/live", [{ target: domain }]);

  const it = data.tasks?.[0]?.result?.[0]?.items?.[0];
  if (!it || it.target !== domain) return null;

  const total = it.backlinks ?? 0;
  const refDomains = it.refdomains ?? 0;
  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

  return {
    total,
    totalDofollowShare: pct(it.dofollow ?? 0, total),
    refDomains,
    refDofollowShare: pct(it.refdomains_dofollow ?? 0, refDomains),
    domainWeight: it.rank ?? 0,
  };
}

/** WHOIS 注册时间 */
export async function fetchWhois(domain: string): Promise<string | undefined> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          domain?: string;
          created_datetime?: string;
          first_seen?: string;
        }>;
      }>;
    }>;
  }>("domain_analytics/whois/overview/live", [{ target: domain, limit: 1 }]);

  const it = data.tasks?.[0]?.result?.[0]?.items?.[0];
  if (!it) return undefined;
  // first_seen 是 DFS 爬虫首次发现域名的时间，比 created_datetime 对 .ai 等 ccTLD 更可靠
  const raw = it.first_seen ?? it.created_datetime;
  if (!raw) return undefined;
  return raw.slice(0, 10); // YYYY-MM-DD
}

/** 竞品过滤：排除平台巨头 / 内容站（它们竞争的是大词，不是直接竞品） */
const COMPETITOR_EXCLUDED = new Set([
  "google.com", "youtube.com", "facebook.com", "instagram.com", "reddit.com",
  "twitter.com", "x.com", "linkedin.com", "wikipedia.org", "amazon.com",
  "apple.com", "microsoft.com", "github.com", "adobe.com", "pinterest.com",
  "tiktok.com", "quora.com", "medium.com", "openai.com", "chatgpt.com",
]);

/** 真实竞品域名（competitors_domain：与目标站竞争相同关键词的域名） */
export async function fetchCompetitors(domain: string, limit = 8): Promise<string[]> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          domain?: string;
          rank?: number;
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/competitors_domain/live", [
    { target: domain, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE, limit: 20 },
  ]);

  return (data.tasks?.[0]?.result?.[0]?.items ?? [])
    .map((it) => it.domain)
    .filter((d): d is string => !!d && d !== domain && !COMPETITOR_EXCLUDED.has(d))
    .slice(0, limit);
}

/** 相关关键词（related_keywords：给灵感点子提供素材） */
export async function fetchRelatedKeywords(
  keywords: string[],
  limit = 15,
): Promise<{ term: string; volume?: number }[]> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          keyword_data?: { keyword?: string; search_volume?: number };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/related_keywords/live", [
    { keywords, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE, limit },
  ]);

  return (data.tasks?.[0]?.result?.[0]?.items ?? [])
    .map((it) => ({
      term: it.keyword_data?.keyword ?? "",
      volume: it.keyword_data?.search_volume,
    }))
    .filter((k) => k.term);
}

/**
 * 自然搜索流量估算（domain_rank_overview，汇总各地区 organic.etv）。
 * 用于 Apify 拿不到自然搜索份额时兜底（低流量站渠道份额缺失的常见场景）。
 */
export async function fetchOrganicSearchETV(domain: string): Promise<number | undefined> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          metrics?: { organic?: { etv?: number } };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/domain_rank_overview/live", [
    { target: domain, limit: 1000 },
  ]);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  const total = items.reduce((sum, it) => sum + (it.metrics?.organic?.etv ?? 0), 0);
  return total > 0 ? Math.round(total) : undefined;
}
