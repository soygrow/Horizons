/**
 * 字段清单：docs/18-AI工具字段采集方案.md 第 1~6 节的逐字段抄录。
 *
 * 这里是「对表」的唯一依据：采集脚本往里写值，展示页按这份顺序渲染，
 * 覆盖率的分子分母也来自这里。任何字段名/口径要和文档一致，不要在这里改名，
 * 否则「采全了吗」这个问题会变得无法回答。
 *
 * 与项目里其他采集模块无关：不读 content/*.json，不写 aitools，
 * 只服务「单个网站能不能把这 72 个字段采到」这一个验证目标。
 */

export type GroupKey = "basic" | "launch" | "traffic" | "channels" | "seo" | "product";

export const GROUPS: { key: GroupKey; name: string }[] = [
  { key: "basic", name: "1. 网站基本信息" },
  { key: "launch", name: "2. 产品上线时间" },
  { key: "traffic", name: "3. 网站流量数据" },
  { key: "channels", name: "4. 流量来源及 AI 流量" },
  { key: "seo", name: "5. SEO 与关键词数据" },
  { key: "product", name: "6. 产品信息与竞争力数据" },
];

export interface FieldDef {
  key: string;
  label: string;
  group: GroupKey;
  /** 文档「获取方式」列 */
  method: string;
  /** 文档「接口返回字段名」列 */
  api: string;
  paid: boolean;
}

const SITE = "目标网站";
const APIFY = "Apify Similarweb";

export const FIELDS: FieldDef[] = [
  /* ------------------------------ 1. 基本信息 ------------------------------ */
  { key: "name", label: "网站名称", group: "basic", method: `${SITE} / ${APIFY}`, api: "title", paid: true },
  { key: "description", label: "网站介绍", group: "basic", method: `${SITE} / ${APIFY}`, api: "description", paid: true },
  { key: "domain", label: "网站域名", group: "basic", method: "官网 URL 解析", api: "自行解析 hostname", paid: false },
  { key: "favicon", label: "网站图标", group: "basic", method: "请求官网 HTML", api: "link[rel*=icon]", paid: false },
  { key: "http_status", label: "网站状态", group: "basic", method: "HTTP 请求检测", api: "status_code", paid: false },
  { key: "language", label: "网站语言", group: "basic", method: "解析 HTML", api: "html[lang]", paid: false },
  { key: "category", label: "AI 工具分类", group: "basic", method: "解析官网内容后分类", api: "自行提取 category", paid: false },
  { key: "features", label: "核心功能", group: "basic", method: "解析首页和产品介绍", api: "自行提取 features", paid: false },
  { key: "target_audience", label: "目标用户", group: "basic", method: "解析官网内容", api: "自行提取 target_audience", paid: false },

  /* ------------------------------ 2. 上线时间 ------------------------------ */
  { key: "wayback_first_timestamp", label: "最早网页存档时间", group: "launch", method: "Wayback CDX API", api: "timestamp", paid: false },
  { key: "wayback_first_url", label: "最早网页地址", group: "launch", method: "Wayback CDX API", api: "original", paid: false },
  { key: "wayback_first_status", label: "最早有效网页状态", group: "launch", method: "Wayback CDX API", api: "statuscode", paid: false },
  { key: "commoncrawl_first_timestamp", label: "最早历史抓取时间", group: "launch", method: "Common Crawl Index API", api: "timestamp", paid: false },
  { key: "ssl_first_seen", label: "最早 SSL 证书时间", group: "launch", method: "crt.sh / crt.live API", api: "not_before / first_seen", paid: false },
  { key: "release_date", label: "产品正式发布日", group: "launch", method: "Apify Google Search Scraper + 原始页面 datePublished", api: "datePublished / dateCreated", paid: true },
  { key: "github_created_at", label: "GitHub 项目创建时间", group: "launch", method: "GitHub REST API", api: "created_at", paid: false },
  { key: "launch_date", label: "产品上线日期", group: "launch", method: "多来源综合推算", api: "自行生成 launch_date", paid: false },
  { key: "launch_confidence", label: "上线日期可信度", group: "launch", method: "证据来源与一致性评分", api: "自行生成 launch_confidence", paid: false },

  /* ------------------------------ 3. 流量数据 ------------------------------ */
  { key: "monthly_visits", label: "月访问量", group: "traffic", method: APIFY, api: "totalVisits", paid: true },
  { key: "monthly_visits_history", label: "历史月访问量", group: "traffic", method: APIFY, api: "monthlyVisits", paid: true },
  { key: "rank_global", label: "全球排名", group: "traffic", method: APIFY, api: "rankGlobal", paid: true },
  { key: "country_rank", label: "国家排名", group: "traffic", method: APIFY, api: "countryRank", paid: true },
  { key: "country", label: "所属国家", group: "traffic", method: APIFY, api: "country", paid: true },
  { key: "similarweb_category", label: "行业分类", group: "traffic", method: APIFY, api: "category", paid: true },
  { key: "category_rank", label: "行业排名", group: "traffic", method: APIFY, api: "categoryRank", paid: true },
  { key: "bounce_rate", label: "跳出率", group: "traffic", method: APIFY, api: "bounceRate", paid: true },
  { key: "pages_per_visit", label: "平均访问页面数", group: "traffic", method: APIFY, api: "pagesPerVisit", paid: true },
  { key: "time_on_site", label: "平均访问时长", group: "traffic", method: APIFY, api: "timeOnSite", paid: true },
  { key: "visits_mom", label: "访问量环比", group: "traffic", method: "根据历史月访问量计算", api: "自行计算", paid: true },
  { key: "visits_growth_3m", label: "访问量三个月增长率", group: "traffic", method: "根据历史月访问量计算", api: "自行计算", paid: true },

  /* --------------------------- 4. 流量来源及 AI 流量 --------------------------- */
  { key: "direct_traffic", label: "直接访问占比", group: "channels", method: APIFY, api: "directTraffic", paid: true },
  { key: "search_organic_traffic", label: "自然搜索占比", group: "channels", method: APIFY, api: "searchOrganicTraffic", paid: true },
  { key: "search_paid_traffic", label: "付费搜索占比", group: "channels", method: APIFY, api: "searchPaidTraffic", paid: true },
  { key: "search_traffic", label: "搜索总流量占比", group: "channels", method: APIFY, api: "searchTraffic", paid: true },
  { key: "referral_traffic", label: "引荐流量占比", group: "channels", method: APIFY, api: "referralTraffic", paid: true },
  { key: "social_traffic", label: "社交流量占比", group: "channels", method: APIFY, api: "socialTraffic", paid: true },
  { key: "display_ads_traffic", label: "展示广告占比", group: "channels", method: APIFY, api: "displayAdsTraffic", paid: true },
  { key: "mail_traffic", label: "邮件流量占比", group: "channels", method: APIFY, api: "mailTraffic", paid: true },
  { key: "paid_referrals_traffic", label: "联盟推广流量占比", group: "channels", method: APIFY, api: "paidReferralsTraffic", paid: true },
  { key: "ai_traffic_visits", label: "AI 引荐访问量", group: "channels", method: APIFY, api: "aiTrafficVisits", paid: true },
  { key: "gen_ai_traffic", label: "AI 引荐流量占比", group: "channels", method: APIFY, api: "genAiTraffic / aiReferralTraffic", paid: true },
  { key: "ai_chatgpt_share", label: "ChatGPT 流量占比", group: "channels", method: APIFY, api: "aiTrafficShareChatgpt", paid: true },
  { key: "ai_claude_share", label: "Claude 流量占比", group: "channels", method: APIFY, api: "aiTrafficShareClaude", paid: true },
  { key: "ai_gemini_share", label: "Gemini 流量占比", group: "channels", method: APIFY, api: "aiTrafficShareGemini", paid: true },
  { key: "ai_perplexity_share", label: "Perplexity 流量占比", group: "channels", method: APIFY, api: "aiTrafficSharePerplexity", paid: true },
  { key: "ai_traffic_sources", label: "AI 来源明细", group: "channels", method: APIFY, api: "aiTrafficSources", paid: true },
  { key: "traffic_by_country", label: "国家流量分布", group: "channels", method: APIFY, api: "website_traffic_by_country", paid: true },

  /* ------------------------------ 5. SEO 与关键词 ------------------------------ */
  { key: "top_keywords", label: "头部自然搜索关键词", group: "seo", method: APIFY, api: "topKeywords[].keyword", paid: true },
  { key: "keyword_search_volume", label: "关键词搜索量", group: "seo", method: APIFY, api: "topKeywords[].searchVolume", paid: true },
  { key: "keyword_cpc", label: "关键词 CPC", group: "seo", method: APIFY, api: "topKeywords[].cpc", paid: true },
  { key: "keyword_value", label: "关键词流量价值", group: "seo", method: APIFY, api: "topKeywords[].estimatedValue", paid: true },
  { key: "keyword_rank", label: "关键词搜索排名", group: "seo", method: "Apify Google Search Scraper", api: "organicResults[].position", paid: true },
  { key: "serp_title", label: "搜索结果标题", group: "seo", method: "Apify Google Search Scraper", api: "organicResults[].title", paid: true },
  { key: "serp_url", label: "搜索结果链接", group: "seo", method: "Apify Google Search Scraper", api: "organicResults[].url", paid: true },
  { key: "top10_count", label: "TOP 10 关键词数量", group: "seo", method: "根据 SERP 结果统计", api: "自行计算", paid: true },
  { key: "top20_count", label: "TOP 20 关键词数量", group: "seo", method: "根据 SERP 结果统计", api: "自行计算", paid: true },

  /* ------------------------- 6. 产品信息与竞争力 ------------------------- */
  { key: "pricing_model", label: "定价模式", group: "product", method: "抓取官网 Pricing 页面", api: "自行解析 pricing_model", paid: false },
  { key: "has_free_plan", label: "是否提供免费版", group: "product", method: "抓取官网 Pricing 页面", api: "自行解析 has_free_plan", paid: false },
  { key: "has_free_trial", label: "是否提供免费试用", group: "product", method: "抓取官网 Pricing 页面", api: "自行解析 has_free_trial", paid: false },
  { key: "starting_price", label: "起步价格", group: "product", method: "抓取官网 Pricing 页面", api: "自行解析 starting_price", paid: false },
  { key: "currency", label: "价格币种", group: "product", method: "抓取官网 Pricing 页面", api: "自行解析 currency", paid: false },
  { key: "has_api", label: "是否提供 API", group: "product", method: "抓取官网文档、API 页面", api: "自行解析 has_api", paid: false },
  { key: "has_open_source", label: "是否开源", group: "product", method: "官网链接识别 + GitHub API", api: "自行生成 has_open_source", paid: false },
  { key: "github_stars", label: "GitHub Stars", group: "product", method: "GitHub REST API", api: "stargazers_count", paid: false },
  { key: "github_forks", label: "GitHub Forks", group: "product", method: "GitHub REST API", api: "forks_count", paid: false },
  { key: "github_pushed_at", label: "GitHub 最近更新时间", group: "product", method: "GitHub REST API", api: "pushed_at", paid: false },
  { key: "github_repo", label: "GitHub 仓库地址", group: "product", method: "官网链接识别 / GitHub API", api: "html_url", paid: false },
  { key: "keyword_density", label: "首页关键词密度", group: "product", method: "Similarweb AITDK 模式 / 本地解析", api: "keyword_density", paid: true },
  { key: "keyword_density_total_words", label: "首页文本总词数", group: "product", method: "Similarweb AITDK 模式 / 本地解析", api: "keyword_density_total_words", paid: true },
  { key: "similar_sites", label: "相似网站", group: "product", method: "Similarweb similar_sites 模式", api: "similar_sites", paid: true },
  { key: "similar_sites_visits", label: "相似网站访问量", group: "product", method: "Similarweb similar_sites 模式", api: "similar_sites[].totalVisits", paid: true },
  { key: "similarity_score", label: "相似度", group: "product", method: "Similarweb similar_sites 模式", api: "similar_sites[].similarityScore", paid: true },
];

export type FieldStatus = "ok" | "missing" | "error";

export interface FieldResult {
  key: string;
  label: string;
  group: GroupKey;
  method: string;
  api: string;
  paid: boolean;
  value: unknown;
  display: string;
  status: FieldStatus;
  /** 实际拿到数据的来源（可能与文档来源不同，比如走的是备选 Actor） */
  actualSource?: string;
  note?: string;
}

interface Slot {
  value: unknown;
  display?: string;
  actualSource?: string;
  note?: string;
  error?: boolean;
}

/** 空值判定：null / undefined / 空数组 / 空字符串 都算没采到（文档要求存 NULL，不填 0） */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/** 默认展示串：数组/对象折成一行，避免展示页出现 [object Object] */
export function prettyValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("zh-CN") : String(v);
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * 采集结果的容器。
 *
 * 一次采集里每个字段可能有三种结局，展示页要能区分：
 *   ok      —— 有值
 *   missing —— 源没给（比如 Similarweb 对小站没有 AI 流量数据）
 *   error   —— 请求失败（比如 Actor 报错、网站打不开）
 * 混在一起的话，「采不到」和「没采」看起来一样，就失去了验证的意义。
 */
export class FieldBag {
  private slots = new Map<string, Slot>();

  set(
    key: string,
    value: unknown,
    opts: { display?: string; actualSource?: string; note?: string } = {},
  ): void {
    this.slots.set(key, { value, ...opts });
  }

  /** 数值类：0 也可能是真值（如付费搜索占比 0%），所以单独一个入口不做空判定 */
  setNumber(key: string, value: number | null | undefined, opts: { actualSource?: string; note?: string; suffix?: string } = {}): void {
    if (value === null || value === undefined || !Number.isFinite(value)) {
      this.missing(key, opts.note);
      return;
    }
    this.set(key, value, {
      display: `${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}${opts.suffix ?? ""}`,
      actualSource: opts.actualSource,
      note: opts.note,
    });
  }

  /** 明确「源里就没有这个值」 */
  missing(key: string, note?: string): void {
    const prev = this.slots.get(key);
    // 已有值时不覆盖：备选源补上的数据比「缺失」更有价值
    if (prev && !isEmpty(prev.value)) return;
    this.slots.set(key, { value: null, note });
  }

  /** 明确「请求这个源失败」 */
  fail(key: string, note: string): void {
    const prev = this.slots.get(key);
    if (prev && !isEmpty(prev.value)) return;
    this.slots.set(key, { value: null, note, error: true });
  }

  has(key: string): boolean {
    const s = this.slots.get(key);
    return !!s && !isEmpty(s.value);
  }

  get(key: string): unknown {
    return this.slots.get(key)?.value ?? null;
  }

  toResults(): FieldResult[] {
    return FIELDS.map((def) => {
      const slot = this.slots.get(def.key);
      const value = slot?.value ?? null;
      const empty = isEmpty(value);
      return {
        ...def,
        value: empty ? null : value,
        display: slot?.display ?? (empty ? "" : prettyValue(value)),
        status: empty ? (slot?.error ? "error" : "missing") : "ok",
        actualSource: slot?.actualSource,
        note: slot?.note,
      } satisfies FieldResult;
    });
  }
}

export function summarize(fields: FieldResult[]) {
  const groups = GROUPS.map((g) => {
    const rows = fields.filter((f) => f.group === g.key);
    return {
      key: g.key,
      name: g.name,
      total: rows.length,
      filled: rows.filter((f) => f.status === "ok").length,
    };
  });
  return {
    total: fields.length,
    filled: fields.filter((f) => f.status === "ok").length,
    missing: fields.filter((f) => f.status === "missing").length,
    error: fields.filter((f) => f.status === "error").length,
    groups,
  };
}