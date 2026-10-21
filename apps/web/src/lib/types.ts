// 数据模型：AI 工具榜单 + 详情页

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

export interface AITool {
  id: string;
  name: string;
  domain: string;
  url: string;
  description: string;
  categories: AIToolCategory[];
  heatScore: number;
  phUpvotes?: number | null;
  githubStars?: number | null;
  firstSeenAt: string;
  collectedAt: string;
  verified: "verified" | "pending";
  sourceType: "producthunt" | "github" | "manual" | "submitted";
  sourceUrl: string;
  isDemo?: boolean;

  // V3 新增字段
  pricingModel?: PricingModel;   // 定价模式（筛选维度）
  launchedAt?: string;           // 上线时间（PH createdAt / GH created_at）
  topicSlugs?: string[];         // PH/GH topics，用于热门标签筛选
  heatHistory?: { date: string; score: number }[]; // heat 快照（sparkline / 涨幅）
  phUrl?: string;                // PH 产品页链接

  // 详情页字段
  longDescription?: string;
  tags?: string[];
  pricing?: { plan: string; price: string }[];
  techStack?: string[];
  contact?: {
    email?: string;
    socials?: { label: string; url: string }[];
  };
}
