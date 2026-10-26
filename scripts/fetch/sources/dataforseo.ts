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

async function request<T = unknown>(path: string, body: unknown[]): Promise<T> {
  const creds = getCreds();
  if (!creds) throw new Error("未配置 DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD");
  const auth = `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString("base64")}`;

  const res = await fetch(`https://api.dataforseo.com/v3/${path}`, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} 失败：HTTP ${res.status}`);
  const data = (await res.json()) as {
    status_code?: number;
    status_message?: string;
    tasks?: Array<{ result?: Array<Record<string, unknown>> }>;
  };
  if (data.status_code && data.status_code >= 30000) {
    throw new Error(`DataForSEO 错误 ${data.status_code}: ${data.status_message ?? ""}`);
  }
  return data as T;
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

  const body = domains.map((target) => ({
    target,
    location_code: LOCATION_CODE,
    language_code: LANGUAGE_CODE,
  }));
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        target?: string;
        metrics?: {
          organic?: { etv?: number };
          paid?: { etv?: number };
        };
      }>;
    }>;
  }>("dataforseo_labs/google/bulk_traffic_estimation/live", body);

  for (const item of data.tasks?.[0]?.result ?? []) {
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

/** 历史搜索流量趋势 */
export async function fetchTrafficHistory(
  domain: string,
): Promise<{ date: string; visits: number }[]> {
  const data = await request<{
    tasks?: Array<{
      result?: Array<{
        items?: Array<{
          month?: number;
          year?: number;
          metrics?: { organic?: { etv?: number }; paid?: { etv?: number } };
        }>;
      }>;
    }>;
  }>("dataforseo_labs/google/historical_rank_overview/live", [
    { target: domain, location_code: LOCATION_CODE, language_code: LANGUAGE_CODE },
  ]);

  const items = data.tasks?.[0]?.result?.[0]?.items ?? [];
  return items
    .map((it) => {
      const month = it.month ? String(it.month).padStart(2, "0") : "01";
      const year = it.year ?? 2000;
      const visits = (it.metrics?.organic?.etv ?? 0) + (it.metrics?.paid?.etv ?? 0);
      return { date: `${year}-${month}-01`, visits };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
