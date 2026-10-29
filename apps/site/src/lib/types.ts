/** 产物（content/dist）中的列表行结构，由 scripts/build/artifacts.ts 生成 */

export type PricingModel = "free" | "freemium" | "paid";

export interface ToolRow {
  rank: number;
  id: string;
  domain: string;
  name: string;
  url: string;
  desc: string;
  cats: string[];
  visits: number | null;
  mom: number | null;
  organic: number | null;
  /** 自然搜索占比 %（getOrganicShare 口径） */
  org: number | null;
  /** 规模标签（★ GitHub Stars / ▲ PH Upvotes），无数据为 null */
  scale: string | null;
  dr: number | null;
  drLabel: string | null;
  heat: number;
  growth: number | null;
  spark: number[] | null;
  launchedAt: string | null;
  pricing: PricingModel | null;
  verified: "verified" | "pending";
  tags: string[];
  firstSeenAt: string;
  collectedAt: string;
  /** 预渲染行 HTML（排名为 %R% 占位，用 fillRank 填充） */
  h: string;
}

export interface RepoRow {
  rank: number;
  fullName: string;
  owner: string;
  repo: string;
  name: string;
  url: string;
  avatar: string | null;
  intro: string;
  desc: string | null;
  diff: "低" | "中" | "高";
  cats: string[];
  lang: string | null;
  stars: number;
  forks: number;
  score: number;
  grade: "S" | "A" | "B" | "C";
  g7: number | null;
  g30: number | null;
  spark: number[] | null;
  license: string | null;
  permissive: boolean;
  pushedDaysAgo: number | null;
  updatedAt: string | null;
  createdAt: string | null;
  /** 预渲染行 HTML（排名为 %R% 占位，用 fillRank 填充） */
  h: string;
}

export interface HomeData {
  generatedAt: string;
  stats: { tools: number; repos: number; githubUpdatedAt: string };
  toolsHot: ToolRow[];
  toolsNewest: ToolRow[];
  byCategory: { category: string; total: number; items: ToolRow[] }[];
  githubTop: RepoRow[];
}

/** AI 趋势词行：展示所需字段在构建期算好，浏览器只做过滤与排序 */
export interface TrendRow {
  slug: string;
  keyword: string;
  normalizedName: string;
  category: string;
  catLabel: string;
  status: string;
  statusLabel: string;
  statusCls: string;
  statusDot: string;
  statusHint: string;
  confidence: string;
  confLabel: string;
  confCls: string;
  confHint: string;
  why: string;
  growth: number | null;
  growthText: string;
  growthCls: string;
  baselineText: string;
  spark: number[] | null;
  seenDays: number | null;
  /** 采样点 ≥ 14 才评分 */
  scored: boolean;
  tv: number;
  op: number;
  oppTypes: { label: string; cls: string }[];
  oppCount: number;
  updatedShort: string;
  /** 已完成排序所需的数值 */
  sortTrend: number;
  sortOpp: number;
  sortGrowth: number;
  firstSeenAt: string;
  /** 搜索用的小写文本（keyword + 名称 + why + 意图 + 关联词） */
  hay: string;
  /** 预渲染行 HTML（排名为 %R% 占位，用 fillRank 填充） */
  h: string;
}

export interface TrendFilters {
  generatedAt: string;
  updatedAt: string;
  mode: string;
  total: number;
  categories: FilterOption[];
  statuses: FilterOption[];
  confidences: FilterOption[];
}

export interface FilterOption {
  value: string;
  count: number;
}

export interface ToolFilters {
  generatedAt: string;
  categories: FilterOption[];
  sorts: { value: string; label: string }[];
}

export interface RepoFilters {
  generatedAt: string;
  categories: FilterOption[];
  languages: FilterOption[];
  licenses: FilterOption[];
  difficulties: FilterOption[];
}