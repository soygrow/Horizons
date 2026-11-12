/**
 * 把第三方返回的原始结构映射成文档里的字段。
 *
 * 单独一个文件的原因：Similarweb（vortex / lergassy 两套完全不同的字段名）、SERP、
 * 密度统计的字段名和口径都很脏，混在流程里会把 orchestrator 淹掉。
 * 这里的每个函数只做「读值 → 写 FieldBag」，不发请求，方便单看映射是否漏字段。
 *
 * 所有兜底写入都走 fill()：已有值不覆盖，因为字段的第一次写入来自主源，
 * 备选源只能补空，不能把主源的数改掉。
 */
import type { LergassyItem, SerpPage, SimilarwebItem } from "./apify";
import type { FieldBag } from "./fields";
import { fmtBig, fmtDuration, fmtPct } from "./util";

interface SetOpts {
  display?: string;
  actualSource?: string;
  note?: string;
}

/** 只在空位上写（备选源用） */
function fill(fields: FieldBag, key: string, value: unknown, opts: SetOpts = {}): void {
  if (fields.has(key)) return;
  fields.set(key, value, opts);
}

function fillNum(fields: FieldBag, key: string, value: number | null | undefined, opts: SetOpts = {}): void {
  if (fields.has(key)) return;
  fields.setNumber(key, value, opts);
}

export function textOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/* ------------------------------ 历史访问量 ------------------------------ */

export interface MonthPoint {
  month: string;
  visits: number;
}

/** vortex 的 monthlyVisits 可能是 [{month,visits}] 也可能直接是数字，统一成升序数组 */
export function normalizeHistory(raw: SimilarwebItem["monthlyVisits"] | LergassyItem["monthlyVisitsHistory"]): MonthPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: MonthPoint[] = [];
  for (const row of raw) {
    const month = String((row as { month?: string }).month ?? "").slice(0, 7);
    const visits = Number((row as { visits?: number }).visits ?? NaN);
    if (/^\d{4}-\d{2}$/.test(month) && Number.isFinite(visits)) points.push({ month, visits });
  }
  return points.sort((a, b) => a.month.localeCompare(b.month));
}

/** 环比/三月增长：分母为 0 或不足期数时返回 null（不编造 0%） */
export function growth(history: MonthPoint[], monthsBack: number): number | null {
  if (history.length <= monthsBack) return null;
  const last = history[history.length - 1].visits;
  const prev = history[history.length - 1 - monthsBack].visits;
  if (!prev) return null;
  return Math.round(((last - prev) / prev) * 1000) / 10;
}

export function fmtSignedPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  return `${v > 0 ? "+" : ""}${v}%`;
}

/* ------------------------------- vortex 映射 ------------------------------- */

export function applyVortexBase(fields: FieldBag, item: SimilarwebItem, source: string): void {
  const history = normalizeHistory(item.monthlyVisits);
  const latest = history.length ? history[history.length - 1].visits : undefined;

  fields.setNumber("monthly_visits", item.totalVisits ?? latest, { actualSource: source });
  fields.set("monthly_visits_history", history.length ? history : null, {
    display: history
      .slice(-6)
      .map((h) => `${h.month} ${fmtBig(h.visits)}`)
      .join("；"),
    actualSource: source,
  });
  fields.setNumber("rank_global", item.rankGlobal, { actualSource: source });
  fields.setNumber("country_rank", item.countryRank, { actualSource: source });
  fields.set("country", item.country ?? null, { actualSource: source });
  fields.set("similarweb_category", item.category ?? null, { actualSource: source });
  fields.setNumber("category_rank", item.categoryRank, { actualSource: source });

  fields.set("bounce_rate", item.bounceRate ?? null, { display: fmtPct(item.bounceRate), actualSource: source });
  fields.setNumber("pages_per_visit", item.pagesPerVisit, { actualSource: source });
  fields.set("time_on_site", item.timeOnSite ?? null, { display: fmtDuration(item.timeOnSite), actualSource: source });

  const mom = growth(history, 1);
  const g3m = growth(history, 3);
  fields.set("visits_mom", mom, { display: fmtSignedPct(mom), actualSource: "历史月访问量计算" });
  fields.set("visits_growth_3m", g3m, { display: fmtSignedPct(g3m), actualSource: "历史月访问量计算" });

  const channels: [keyof SimilarwebItem, string][] = [
    ["directTraffic", "direct_traffic"],
    ["searchOrganicTraffic", "search_organic_traffic"],
    ["searchPaidTraffic", "search_paid_traffic"],
    ["searchTraffic", "search_traffic"],
    ["referralTraffic", "referral_traffic"],
    ["socialTraffic", "social_traffic"],
    ["displayAdsTraffic", "display_ads_traffic"],
    ["mailTraffic", "mail_traffic"],
    ["paidReferralsTraffic", "paid_referrals_traffic"],
  ];
  for (const [apiKey, fieldKey] of channels) {
    const v = item[apiKey] as number | undefined;
    fields.set(fieldKey, v ?? null, { display: fmtPct(v), actualSource: source });
  }

  // AI 流量：文档里 AI 引荐占比有 genAiTraffic / aiReferralTraffic 两种叫法，按可用性取
  const aiShare = item.genAiTraffic ?? item.aiReferralTraffic;
  fields.set("ai_traffic_visits", item.aiTrafficVisits ?? null, {
    display: fmtBig(item.aiTrafficVisits),
    actualSource: source,
  });
  fields.set("gen_ai_traffic", aiShare ?? null, { display: fmtPct(aiShare), actualSource: source });
  for (const [apiKey, fieldKey] of [
    ["aiTrafficShareChatgpt", "ai_chatgpt_share"],
    ["aiTrafficShareClaude", "ai_claude_share"],
    ["aiTrafficShareGemini", "ai_gemini_share"],
    ["aiTrafficSharePerplexity", "ai_perplexity_share"],
  ] as const) {
    const v = item[apiKey];
    fields.set(fieldKey, v ?? null, { display: fmtPct(v), actualSource: source });
  }

  if (item.aiTrafficSources?.length) {
    fields.set("ai_traffic_sources", item.aiTrafficSources, {
      display: item.aiTrafficSources
        .slice(0, 8)
        .map((s) => `${s.name ?? s.source ?? "?"} ${fmtPct(s.share)}`)
        .join("；"),
      actualSource: source,
    });
  }

  if (item.website_traffic_by_country?.length) {
    fields.set("traffic_by_country", item.website_traffic_by_country, {
      display: item.website_traffic_by_country
        .slice(0, 8)
        .map((c) => `${c.countryName ?? c.country ?? "?"} ${fmtPct(c.share)}`)
        .join("；"),
      actualSource: source,
    });
  }

  if (item.topKeywords?.length) {
    applyKeywordList(
      fields,
      item.topKeywords.map((k) => ({
        keyword: k.keyword ?? "",
        volume: k.searchVolume,
        cpc: k.cpc ?? undefined,
        value: k.estimatedValue,
      })),
      source,
    );
  }
}

export function applyVortexSimilarSites(fields: FieldBag, item: SimilarwebItem, source: string): void {
  const sites = item.similar_sites ?? [];
  if (!sites.length) return;
  fields.set("similar_sites", sites.map((s) => s.domain ?? s.url ?? "").filter(Boolean), {
    display: sites
      .slice(0, 10)
      .map((s) => s.domain ?? s.url ?? "")
      .filter(Boolean)
      .join("、"),
    actualSource: source,
  });
  fields.set("similar_sites_visits", sites.map((s) => ({ domain: s.domain, totalVisits: s.totalVisits ?? null })), {
    display: sites
      .slice(0, 10)
      .map((s) => `${s.domain ?? "?"} ${fmtBig(s.totalVisits)}`)
      .join("；"),
    actualSource: source,
  });
  fields.set("similarity_score", sites.map((s) => ({ domain: s.domain, similarityScore: s.similarityScore ?? null })), {
    display: sites
      .slice(0, 10)
      .map((s) => `${s.domain ?? "?"} ${s.similarityScore != null ? `${(s.similarityScore * 100).toFixed(0)}%` : "-"}`)
      .join("；"),
    actualSource: source,
  });
}

/** AITDK 模式的密度结构可能是数组也可能是一层 map，都收 */
export function normalizeDensity(item: SimilarwebItem): { items: { term: string; count: number; density: number }[]; totalWords: number } {
  const totalWords = Number(item.keyword_density_total_words ?? 0);
  const raw = item.keyword_density;
  const items: { term: string; count: number; density: number }[] = [];

  if (Array.isArray(raw)) {
    for (const row of raw) {
      const term = String(row.keyword ?? "").trim();
      if (!term) continue;
      const density = Number(row.density ?? 0);
      items.push({
        term,
        count: Number(row.count ?? 0),
        density: density <= 1 ? Math.round(density * 10_000) / 100 : Math.round(density * 100) / 100,
      });
    }
  } else if (raw && typeof raw === "object") {
    for (const [term, v] of Object.entries(raw)) {
      const n = Number(v);
      if (!term || !Number.isFinite(n)) continue;
      items.push({ term, count: 0, density: n <= 1 ? Math.round(n * 10_000) / 100 : Math.round(n * 100) / 100 });
    }
  }
  return { items: items.slice(0, 12), totalWords: Number.isFinite(totalWords) ? totalWords : 0 };
}

/* ------------------------------ lergassy 映射 ------------------------------ */

const CHANNEL_RULES: { key: string; test: RegExp }[] = [
  { key: "paid_referrals_traffic", test: /paid referral|affiliate|联盟/i },
  { key: "display_ads_traffic", test: /display|banner|广告/i },
  { key: "search_paid_traffic", test: /paid search|paid search|sem\b|竞价/i },
  { key: "search_organic_traffic", test: /organic search|organic|自然搜索/i },
  { key: "search_traffic", test: /^search$|search traffic|搜索/i },
  { key: "direct_traffic", test: /direct|直接/i },
  { key: "mail_traffic", test: /mail|email|邮件/i },
  { key: "referral_traffic", test: /referral|引荐/i },
  { key: "social_traffic", test: /social|社交/i },
];

/**
 * 备选源补齐。
 *
 * 只补 lergassy 真有口径的字段：它的 trafficSources 里没有 AI 引荐这一类，
 * 所以 AI 那 6 个字段不会在这里被「补」成 0 —— 那会把「没有数据」伪装成「占比 0」。
 */
export function applyLergassy(fields: FieldBag, item: LergassyItem): void {
  const source = "lergassy Similarweb（备选）";
  const history = normalizeHistory(item.monthlyVisitsHistory);

  fillNum(fields, "monthly_visits", item.monthlyVisits, { actualSource: source });
  if (history.length) {
    fill(fields, "monthly_visits_history", history, {
      display: history
        .slice(-6)
        .map((h) => `${h.month} ${fmtBig(h.visits)}`)
        .join("；"),
      actualSource: source,
    });
  }
  fillNum(fields, "rank_global", item.globalRank, { actualSource: source });
  fillNum(fields, "country_rank", item.countryRank, { actualSource: source });

  const topCountry = item.topCountries?.[0];
  if (topCountry?.countryCode) {
    fill(fields, "country", topCountry.countryCode, { actualSource: `${source} topCountries[0]` });
  }
  if (item.topCountries?.length) {
    fill(fields, "traffic_by_country", item.topCountries, {
      display: item.topCountries
        .slice(0, 8)
        .map((c) => `${c.countryCode ?? "?"} ${fmtPct(c.share)}`)
        .join("；"),
      actualSource: source,
    });
  }

  if (topCountry?.countryCode) {
    // countryRank 的口径是「该国排名」，缺国家时补上国家更有意义
    fill(fields, "country", topCountry.countryCode, { actualSource: source });
  }

  if (item.bounceRate != null) {
    fill(fields, "bounce_rate", item.bounceRate, { display: fmtPct(item.bounceRate), actualSource: source });
  }
  fillNum(fields, "pages_per_visit", item.pagesPerVisit, { actualSource: source });
  if (item.avgVisitDurationSeconds != null) {
    fill(fields, "time_on_site", item.avgVisitDurationSeconds, {
      display: fmtDuration(item.avgVisitDurationSeconds),
      actualSource: source,
    });
  } else if (item.avgVisitDuration) {
    fill(fields, "time_on_site", item.avgVisitDuration, { actualSource: source });
  }

  const mom = item.monthlyVisitsChange ?? growth(history, 1);
  if (mom != null) fill(fields, "visits_mom", mom, { display: fmtSignedPct(mom), actualSource: source });
  const g3m = growth(history, 3);
  if (g3m != null) fill(fields, "visits_growth_3m", g3m, { display: fmtSignedPct(g3m), actualSource: source });

  for (const ch of item.trafficSources ?? []) {
    const raw = (ch.source ?? "").trim();
    if (!raw || ch.share == null) continue;
    const rule = CHANNEL_RULES.find((r) => r.test.test(raw));
    if (!rule) continue;
    fill(fields, rule.key, ch.share, { display: fmtPct(ch.share), actualSource: `${source} ${raw}` });
  }

  const organic = item.trafficSources?.find((c) => /organic/i.test(c.source ?? "") && c.share != null);
  const paid = item.trafficSources?.find((c) => /paid search/i.test(c.source ?? "") && c.share != null);
  if (organic?.share != null || paid?.share != null) {
    const total = (organic?.share ?? 0) + (paid?.share ?? 0);
    fill(fields, "search_traffic", total, {
      display: fmtPct(total),
      actualSource: `${source}（自然+付费搜索汇总）`,
    });
  }

  if (item.topKeywords?.length) {
    applyKeywordList(
      fields,
      item.topKeywords.map((k) => ({ keyword: k.keyword ?? "", volume: k.volume ?? undefined, cpc: k.cpc ?? undefined })),
      source,
    );
  }

  if (item.similarSites?.length) {
    fill(fields, "similar_sites", item.similarSites.map((s) => s.domain).filter(Boolean), {
      display: item.similarSites.map((s) => s.domain).filter(Boolean).slice(0, 10).join("、"),
      actualSource: source,
    });
    fill(fields, "similar_sites_visits", item.similarSites.map((s) => ({ domain: s.domain, categoryRank: s.categoryRank ?? null })), {
      display: item.similarSites
        .slice(0, 10)
        .map((s) => `${s.domain ?? "?"} 行业排名 ${s.categoryRank ?? "-"}`)
        .join("；"),
      actualSource: source,
      note: "备选源不返回相似站访问量，只有行业排名",
    });
    fill(
      fields,
      "similarity_score",
      item.similarSites.map((s) => ({ domain: s.domain, affinity: s.affinity ?? null })),
      {
        display: item.similarSites
          .slice(0, 10)
          .map((s) => `${s.domain ?? "?"} ${s.affinity != null ? `${(s.affinity * 100).toFixed(0)}%` : "-"}`)
          .join("；"),
        actualSource: `${source} affinity`,
        note: "备选源的 affinity 口径与 Similarweb similarityScore 不完全等价",
      },
    );
    const cat = item.similarSites.find((s) => s.category)?.category;
    if (cat) fill(fields, "similarweb_category", cat, { actualSource: `${source} similarSites[].category` });
    const catRank = item.similarSites.find((s) => s.categoryRank)?.categoryRank;
    if (catRank != null) fillNum(fields, "category_rank", catRank, { actualSource: source });
  }
}

interface KeywordRow {
  keyword: string;
  volume?: number;
  cpc?: number;
  value?: number | null;
}

function applyKeywordList(fields: FieldBag, rows: KeywordRow[], source: string): void {
  const clean = rows.filter((r) => r.keyword);
  if (!clean.length) return;

  fields.set("top_keywords", clean.map((r) => r.keyword), {
    display: clean.slice(0, 10).map((r) => r.keyword).join("、"),
    actualSource: source,
  });
  fields.set("keyword_search_volume", clean.map((r) => ({ keyword: r.keyword, searchVolume: r.volume ?? null })), {
    display: clean.slice(0, 10).map((r) => `${r.keyword} ${fmtBig(r.volume)}`).join("；"),
    actualSource: source,
  });

  const cpcRows = clean.filter((r) => r.cpc != null);
  if (cpcRows.length) {
    fields.set("keyword_cpc", cpcRows.map((r) => ({ keyword: r.keyword, cpc: r.cpc })), {
      display: cpcRows.slice(0, 10).map((r) => `${r.keyword} $${r.cpc}`).join("；"),
      actualSource: source,
    });
  }

  const valueRows = clean.filter((r) => r.value != null);
  if (valueRows.length) {
    fields.set("keyword_value", valueRows.map((r) => ({ keyword: r.keyword, estimatedValue: r.value })), {
      display: valueRows.slice(0, 10).map((r) => `${r.keyword} $${r.value}`).join("；"),
      actualSource: source,
    });
  } else {
    fields.missing("keyword_value", "该来源不返回关键词流量价值（estimatedValue）");
  }
}

/* --------------------------------- SERP --------------------------------- */

export function queryOf(page: SerpPage): string {
  const q = page.searchQuery;
  if (typeof q === "string") return q;
  return q?.term ?? "";
}

/** 拿前 N 个关键词做排名采样（SERP 按 query 计费，全量跑不现实） */
export function pickSampleKeywords(fields: FieldBag, n: number): string[] {
  const list = fields.get("top_keywords");
  if (!Array.isArray(list)) return [];
  return (list as unknown[]).filter((k): k is string => typeof k === "string").slice(0, n);
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export function applySerpKeywordFields(fields: FieldBag, pages: SerpPage[], domain: string): void {
  const ranks: { keyword: string; position: number | null }[] = [];
  const titles: { keyword: string; title: string | null }[] = [];
  const urls: { keyword: string; url: string | null }[] = [];

  for (const page of pages) {
    const query = queryOf(page);
    if (!query || /launch date/i.test(query)) continue;
    const results = page.organicResults ?? [];
    const hit = results.find((r) => r.url && hostOf(r.url) === domain);
    ranks.push({ keyword: query, position: hit?.position ?? null });
    titles.push({ keyword: query, title: hit?.title ?? null });
    urls.push({ keyword: query, url: hit?.url ?? null });
  }

  if (!ranks.length) {
    for (const key of ["keyword_rank", "serp_title", "serp_url", "top10_count", "top20_count"]) {
      fields.missing(key, "SERP 无可用结果");
    }
    return;
  }

  fields.set("keyword_rank", ranks, {
    display: ranks.map((r) => `${r.keyword} ${r.position ? `#${r.position}` : "未进前 20"}`).join("；"),
    actualSource: "Apify Google Search Scraper",
    note: `采样 ${ranks.length} 个关键词，每词只取首屏 20 条`,
  });

  const titled = titles.filter((t) => t.title);
  if (titled.length) {
    fields.set("serp_title", titled, {
      display: titled.map((t) => t.title).join("；"),
      actualSource: "Apify Google Search Scraper",
    });
  }
  const urled = urls.filter((u) => u.url);
  if (urled.length) {
    fields.set("serp_url", urled, {
      display: urled.map((u) => u.url).join("；"),
      actualSource: "Apify Google Search Scraper",
    });
  }

  const positions = ranks.map((r) => r.position).filter((p): p is number => typeof p === "number");
  fields.set("top10_count", positions.filter((p) => p <= 10).length, {
    actualSource: "SERP 结果统计",
    note: `基于 ${ranks.length} 个采样关键词`,
  });
  fields.set("top20_count", positions.filter((p) => p <= 20).length, {
    actualSource: "SERP 结果统计",
    note: `基于 ${ranks.length} 个采样关键词（首屏 20 条）`,
  });
}

/** 从 SERP 结果里的 published date 反推发布日（只作证据之一，优先级低于官网 JSON-LD） */
export function applySerpReleaseDate(fields: FieldBag, pages: SerpPage[], launchQuery: string): void {
  const dates: string[] = [];
  for (const page of pages) {
    const q = queryOf(page);
    if (q !== launchQuery) continue;
    for (const r of page.organicResults ?? []) {
      const d = normalizeDate(r.date) ?? findDateInText(`${r.title ?? ""} ${r.description ?? ""}`);
      if (d) dates.push(d);
    }
  }
  if (!dates.length) {
    fields.missing("release_date", "SERP 结果里没有可解析的发布日期");
    return;
  }
  const earliest = dates.sort()[0];
  fields.set("release_date", earliest, {
    actualSource: "Apify Google Search Scraper（公告/报道发布日期）",
    note: `命中 ${dates.length} 个日期，取最早；口径为「相关文章发布时间」，需人工复核`,
  });
}

function normalizeDate(v: string | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isFinite(t) && t > Date.parse("2000-01-01")) return new Date(t).toISOString().slice(0, 10);
  return null;
}

const MONTHS = "Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

function findDateInText(text: string): string | null {
  const iso = /\b(20[0-2]\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/.exec(text);
  if (iso) return iso[0];
  const long = new RegExp(`\\b(${MONTHS})[a-z]*\\s+(\\d{1,2}),?\\s+(20[0-2]\\d)\\b`, "i").exec(text);
  if (long) {
    const t = Date.parse(`${long[1]} ${long[2]}, ${long[3]}`);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

/** 官网 JSON-LD / meta 里的发布日（在 site 阶段就能拿到，优先于 SERP） */
export function pickOfficialDate(dates: string[]): string | null {
  const normalized = dates.map((d) => normalizeDate(d)).filter((d): d is string => !!d).sort();
  return normalized[0] ?? null;
}