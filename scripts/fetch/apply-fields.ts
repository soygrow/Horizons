/**
 * 采集结果（73 字段）→ AITool 的唯一映射。
 *
 * 纯函数：不读库、不发请求，`history` 由调用方从 `traffic_history` 读好传进来。
 *
 * 边界：**只写事实字段**（流量 / 排名 / 渠道 / 互动 / SEO 排名 / 上线时间 / 溯源），
 * 不写解读字段（description / categories / segmentLabel / tagGroups / insight）。
 * 那些由 LLM 富化负责 —— 混写会让同一格出现两个数，而且谁最后跑谁赢，
 * 排查时根本分不清哪个是真数据。
 */
import type {
  AITool,
  AiTraffic,
  ChannelKey,
  FieldSource,
  GeoItem,
  KeywordItem,
  PricingModel,
  SerpSample,
  TrafficTrendPoint,
} from "@horizons/shared";
import type { CollectPayload } from "../field-collect/index";

export interface ApplyFieldsOptions {
  /** 采集日期 YYYY-MM-DD，写进 sources.at；缺省用 payload.collectedAt */
  at?: string;
  /** Similarweb 快照月份 YYYY-MM，写进 sources.period */
  period?: string;
  /**
   * 近 6 个月访问量（`readTrafficMonths()` 的结果，含补 0 的月份）。
   * `collected` 会原样带到 `trend[].collected`：补的 0 必须能被前端识别出来，
   * 否则趋势图会画出一条「掉到 0」的假断崖。
   * 不传则退回 payload 里的 3 个月（都是有数的月份）。
   */
  history?: { month: string; visits: number; collected?: boolean }[];
}

export interface ApplyFieldsResult {
  /** 实际写入的字段路径，便于日志与后台审计 */
  written: string[];
  /** 有值但按规则没写（目标已有更可靠来源） */
  skipped: string[];
}

/** 取值为正值才写：0 和 null 在页面上含义不同，不该混为一谈 */
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const pctOf = (total: number | undefined, pct: number | undefined) =>
  total !== undefined && pct !== undefined ? Math.round((total * pct) / 100) : undefined;

/** Similarweb 渠道字段 → 页面 10 渠道 key（只映射原子项，汇总项不参与，避免重复计数） */
const CHANNEL_MAP: [string, ChannelKey][] = [
  ["direct_traffic", "direct"],
  ["search_organic_traffic", "organicSearch"],
  ["referral_traffic", "referral"],
  ["display_ads_traffic", "displayAds"],
  ["mail_traffic", "email"],
  ["paid_referrals_traffic", "affiliates"],
  ["search_paid_traffic", "paidSearch"],
  ["gen_ai_traffic", "aiAssistants"],
  // social_traffic 是 Similarweb 的「社交（自然+付费）」合计；没有拆分字段时只能放这里
  ["social_traffic", "organicSocial"],
];

export function applyFields(
  tool: AITool,
  payload: CollectPayload,
  opts: ApplyFieldsOptions = {},
): ApplyFieldsResult {
  const at = (opts.at ?? payload.collectedAt ?? new Date().toISOString()).slice(0, 10);
  const written: string[] = [];
  const skipped: string[] = [];

  const bag = new Map<string, unknown>();
  for (const f of payload.fields) if (f.status === "ok") bag.set(f.key, f.value);

  const num = (k: string): number | undefined => {
    const v = bag.get(k);
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const str = (k: string): string | undefined => {
    const v = bag.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  const arr = <T>(k: string): T[] | undefined => {
    const v = bag.get(k);
    return Array.isArray(v) ? (v as T[]) : undefined;
  };

  const sources: Record<string, FieldSource> = { ...(tool.sources ?? {}) };
  const mark = (path: string, from: string, period?: string) => {
    written.push(path);
    sources[path] = { from, at, ...(period ? { period } : {}) };
  };

  const visits = num("monthly_visits");
  const organicShare = num("search_organic_traffic");

  /* ------------------------------ 01 概览指标 ------------------------------ */
  tool.metrics ??= {};
  if (visits !== undefined) {
    tool.metrics.monthlyVisits = visits;
    mark("metrics.monthlyVisits", "vortex_base", opts.period);
  }

  // 环比自己算（基于月度序列），不取 vortex 的 monthlyVisitsChange：
  // 那个字段偶尔给的是「倍数」而不是百分比，直接当 % 显示会错两个数量级
  const mom = num("visits_mom");
  if (mom !== undefined) {
    tool.metrics.momGrowth = round1(mom);
    mark("metrics.momGrowth", "vortex_base（月度序列自算）", opts.period);
  }

  if (organicShare !== undefined) {
    tool.metrics.organicShare = round1(organicShare);
    const ov = pctOf(visits, organicShare);
    if (ov !== undefined) tool.metrics.organicVisits = ov;
    mark("metrics.organicShare", "vortex_base", opts.period);
  }

  /*
   * 所属国家：`country` 是 vortex 的顶层单值字段，很多站只给
   * `website_traffic_by_country` 数组而不给单值 —— 只看 country 会让
   * 「所属国家」这一格在数据齐全的情况下也恒为空。数组里占比最高的那项
   * 就是同一个语义，作为回退源。
   */
  const geo = arr<{ country?: string; countryName?: string; share?: number }>("traffic_by_country");
  const country = str("country") ?? geo?.[0]?.country;
  if (country) {
    tool.metrics.country = country.toUpperCase();
    const name = geo?.find((g) => (g.country ?? "").toUpperCase() === country.toUpperCase())?.countryName;
    if (name) tool.metrics.countryName = name;
    mark("metrics.country", "vortex_base", opts.period);
  }

  /*
   * 01 的 8 指标读的是 trafficMetrics，不是 metrics —— 两套字段一直并存，
   * 只写一套会让「概览卡有数、产品表现卡空着」。这里同步写，保持同一份来源。
   */
  if (visits !== undefined) {
    tool.trafficMetrics = {
      ...(tool.trafficMetrics ?? {}),
      monthlyVisits: visits,
      ...(mom !== undefined ? { monthlyVisitsGrowth: round1(mom) } : {}),
      ...(organicShare !== undefined && pctOf(visits, organicShare) !== undefined
        ? { organicSearchVisits: pctOf(visits, organicShare)! }
        : {}),
      ...(num("direct_traffic") !== undefined && pctOf(visits, num("direct_traffic")) !== undefined
        ? { directVisits: pctOf(visits, num("direct_traffic"))! }
        : {}),
      ...(num("referral_traffic") !== undefined && pctOf(visits, num("referral_traffic")) !== undefined
        ? { referralVisits: pctOf(visits, num("referral_traffic"))! }
        : {}),
      ...(num("social_traffic") !== undefined && pctOf(visits, num("social_traffic")) !== undefined
        ? { socialVisits: pctOf(visits, num("social_traffic"))! }
        : {}),
      ...(num("time_on_site") !== undefined ? { avgVisitDurationSec: Math.round(num("time_on_site")!) } : {}),
      // 月浏览量：vortex 不给这个字段，用「访问量 × 页均访问」推算 ——
      // trafficMetrics 里定义了却没有生产者，页面就会显示「—」。
      ...(num("pages_per_visit") !== undefined
        ? { monthlyPageviews: Math.round(visits * num("pages_per_visit")!) }
        : {}),
      ...(opts.period ? { snapshotMonth: opts.period } : {}),
    };
    mark("trafficMetrics", "vortex_base", opts.period);
  }

  // 注册时间只补空：人工校正过的值比 WHOIS 可靠
  const registeredAt = str("domain_registered_at");
  if (registeredAt) {
    if (tool.metrics.registeredAt) skipped.push("metrics.registeredAt");
    else {
      tool.metrics.registeredAt = registeredAt.slice(0, 10);
      mark("metrics.registeredAt", "whois");
    }
  }

  /* ------------------------------- 排名 ------------------------------- */
  tool.ranks ??= {};
  const g = num("rank_global");
  const c = num("country_rank");
  const cat = num("category_rank");
  if (g !== undefined) {
    tool.ranks.global = g;
    mark("ranks.global", "vortex_base", opts.period);
  }
  if (c !== undefined) {
    tool.ranks.country = c;
    mark("ranks.country", "vortex_base", opts.period);
  }
  if (cat !== undefined) {
    tool.ranks.category = cat;
    mark("ranks.category", "vortex_base", opts.period);
  }

  /* ------------------------------ 互动指标 ------------------------------ */
  const bounce = num("bounce_rate");
  const ppv = num("pages_per_visit");
  const dur = num("time_on_site");
  if (bounce !== undefined || ppv !== undefined || dur !== undefined) {
    tool.engagement ??= {};
    if (bounce !== undefined) tool.engagement.bounceRate = round1(bounce);
    if (ppv !== undefined) tool.engagement.pagesPerVisit = round2(ppv);
    if (dur !== undefined) tool.engagement.durationSec = Math.round(dur);
    mark("engagement", "vortex_base", opts.period);
  }

  /* ------------------------------ 渠道结构 ------------------------------ */
  const shares: Partial<Record<ChannelKey, number>> = {};
  for (const [fieldKey, channel] of CHANNEL_MAP) {
    const v = num(fieldKey);
    if (v !== undefined) shares[channel] = round2(v);
  }
  if (Object.keys(shares).length) {
    tool.channelShares = { ...(tool.channelShares ?? {}), ...shares };
    mark("channelShares", "vortex_base", opts.period);
  }

  /* ------------------------------ 流量趋势 ------------------------------ */
  const hist =
    opts.history ??
    arr<{ month: string; visits: number; collected?: boolean }>("monthly_visits_history") ??
    [];
  if (hist.length) {
    // organic 是「用当前自然搜索占比反推每个月」的近似值：vortex 不给逐月渠道。
    // 图例上要写清是推算，否则会被当成实测。
    tool.trend = hist.slice(-6).map<TrafficTrendPoint>((m) => ({
      date: m.month,
      total: m.visits,
      organic: pctOf(m.visits, organicShare) ?? 0,
      // 缺省视为有值：老数据没有这个标记，不能因此被当成「未累积」而整段隐藏
      collected: m.collected !== false,
    }));
    mark("trend", "traffic_history", opts.period);
  }

  /* ------------------------------ 地域分布 ------------------------------ */
  if (geo?.length) {
    tool.geoDistribution = geo
      .filter((x): x is { country: string; share: number } =>
        Boolean(x.country) && typeof x.share === "number",
      )
      .map<GeoItem>((x) => ({ country: x.country, share: round2(x.share) }));
    mark("geoDistribution", "vortex_base", opts.period);
  }

  /* ------------------------------ 关键词 ------------------------------ */
  const kws = arr<{ keyword?: string; volume?: number; cpc?: number; value?: number }>("top_keywords");
  if (kws?.length) {
    tool.keywords = kws
      .filter((k): k is { keyword: string } & typeof k => Boolean(k.keyword))
      .map<KeywordItem>((k) => ({
        term: k.keyword,
        ...(typeof k.volume === "number" ? { volume: k.volume } : {}),
        // cpc 在 vortex 里恒为 null，不写这个键，前端就不会渲染空列
        ...(typeof k.cpc === "number" ? { cpc: k.cpc } : {}),
      }));
    mark("keywords", "vortex_base", opts.period);
  }

  /* --------------------------- 搜索与排名（SERP） --------------------------- */
  const ranks = arr<{ keyword: string; position: number | null }>("keyword_rank");
  if (ranks?.length) {
    const titles = new Map(
      (arr<{ keyword: string; title: string | null }>("serp_title") ?? []).map((t) => [t.keyword, t.title]),
    );
    const urls = new Map(
      (arr<{ keyword: string; url: string | null }>("serp_url") ?? []).map((u) => [u.keyword, u.url]),
    );
    const vols = new Map((kws ?? []).map((k) => [k.keyword, k.volume]));

    tool.seoStanding = {
      samples: ranks.map<SerpSample>((r) => ({
        term: r.keyword,
        ...(typeof r.position === "number" ? { position: r.position } : {}),
        ...(titles.get(r.keyword) ? { title: titles.get(r.keyword)! } : {}),
        ...(urls.get(r.keyword) ? { url: urls.get(r.keyword)! } : {}),
        ...(typeof vols.get(r.keyword) === "number" ? { volume: vols.get(r.keyword)! } : {}),
      })),
      top10: num("top10_count") ?? 0,
      top20: num("top20_count") ?? 0,
      sampledAt: at,
    };
    mark("seoStanding", "serp");
  }

  /* ------------------------------ AI 引荐 ------------------------------ */
  /*
   * `gen_ai_traffic` 是占比，`ai_traffic_visits` 是绝对量。vortex 有时只给
   * 后者（或只给前者），只读占比会让整块 AI 引荐在数据存在时也不显示。
   * 两者互为回退：缺占比就用访问量 ÷ 总访问量反算。
   */
  const aiShare = num("gen_ai_traffic");
  const aiVisitCount = num("ai_traffic_visits");
  const aiShareResolved =
    aiShare ?? (aiVisitCount !== undefined && visits ? (aiVisitCount / visits) * 100 : undefined);
  if (aiShareResolved !== undefined) {
    const ai: AiTraffic = { share: round2(aiShareResolved) };
    const aiVisits = aiVisitCount ?? pctOf(visits, aiShareResolved);
    if (aiVisits !== undefined) ai.visits = aiVisits;
    const chatgpt = num("ai_chatgpt_share");
    const claude = num("ai_claude_share");
    const gemini = num("ai_gemini_share");
    const perplexity = num("ai_perplexity_share");
    if (chatgpt !== undefined) ai.chatgpt = round2(chatgpt);
    if (claude !== undefined) ai.claude = round2(claude);
    if (gemini !== undefined) ai.gemini = round2(gemini);
    if (perplexity !== undefined) ai.perplexity = round2(perplexity);
    tool.aiTraffic = ai;
    mark("aiTraffic", "vortex_base", opts.period);
  }

  /* ------------------------------ 上线时间 ------------------------------ */
  const launchedAt = str("launch_date");
  const confidence = str("launch_confidence");
  if (launchedAt) {
    if (tool.launchedAt) skipped.push("launchedAt");
    else {
      tool.launchedAt = launchedAt.slice(0, 10);
      mark("launchedAt", "多来源推算");
    }
  }
  if (confidence === "高" || confidence === "中" || confidence === "低") {
    tool.launchConfidence = confidence;
    mark("launchConfidence", "多来源推算");
  }

  /* ------------------------------ 功能特性 ------------------------------ */
  /*
   * 官网抓到的功能词是事实数据，Hero 的标签区却只认 LLM 写的 featureTags。
   * LLM 没跑或没产出时这块就是空的，所以这里只补空、不覆盖 ——
   * 解读字段的优先级仍然是 LLM 更高。
   */
  const features = arr<string>("features");
  if (features?.length && !tool.featureTags?.length) {
    const tags = features.filter((f) => typeof f === "string" && f.trim()).slice(0, 8);
    if (tags.length) {
      tool.featureTags = tags;
      mark("featureTags", "官网功能词");
    }
  }

  /* ------------------------------ 竞品 / 定价 ------------------------------ */
  const pricingModel = str("pricing_model");
  if (pricingModel && !tool.pricingModel) {
    const normalized = pricingModel.toLowerCase();
    if (normalized === "free" || normalized === "freemium" || normalized === "paid") {
      tool.pricingModel = normalized as PricingModel;
      mark("pricingModel", "官网定价页");
    }
  }

  const stars = num("github_stars");
  if (stars !== undefined && tool.githubStars == null) {
    tool.githubStars = stars;
    mark("githubStars", "github");
  }

  tool.sources = sources;
  return { written: [...new Set(written)], skipped };
}