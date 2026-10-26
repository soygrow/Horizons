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
}

export interface PricePlan {
  plan: string;
  price: string;
  desc?: string;
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
}

/** 登录会话中的用户信息（前后端共享） */
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}
