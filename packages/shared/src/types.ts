// 共享数据模型：AI 工具榜单 + 用户/订阅（前后端 + 脚本共用）

export type AIToolCategory =
  | "AI Chat"
  | "Image Gen"
  | "Video"
  | "Voice & Audio"
  | "Writing"
  | "Coding"
  | "Automation"
  | "Marketing"
  | "Productivity"
  | "Data & Analytics"
  | "Other";

export type PricingModel = "free" | "freemium" | "paid";

/** 字段数据接入状态：live=已接入真实数据；pending=待接入（占位） */
export type DataStatus = "live" | "pending";

export interface TrafficStats {
  visits?: number;            // 月访问量（总，SimilarWeb 独有）
  uniqueVisitors?: number;    // 独立访客（SimilarWeb）
  durationSec?: number;       // 访问时长（秒，SimilarWeb）
  pagesPerVisit?: number;     // 单次访问页数（SimilarWeb）
  bounceRate?: number;        // 跳出率（0~100，SimilarWeb）
  organicVisits?: number;     // 月搜索流量（organic，DataForSEO）
  paidVisits?: number;        // 月付费搜索流量（DataForSEO）
}

export interface TrafficChannels {
  social?: number;      // 社媒占比 %
  direct?: number;      // 直接访问 %
  search?: number;      // 搜索 %
  referral?: number;    // 外链 %
  email?: number;       // 邮件 %
}

export interface GeoItem {
  country: string;      // 国家
  share: number;        // 占比 %
}

export interface KeywordItem {
  term: string;         // 关键词
  volume?: number;      // 月搜索量
  cpc?: number;         // CPC
  competition?: string; // 竞争程度
  traffic?: number;     // 该词带来的月流量（详情页「流量」列）
}

export interface PricePlan {
  plan: string;
  price: string;
  desc?: string;
}

// ---------------------------------------------------------------------------
// V5 详情页字段（对齐哥伦布「站点分析」页；全部可选，缺失时前端渲染「待接入」）
// ---------------------------------------------------------------------------

/** 01 概览：核心指标 */
export interface SiteMetrics {
  monthlyVisits?: number;       // 月访问量（总口径；DFS 接入后为搜索口径需加注）
  visitsCategoryRank?: string;  // 类目内排名，如 "1031 / 1209"
  momGrowth?: number;           // 环比增长 %
  organicVisits?: number;       // 自然搜索流量
  organicShare?: number;        // 自然搜索占比 %
  domainWeight?: number;        // 域名权重（DFS rank / DR 替代）
  domainWeightLabel?: string;   // 展示名：DR / 权重
  weightCategoryRank?: string;  // 类目内排名
  registeredAt?: string;        // 注册时间（WHOIS）
}

/** 02 流量：趋势点（双系列） */
export interface TrafficTrendPoint {
  date: string;   // YYYY-MM
  total: number;  // 总访问量
  organic: number; // 自然搜索
}

/** 02 流量：渠道 key（哥伦布 10 渠道） */
export type ChannelKey =
  | "direct"
  | "organicSearch"
  | "referral"
  | "displayAds"
  | "organicSocial"
  | "email"
  | "affiliates"
  | "paidSearch"
  | "aiAssistants"
  | "paidSocial";

/** 02 流量：互动指标 */
export interface Engagement {
  bounceRate?: number;      // 跳出率 %
  pagesPerVisit?: number;   // 页均访问
  durationSec?: number | null; // 停留时长秒；null=无记录
}

/** 02 流量：排名 */
export interface SiteRanks {
  global?: number;  // 全球排名
  country?: number; // 国内排名
}

/** 03 外链统计 + 明细 */
export interface BacklinkItem {
  sourceUrl: string;
  sourceTitle?: string;
  dr?: number;
  anchorText?: string;
  targetUrl?: string;
}

export interface BacklinkStats {
  total?: number;             // 外链总数
  totalDofollowShare?: number; // dofollow %
  refDomains?: number;        // 引荐域名
  refDofollowShare?: number;  // 引荐域名 dofollow %
  items?: BacklinkItem[];     // Top N 明细
}

/** AI 解读（8 段） */
export interface AiInsight {
  analyzedAt?: string;      // 分析于 2026-10
  confidence?: number;      // AI 置信度 %
  question?: string;        // 引导问题
  intro?: string;           // 引言：核心痛点
  before?: string;          // 以前
  now?: string;             // 现在
  comparison?: string;      // 相比之下
  audiences?: string[];     // 帮的是谁
  hooks?: { title: string; desc: string }[]; // 靠什么打动人
  willingness?: { level: "低" | "中等" | "高"; score?: 1 | 2 | 3; reason?: string };
  growthDriver?: string;    // AI 解读 · 增长驱动
  acquisition?: string;     // AI 解读 · 获客打法
  trafficQuality?: string;  // 流量质量段
  moat?: string;            // AI 解读 · 竞争壁垒
  moatBadge?: string;       // 如「浅层封装」
  monetization?: string;    // AI 解读 · 收费模式
  monetizationBadge?: string; // 如「证据明确」
}

/** 流量情况解密：右侧 AI 解读（结构化报告，视角 = 资深增长黑客） */
export interface TrafficDecryptSection {
  title: string;        // 含 emoji 前缀与编号，如「📊 1. 流量趋势与结构（它是怎么活下来的？）」
  highlights: string[]; // 高光标签（2 个）
  insight: string;      // 数据洞察
  takeaway: string;     // 创业启发
}
export interface TrafficDecrypt {
  overview: string;              // 流量总览（一段定性结论）
  sections: TrafficDecryptSection[]; // 固定 3 段：趋势结构 / 地域 / 搜索排名
}

/** 04 变现与产品：标签组 */
export interface TagGroup {
  label: string;   // 变现方式 / SEO 打法 / 成熟度信号 / 模型家族 / 使用模型
  values: string[];
}

/** 04 站点拆解：技术 + SEO 审计 */
export interface SiteAudit {
  techStack?: string[];
  analytics?: string[];
  pricingClues?: string[];
  wordCount?: number;
  pageLang?: string;
  internalLinks?: number;
  outboundLinks?: number;
  images?: number;
  imagesMissingAlt?: number;
  structuredData?: string[];
  outboundDomains?: string[];
}

export interface PageLinkItem {
  text: string;
  url: string;
}

/** 04 页面结构与链接明细 */
export interface PageStructure {
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robotsDirective?: string;
  h1?: string[];
  h2?: string[];
  h3?: string[];
  internalLinks?: PageLinkItem[];
  outboundLinks?: PageLinkItem[];
}

/** 05 观察与竞品 */
export interface Observations {
  practices?: string[];   // 值得关注的做法
  concerns?: string[];    // 疑点
  competitors?: string[]; // 竞品域名
}

/** 数据快照 */
export interface DataSnapshot {
  period?: string;  // 2026-09
  syncedAt?: string; // 2026-10-07 05:24:18
}

// ---------------------------------------------------------------------------
// V6 创业洞察字段（差异化模块，对齐「创业机会雷达」定位）
// ---------------------------------------------------------------------------

/** ① 机会评分卡 */
export interface OpportunityScore {
  score: number;                    // 综合分 0~100
  verdict: "值得入场" | "谨慎" | "别碰";
  reason: string;                   // 一句话结论（so-what）
  dimensions: {
    label: string;                  // 竞争度 / 变现成熟度 / 增长可复制性 / 技术门槛 / 启动成本
    score: number;                  // 0~100
    note?: string;
  }[];
}

/** ② 变现蓝图 */
export interface MonetizationBlueprint {
  model: string;                    // 商业模式：订阅 + 积分 等
  tiers: string[];                  // 定价阶梯摘要
  paymentDetected: string[];        // 收款平台检测：Stripe / Paddle / LemonSqueezy
  monthlyRevenueSignal?: number;    // 估算月收入信号（美元）：访问量 × 付款转化率 × 客单价，行业基准估算，仅体现收入量级，非真实收入
  paymentConversionRate?: number;   // 采用的付款转化率基准（如 0.02 表示 2%）
  revenueAov?: number;              // 采用的客单价（美元）：定价线索中位数，无则行业默认
  pricingAdvice: string;            // 「你起步怎么定价」建议
}

/** ③ 增长复盘 */
export interface GrowthPlaybook {
  coldStart: string;                // 冷启动路径
  channels: string[];               // 有效渠道
  copyable: string[];               // 值得抄
  avoid: string[];                  // 是坑别踩
}

/** ④ 启动蓝图 */
export interface BuildBlueprint {
  techStack: string[];              // 技术栈
  thirdParty: string[];             // 依赖的第三方 API / 模型
  mvpScope: string;                 // MVP 范围
  devTime: string;                  // 预估开发周期
  monthlyCost: string;              // 预估月成本
}

/** ⑤ 灵感触发 */
export interface IdeaSpark {
  title: string;
  angle: string;                    // 换场景 / 换人群 / 换商业模式 / 换语区
  why: string;                      // 为什么有机会
  source?: string;                  // 灵感来源（指向某个数据点/竞品特征，让点子可追溯）
}

/** 产品表现：顶部高光结论 —— 产品画像四要素（说清楚：这是什么/解决什么痛点/能干啥/特点） */
export interface ProductOverview {
  what?: string;   // 是什么：一句话定义产品定位（做什么、给谁用）
  pain?: string;   // 解决什么痛点：目标人群苦于什么、它如何解决
  can?: string;    // 能干什么：核心功能 / 能力清单
  trait?: string;  // 特点：差异化卖点 / 壁垒信号
}

/** 产品表现：结构化分析（顶部高光结论 + 六宫格洞察） */
export interface PerformanceInsight {
  overview?: ProductOverview; // 顶部高光结论（产品画像四要素）
  wedge: string;              // 切入点（解决什么）：产品形态，帮谁解决什么
  model: string;              // 商业模式与卖点（怎么赚钱）：靠什么打动用户、怎么收钱
  moat: string;               // 业务数据匹配度（护城河）：结合 DR 与站龄判断壁垒
  trafficTruth: string;       // 流量结构真相（用户从哪来）：自然搜索 vs 直接访问
  growthEdge: string;         // 增长势能与软肋（生死局）：访问量 × 增长率
  newPlayerEntry: string;     // 新玩家切入点（行动指南）：截胡 / 平替建议
  entryTag?: string;          // 结论标签，如「强烈推荐·可切细分」
}

/** 各数据模块的分析结论 + 「这对你意味着什么」so-what */
export interface ModuleInsight {
  performance?: { analysis?: string; soWhat?: string };
  growth?: { analysis?: string; soWhat?: string };
  keywords?: { analysis?: string; soWhat?: string };
  competition?: { analysis?: string; soWhat?: string };
}

/** docs/9 的 8 个「产品表现」指标（Apify Similarweb 数据源） */
export interface TrafficMetrics {
  monthlyVisits?: number;       // 1 月访问量
  monthlyVisitsGrowth?: number; // 2 月访问量增长率（%）
  organicSearchVisits?: number; // 3 自然搜索流量
  directVisits?: number;        // 4 直接访问流量
  referralVisits?: number;      // 5 引荐流量
  socialVisits?: number;        // 6 社交媒体流量
  monthlyPageviews?: number;    // 7 月页面浏览量
  avgVisitDurationSec?: number; // 8 平均访问时长（秒）
  snapshotMonth?: string;       // 数据快照月份
}

export interface AITool {
  id: string;
  name: string;
  domain: string;                 // 注册域（去重主键）
  url: string;
  description: string;            // 一句话描述
  descriptionSource?: "ai" | "manual" | "source";
  categories: AIToolCategory[];
  segmentLabel?: string;          // 细分赛道，如「AI 视频生成」
  industry?: string;              // 行业，当前恒为「人工智能」
  heatScore: number;

  // 热度信号（可追溯）
  phUpvotes?: number | null;
  phComments?: number | null;
  githubStars?: number | null;    // 兼容旧数据；AI 工具榜优先用 PH 信号
  trancoRank?: number | null;     // 全球排名（Tranco，免费替代）

  // 时间
  launchedAt?: string;            // 上线时间
  launchedAtEstimated?: boolean;  // 是否推断值
  firstSeenAt: string;
  collectedAt: string;

  // 元数据
  verified: "verified" | "pending";
  sourceType:
    | "producthunt"
    | "manual"
    | "submitted"
    | "yc"
    | "directory"
    | "github";
  sourceUrl: string;
  isDemo?: boolean;

  // V3 保留
  pricingModel?: PricingModel;
  topicSlugs?: string[];
  phUrl?: string;

  // 详情页
  longDescription?: string;
  tags?: string[];
  pricing?: PricePlan[];
  techStack?: string[];
  contact?: {
    email?: string;
    socials?: { label: string; url: string }[];
  };
  screenshotUrl?: string;

  // 趋势
  heatHistory?: { date: string; score: number }[];

  // P4 付费字段（未接入时缺失，前端据此渲染「待接入」占位）
  traffic?: TrafficStats;
  trafficHistory?: { date: string; visits: number }[];
  channels?: TrafficChannels;
  geoDistribution?: GeoItem[];
  keywords?: KeywordItem[];
  priceHistory?: { date: string; plans: PricePlan[] }[];

  // V5 详情页字段（对齐哥伦布站点分析页）
  featureTags?: string[];       // Hero 特色标签（品牌驱动 / All In One / 多语言·N 种）
  categoryTags?: string[];      // Hero 品类标签（视频制作 / AI 视频生成器 / …）
  metrics?: SiteMetrics;        // 01 概览指标
  dataSnapshot?: DataSnapshot;  // 数据快照月份 + 最后同步
  trend?: TrafficTrendPoint[];  // 流量趋势（总 + 自然搜索）
  channelShares?: Partial<Record<ChannelKey, number>>; // 10 渠道占比 %
  engagement?: Engagement;      // 互动指标
  ranks?: SiteRanks;            // 全球 / 国内排名
  backlinks?: BacklinkStats;    // 外链
  aiInsight?: AiInsight;        // AI 解读 8 段
  trafficDecrypt?: TrafficDecrypt; // 流量情况解密（右侧 AI 解读报告）
  tagGroups?: TagGroup[];       // 04 标签卡
  siteAudit?: SiteAudit;        // 站点拆解
  pageStructure?: PageStructure; // 页面结构与链接明细
  observations?: Observations;  // 05 观察与竞品
  screenshotDesktopUrl?: string;
  screenshotMobileUrl?: string;

  // V6 创业洞察（差异化模块）
  opportunity?: OpportunityScore;         // ① 机会评分卡
  monetizationBlueprint?: MonetizationBlueprint; // ② 变现蓝图
  growthPlaybook?: GrowthPlaybook;        // ③ 增长复盘
  buildBlueprint?: BuildBlueprint;        // ④ 启动蓝图
  ideaSparks?: IdeaSpark[];               // ⑤ 灵感触发

  // V7 数据整合
  relatedKeywords?: { term: string; volume?: number }[]; // 相关关键词（DFS）
  searchTraffic?: { organic: number; paid: number };     // 搜索流量拆解（自然/付费）
  keywordCount?: number;                                  // 排名关键词总数（DFS）
  rankDistribution?: { label: string; count: number }[]; // 关键词排名分布（DFS）
  moduleInsights?: ModuleInsight;                         // 各模块分析 + so-what（AI）
  trafficMetrics?: TrafficMetrics;                        // 产品表现 8 指标（Apify Similarweb）
  performanceInsight?: PerformanceInsight;                // 01 产品表现结构化分析（高光结论 + 六宫格）
}

// ---------------------------------------------------------------------------
// AI 趋势词榜单（/trends）：搜索趋势证据 + 机会判断
// 口径见 docs/12-AI趋势词榜单方案.md；Google Trends 为 0-100 归一化相对热度，
// 不是搜索次数，前端禁止据此推算月搜索量。
// ---------------------------------------------------------------------------

/** 一级类别（准入范围，broadtech 需更严格准入） */
export type TrendCategory =
  | "model"
  | "tool"
  | "agent"
  | "devtech"
  | "usecase"
  | "business"
  | "broadtech";

/** 趋势阶段：正在爆发 / 持续增长 / 新词观察 / 热度回落 */
export type TrendStatus = "breaking" | "gaining" | "new" | "cooling";

/** 趋势可信度：自定义证据等级，非 Google 官方指标 */
export type TrendConfidence = "high" | "medium" | "low";

/** 数据来源类型 */
export type TrendSourceKind =
  | "google_trends"
  | "official"
  | "news"
  | "community"
  | "repo"
  | "serp";

/** 可追溯的数据来源 */
export interface TrendSourceRef {
  label: string;
  url: string;
  site?: string;
  kind: TrendSourceKind;
  publishedAt?: string; // 证据发布日期 YYYY-MM-DD
}

/** 结论类型：已验证事实 / 合理推断 / 待验证假设 */
export type ClaimType = "fact" | "inference" | "hypothesis";

/** 事件与原因（趋势拐点的可能解释） */
export interface TrendEvidence {
  claim: string;
  claimType: ClaimType;
  date?: string;
  detail?: string;
  sources: TrendSourceRef[];
}

/** 搜索意图分组 */
export type TrendIntentKey =
  | "learn"
  | "howto"
  | "problem"
  | "compare"
  | "price"
  | "alternative";

export interface TrendIntent {
  intent: TrendIntentKey;
  /** @deprecated Google Trends 不提供意图份额，该值由模型估算，页面不再展示 */
  share?: number;
  /** 这类意图下人们实际会敲的搜索词 */
  queries: string[];
}

/**
 * 准入判定留下的结论，直接对应采集原则：
 * 读者是准备动手的创业者，所以每个上榜词都要能回答「谁付钱、从哪下手」。
 */
export interface TrendEditorNote {
  /** 谁在为这个问题付钱 */
  audience: string;
  /** 明天就能动手的切入口 */
  entryAngle: string;
  /** 收录理由：为什么这个词值得进榜 */
  whyAccepted: string;
}

/** 机会方向 */
export type TrendOpportunityType = "content" | "product" | "opensource" | "feature";

export interface TrendOpportunity {
  type: TrendOpportunityType;
  title: string;
  why: string; // 依据：必须挂真实搜索意图 / 竞争 / 用户反馈
  effort?: string; // 独立开发可行性
  evidence?: string;
}

/** 下一步行动 */
export type TrendActionVerdict = "research" | "content" | "mvp" | "watch";

export interface TrendNextAction {
  verdict: TrendActionVerdict;
  action: string;
  reason: string; // 依据
  uncertainty?: string; // 不确定性
}

/** 趋势强度分构成（各 0-100，权重 30/25/20/15/10） */
export interface TrendScoreParts {
  growth: number; // 增长幅度
  persistence: number; // 持续性
  breakout: number; // 爆发强度
  novelty: number; // 新颖度
  reliability: number; // 数据可靠性
}

/** 机会潜力分构成（各 0-100，权重 30/25/20/15/10） */
export interface OpportunityScoreParts {
  demand: number; // 用户需求证据
  wedge: number; // 可切入空间
  seo: number; // 搜索与内容机会
  feasibility: number; // 独立开发可行性
  timing: number; // 趋势时机
}

/** 搜索兴趣序列（Google Trends 风格 0-100，配采样起点与步长） */
export interface TrendSeries {
  start: string; // 首个采样日 YYYY-MM-DD
  stepDays: number; // 采样步长（天）
  values: number[]; // 0-100 归一化相对热度
}

/** 趋势词榜单条目 */
export interface AITrend {
  slug: string;
  keyword: string; // 原始查询词
  normalizedName: string; // 标准名称（产品 / 模型 / 能力名）
  category: TrendCategory;
  region: string; // 地区代码：US / CN / global
  status: TrendStatus;
  confidence: TrendConfidence;
  why: string; // 一句话：为什么升温 + 证据
  intentSummary?: string; // 需求侧结论
  firstSeenAt: string; // 首次发现，后续更新不覆盖
  lastSeenAt: string; // 最近一次成功采集
  updatedAt: string; // 数据快照时间
  series: TrendSeries;
  trendParts: TrendScoreParts;
  oppParts: OpportunityScoreParts;
  sources: TrendSourceRef[]; // 趋势数据源（Explore / Trending now …）
  evidence: TrendEvidence[]; // 事件与原因
  /** 准入判定留下的结论：谁付钱、从哪下手、为什么收这个词 */
  editorNote?: TrendEditorNote;
  intents: TrendIntent[]; // 搜索意图
  relatedQueries?: string[]; // 相关查询
  competitors?: string[]; // 现有产品 / 竞品
  opportunities: TrendOpportunity[];
  actions: TrendNextAction[];
}

/** 榜单数据集（content/trends.json） */
export interface TrendDataset {
  updatedAt: string;
  /** seed=结构演示数据；live=已接入真实采集 */
  mode: "seed" | "live";
  region: string;
  keywords: AITrend[];
  /** 榜单准入原则：决定什么样的趋势值得进榜，随市场审计演进 */
  policy?: EntryPolicy;
}

/**
 * 单个候选词的准入判定。
 * 只回答一个问题：一个独立开发者看到这个词，明天有没有能开工的事。
 */
export interface ValueVerdict {
  verdict: "accept" | "reject";
  /** 创业切口强度 0-100：需求确定性 × 可承接性 × 供给稀缺度 */
  score: number;
  /** 判定依据，一句话 */
  reason: string;
  /** 谁在为这个问题付费 */
  audience: string;
  /** 可落地的切入口；reject 时为空 */
  ideaAngle: string;
  /** 判定时间，用于缓存过期 */
  at: string;
}

/**
 * 准入原则。原则本身是会变的——每次审计都会根据
 * 「最近被拒的词」和「市场反馈」重写条目，version 递增。
 */
export interface EntryPolicy {
  version: number;
  updatedAt: string;
  /** 收：一条趋势要能回答「创业者明天能拿它做什么」 */
  accept: string[];
  /** 拒：没有切入点的典型信号 */
  reject: string[];
  /** 最近一次修订依据，解释原则为什么变 */
  notes: string[];
  /** 已判定过的词，避免重复花钱；键为归一化关键词 */
  verdicts?: Record<string, ValueVerdict>;
}

/** 登录会话中的用户信息（前后端共享） */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

/* ------------------------------ 我在做 ------------------------------ */

export const DOING_STATUSES = ["doing", "shipped", "paused", "dropped"] as const;
export type DoingStatus = (typeof DOING_STATUSES)[number];

export const DOING_STATUS_LABELS: Record<DoingStatus, string> = {
  doing: "在做",
  shipped: "已上线",
  paused: "暂停了",
  dropped: "放弃了",
};

/** 一条留言（同一用户可多条） */
export interface DoingUpdate {
  id: string;
  body: string;
  status: DoingStatus;
  createdAt: number;
}

/** 某条机会下的一位参与者（公开信息，不含邮箱） */
export interface DoingDoer {
  userId: string;
  name: string | null;
  avatarUrl: string | null;
  status: DoingStatus;
  updateCount: number;
  lastAt: number;
  joinedAt: number;
}

/** GET /api/opportunity/:slug/doing */
export interface DoingResponse {
  slug: string;
  count: number;
  doers: DoingDoer[];
  /** 是否已登录：决定按钮显示「我在做」还是「登录后加入」 */
  authenticated: boolean;
  /** 当前登录用户的参与情况；未登录或未加入为 null */
  me: { status: DoingStatus; joinedAt: number; updates: DoingUpdate[] } | null;
}

/** GET /api/opportunity/:slug/doing/:userId */
export interface DoingUserResponse {
  user: { id: string; name: string | null; avatarUrl: string | null; status: DoingStatus };
  updates: DoingUpdate[];
}

export const DOING_MAX_BODY = 280;
export const DOING_MIN_INTERVAL_MS = 20_000;

/** GitHub 榜单：每日一手数值快照（日维度采集，体现项目快速变化） */
export interface GitHubSnapshot {
  date: string; // YYYY-MM-DD
  stars: number;
  forks: number;
  openIssues: number;
  /** true = 由 backfillHistory 按当前星标回推的估算点，不是真实采样，不可用于计算增速 */
  synthetic?: boolean;
}

/** 面向创业者/独立开发者的一个可落地产品方向 */
export interface BuildIdea {
  title: string; // 产品方向名
  audience: string; // 目标用户
  product: string; // 具体做什么
  monetization: string; // 怎么赚钱
  effort: string; // 工作量（人力/周期）
  stackHint?: string; // 技术要点
}

/** 路径阶段：验证 → 起步 → 变现 → 增长 */
export type BuildPhase = "验证" | "起步" | "变现" | "增长";

/** 落地步骤 */
export interface BuildStep {
  step: string;
  detail: string;
  phase?: BuildPhase; // 所属阶段
  output?: string; // 该步产出物
  duration?: string; // 预计耗时（如 2-3 天）
}

/** 预期效果（可量化） */
export interface ExpectedEffect {
  metric: string;
  value: string;
}

/** 中文创业情报（DeepSeek 生成；面向想动手做产品的人） */
/**
 * 加工空间评估（LLM 判断，pps-v4 起参与打分）。
 *
 * 榜单读者不是来找「好项目」的，是来找「能加工出不一样产品」的原材料。
 * 一个项目越完善、越像成品，照抄的价值越低——这正是本字段要区分的东西。
 */
export interface GitHubDerivative {
  /** 它现在是什么形态：库 / 引擎 / CLI 工具 / 服务端 / 成品应用 / 协议标准 */
  base: string;
  /** 它自己已经占住的产品场景；它本身不是成品时留空 */
  occupancy?: string;
  /** 0-10：加工后能否做出与原项目不同的产品（0-3 基本只能照抄或做周边，7-10 可嵌进完全不同的产品） */
  space: number;
  /** 它自己没做、但基于它能做的 2 个具体方向 */
  untapped: string[];
  /** 可接入 / 可扩展 / 可定制的技术入口（输出 JSON、HTTP 接口、插件目录、可换模型等） */
  hook?: string;
}

export interface GitHubInsight {
  taglineZh: string; // 一句话中文定位
  whatZh: string; // 它是什么、核心能力（中文，替代英文原文）
  capabilities: string[]; // 核心能力标签
  buildIdeas: BuildIdea[]; // 能做出什么产品（3-4 个）
  buildSteps: BuildStep[]; // 怎么做（分步骤）
  effects: ExpectedEffect[]; // 能有什么效果
  moat: string; // 护城河 / 差异化
  risks: string[]; // 风险
  techNotes: string; // 技术要点 / 集成方式
  difficulty: "低" | "中" | "高"; // 上手难度
  timeToMvp: string; // 做出 MVP 的周期
  costToMvp: string; // MVP 阶段月成本
  competitors?: string[]; // 竞品 / 参考
  differentiators?: string[]; // 差异化切入点
}

/** 综合得分构成项（用于详情页说明「分是怎么来的」） */
export interface ScorePart {
  key: "light" | "commercial" | "effort" | "dev" | "growth" | "heat" | "active" | "demand";
  label: string; // 中文名，如「热度」
  weight: number; // 权重（满分 100 中的占比）
  value: number; // 该项归一值 0-100
  points: number; // 加权后实际得分
  note: string; // 该项的判定依据
}

/** 综合得分：用这个项目做出一款「有收益产品」的可能性（0-100） */
export interface ProductScore {
  score: number; // 综合分 0-100
  grade: "S" | "A" | "B" | "C"; // 等级
  summary: string; // 一句话结论
  parts: ScorePart[]; // 6 项构成
  model: string; // 模型版本
  computedAt: string; // 计算时间
}

/** GitHub 榜单仓库条目：零付费流量接口，全部来自 GitHub 官方 API + 解读 */
export interface GitHubRepo {
  fullName: string; // owner/repo（主键）
  owner: string;
  repo: string;
  name: string;
  description?: string;
  htmlUrl: string;
  homepage?: string;
  avatarUrl?: string;
  language?: string;
  languages?: Record<string, number>; // 语言占比
  topics?: string[];
  license?: { spdx?: string; name?: string };
  createdAt?: string;
  pushedAt?: string;
  stars: number;
  forks: number;
  openIssues: number;
  watchers?: number;
  contributorsCount?: number;
  commitActivity?: number[]; // 近 52 周每周提交数
  readme?: string;
  readmeSummary?: string;
  categories: string[]; // 用途分类（mapCategories 规则）
  heatScore: number; // 热度分 0-100
  // 解读（LLM 生成或本地启发式；本期本地生成，后续 LLM 增强）
  what?: string;
  useCases?: { title: string; how: string }[];
  risks?: string;
  focusOpportunity?: string;
  buildBlueprint?: BuildBlueprint;
  ideaSparks?: IdeaSpark[];
  // 中文创业情报（LLM 生成，面向想动手做产品的人）
  insight?: GitHubInsight;
  // 情报来源：curated=人工精编，llm=大模型生成，local=本地模板兜底（余额/限流失败时写入，下次运行会自动重生成）
  insightSource?: "curated" | "llm" | "local";
  // 加工空间评估：拿它加工/附加处理后，能不能做出与原项目不一样的产品
  derivative?: GitHubDerivative;
  derivativeSource?: "llm" | "fallback";
  // 综合得分（做产品的收益可能性，用于榜单排序与详情页展示）
  productScore?: ProductScore;
  // 日维度采集历史
  history: GitHubSnapshot[];
  lastCrawledAt: string;
}
