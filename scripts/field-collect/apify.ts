/**
 * Apify 侧的数据获取（文档第 3~6 节的三类源）。
 *
 * 文档指定 `vortex_data/similarweb-scraper` 的三种模式（base_data / similar_sites / aitdk）
 * 加 `apify/google-search-scraper`。这三种模式必须分别跑，一次调用拿不全 —— 这是文档
 * 自己点明的实施提醒，所以这里把三次 run 分开写，各自失败只影响自己那几个字段。
 *
 * 兜底：`lergassy/similarweb-traffic-scraper`（本项目实测可用、不额外计费），
 * 只补它真有值的口径（月访问量/排名/跳出率/渠道份额/关键词/相似站/国家分布），
 * 补上的字段会把 actualSource 标成 lergassy，方便判断「文档的方案是否真的能采到」。
 */
import { sleep } from "./util";

const API = "https://api.apify.com/v2";

export const VORTEX_ACTOR = "vortex_data~similarweb-scraper";
export const LERGASSY_ACTOR = "lergassy~similarweb-traffic-scraper";
export const SEARCH_ACTOR = "apify~google-search-scraper";

export function hasApify(): boolean {
  return !!process.env.APIFY_TOKEN;
}

function token(): string {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw new Error("未配置 APIFY_TOKEN");
  return t;
}

/**
 * 同步跑 Actor 并直接拿 dataset items。
 * Apify 的 run-sync 端点硬上限 300 秒，超过会把连接掐掉，所以超时给 290s。
 */
export async function runSync<T>(actor: string, input: unknown, timeoutMs = 290_000): Promise<T[]> {
  const res = await fetch(`${API}/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Actor ${actor} HTTP ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as T[]) : [];
}

/** 异步跑 + 轮询（Similarweb 类 Actor 单站就要 40~90 秒，同步端点经常踩线） */
export async function runAsync<T>(
  actor: string,
  input: unknown,
  opts: { deadlineMs?: number; pollMs?: number } = {},
): Promise<T[]> {
  const { deadlineMs = 480_000, pollMs = 3000 } = opts;
  const startRes = await fetch(`${API}/acts/${actor}/runs?token=${encodeURIComponent(token())}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(60_000),
  });
  if (!startRes.ok) throw new Error(`Actor ${actor} 启动失败 HTTP ${startRes.status}`);
  const runId = ((await startRes.json()) as { data?: { id?: string } }).data?.id;
  if (!runId) throw new Error(`Actor ${actor} 未返回 runId`);

  const deadline = Date.now() + deadlineMs;
  let status = "";
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = (await (
      await fetch(`${API}/actor-runs/${runId}?token=${encodeURIComponent(token())}`, {
        signal: AbortSignal.timeout(30_000),
      })
    ).json()) as { data?: { status?: string } };
    status = st.data?.status ?? "";
    if (status === "SUCCEEDED") break;
    if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
      throw new Error(`Actor ${actor} 运行失败：${status}`);
    }
  }
  if (status !== "SUCCEEDED") throw new Error(`Actor ${actor} 超时：${status || "unknown"}`);

  const items = await (
    await fetch(`${API}/actor-runs/${runId}/dataset/items?token=${encodeURIComponent(token())}`, {
      signal: AbortSignal.timeout(60_000),
    })
  ).json();
  return Array.isArray(items) ? (items as T[]) : [];
}

/* --------------------------------- Vortex --------------------------------- */

/** 文档列出的 Similarweb 输出字段（vortex 模式下的子集，未列出的保持可选） */
export interface SimilarwebItem {
  domain?: string;
  title?: string;
  description?: string;
  totalVisits?: number;
  monthlyVisits?: { month?: string; visits?: number }[] | number;
  monthlyVisitsDateFormat?: unknown;
  rankGlobal?: number;
  countryRank?: number;
  country?: string;
  category?: string;
  categoryRank?: number;
  bounceRate?: number;
  pagesPerVisit?: number;
  timeOnSite?: number;
  directTraffic?: number;
  searchOrganicTraffic?: number;
  searchPaidTraffic?: number;
  searchTraffic?: number;
  referralTraffic?: number;
  socialTraffic?: number;
  displayAdsTraffic?: number;
  mailTraffic?: number;
  paidReferralsTraffic?: number;
  aiTrafficVisits?: number;
  genAiTraffic?: number;
  aiReferralTraffic?: number;
  aiTrafficShareChatgpt?: number;
  aiTrafficShareClaude?: number;
  aiTrafficShareGemini?: number;
  aiTrafficSharePerplexity?: number;
  aiTrafficSources?: { name?: string; source?: string; share?: number; rank?: number }[];
  website_traffic_by_country?: { country?: string; countryName?: string; share?: number; visits?: number }[];
  topKeywords?: { keyword?: string; searchVolume?: number; cpc?: number | null; estimatedValue?: number }[];
  keyword_density?: { keyword?: string; density?: number; count?: number }[] | Record<string, number>;
  keyword_density_total_words?: number;
  similar_sites?: {
    domain?: string;
    url?: string;
    totalVisits?: number;
    similarityScore?: number;
    category?: string;
  }[];
}

export type VortexMode = "base_data" | "similar_sites" | "aitdk";

export interface ModeResult {
  mode: VortexMode;
  item: SimilarwebItem | null;
  error?: string;
  /** 实际生效的入参（不同版本的 Actor 对 mode 的写法不一样，记下来便于排查） */
  input?: unknown;
}

/**
 * 跑一个 vortex 模式。
 *
 * 入参键名是 `datasetMode`（Actor 页面 / README 的示例：`{"domains":["x.com"],"datasetMode":"base_data"}`）。
 * 早前写成 `mode` 时被 Actor 静默忽略，三种模式全部返回 base_data —— 这也是
 * similar_sites / aitdk 相关字段一直空的真正原因，务必不要再改回去。
 *
 * base_data 额外保留一次「不带 datasetMode」的裸调用作兜底（Actor 默认行为就是 base_data）；
 * 另外两种模式只认 datasetMode，不做二次尝试，避免白花钱。
 */
export async function fetchVortexMode(domain: string, mode: VortexMode): Promise<ModeResult> {
  if (!hasApify()) return { mode, item: null, error: "未配置 APIFY_TOKEN" };

  const variants: unknown[] =
    mode === "base_data"
      ? [{ domains: [domain], datasetMode: mode }, { domains: [domain] }]
      : [{ domains: [domain], datasetMode: mode }];

  let lastError = "";
  for (const input of variants) {
    try {
      const items = await runSync<SimilarwebItem>(VORTEX_ACTOR, input);
      if (items.length && items[0]) return { mode, item: items[0], input };
      lastError = "Actor 返回空数组";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { mode, item: null, error: lastError || "无数据" };
}

/* -------------------------------- Lergassy -------------------------------- */

export interface LergassyItem {
  type?: string;
  domain?: string;
  monthlyVisits?: number;
  monthlyVisitsChange?: number;
  monthlyVisitsHistory?: { month?: string; visits?: number }[];
  pagesPerVisit?: number;
  avgVisitDuration?: string | null;
  avgVisitDurationSeconds?: number | null;
  bounceRate?: number;
  globalRank?: number;
  countryRank?: number;
  trafficSources?: { source?: string; share?: number | null; rank?: number | null }[];
  topCountries?: { countryCode?: string; share?: number | null }[];
  topKeywords?: { keyword?: string; volume?: number | null; cpc?: number | null }[];
  similarSites?: { domain?: string; category?: string; categoryRank?: number; affinity?: number }[];
  organicSearchShare?: number;
  paidSearchShare?: number;
  keywordsTotal?: number;
}

/** 备选源：跑不通就返回 error，不抛（兜底源失败不该让整次采集挂掉） */
export async function fetchLergassy(domain: string): Promise<{ item: LergassyItem | null; error?: string }> {
  if (!hasApify()) return { item: null, error: "未配置 APIFY_TOKEN" };
  try {
    const items = await runAsync<LergassyItem>(LERGASSY_ACTOR, { websites: [domain] });
    const usable = items.filter((i) => i.type !== "notice");
    const hit = usable.find((i) => (i.domain ?? "").toLowerCase() === domain) ?? usable[0] ?? null;
    return { item: hit };
  } catch (e) {
    return { item: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------ Google Search ------------------------------ */

export interface SerpOrganic {
  position?: number;
  title?: string;
  url?: string;
  description?: string;
  date?: string;
}

export interface SerpPage {
  searchQuery?: { term?: string; url?: string } | string;
  organicResults?: SerpOrganic[];
  error?: string;
}

/**
 * Google SERP：一次 run 带多个 query。
 * 只用来给「采样关键词排名 / TOP10 / TOP20」和「产品正式发布日」提供证据，
 * 因此限制每页 10 条、每个 query 只跑一页，控制成本。
 */
export async function googleSearch(
  queries: string[],
  opts: { countryCode?: string; languageCode?: string } = {},
): Promise<{ pages: SerpPage[]; error?: string }> {
  if (!queries.length) return { pages: [] };
  if (!hasApify()) return { pages: [], error: "未配置 APIFY_TOKEN" };
  try {
    const pages = await runSync<SerpPage>(
      SEARCH_ACTOR,
      {
        queries: queries.join("\n"),
        resultsPerPage: 10,
        maxPagesPerQuery: 1,
        countryCode: opts.countryCode ?? "us",
        languageCode: opts.languageCode ?? "en",
        includeUnfilteredResults: false,
      },
      240_000,
    );
    return { pages };
  } catch (e) {
    return { pages: [], error: e instanceof Error ? e.message : String(e) };
  }
}