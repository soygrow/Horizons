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

/** 登录会话中的用户信息（前后端共享） */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}
