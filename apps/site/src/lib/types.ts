/** 产物（content/dist）中的列表行结构，由 scripts/build/artifacts.ts 生成 */

export type PricingModel = "free" | "freemium" | "paid";

export interface ToolRow {
  rank: number;
  /** 分层：main = 主榜（占名次）；watch = 观察区（待验证，不占主榜名次） */
  tier: "core" | "watch";
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
  /** 上线时间为推断值时（域名历史早于当前产品 / 仅能取到域名注册）为 true，前端加 * */
  launchedEstimated?: boolean;
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
  /** 加工空间 0-10：越低说明它自己已经是个成品，照抄意义越小 */
  dv: number | null;
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
  stats: { tools: number; repos: number; trends: number; githubUpdatedAt: string };
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
  /** 综合得分 S = 0.6T + 0.4O */
  overall: number;
  /** 全站名次；采样点不足为 0（展示「—」，不参与排名） */
  rank: number;
  oppTypes: { label: string; cls: string }[];
  oppCount: number;
  updatedShort: string;
  /** 已完成排序所需的数值 */
  sortTrend: number;
  sortOpp: number;
  sortOverall: number;
  sortGrowth: number;
  firstSeenAt: string;
  /** 搜索用的小写文本（keyword + 名称 + why + 意图 + 关联词） */
  hay: string;
  /** 预渲染行 HTML（趋势榜名次已内联，无需 fillRank） */
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

/** AI 模型榜：构建期算好的列表行 */
export interface ModelRow {
  rank: number;
  slug: string;
  name: string;
  provider: string;
  /** 主模态 key（text / multimodal / reasoning / code / image / video / audio / embedding） */
  modality: string;
  modalityLabel: string;
  tags: string[];
  open: boolean;
  license: string | null;
  /** 上下文窗口（tokens） */
  context: number | null;
  contextText: string;
  maxOutput: number | null;
  maxOutputText: string;
  params: string | null;
  /** 价格：USD / 1M tokens；null 表示无公开定价 */
  priceIn: number | null;
  priceOut: number | null;
  priceCached: number | null;
  priceInText: string;
  priceOutText: string;
  priceCachedText: string;
  priceUnit: string;
  freeTier: string | null;
  hasFree: boolean;
  /** 能力分（0–100） */
  capability: number;
  /** 性价比分（0–100，构建期按样本内归一） */
  value: number;
  /** 综合得分 = 0.9 × 能力 + 0.1 × 性价比 */
  score: number;
  grade: "S" | "A" | "B" | "C";
  /** 厂商官方模型页简介（原文）；无官方简介时为 null，不做生成 */
  desc: string | null;
  knowledgeCutoff: string | null;
  releasedAt: string | null;
  updatedShort: string;
  /** 搜索用的小写文本 */
  hay: string;
  /** 预渲染行 HTML（名次已内联） */
  h: string;
}

export interface ModelFilters {
  generatedAt: string;
  updatedAt: string;
  mode: string;
  total: number;
  /** 数据口径说明（来源、价格单位、能力分估算方式） */
  note?: string;
  capabilityNote?: string;
  source?: string;
  providers: FilterOption[];
  modalities: FilterOption[];
  licenses: FilterOption[];
  sorts: { value: string; label: string }[];
}

export interface RepoFilters {
  generatedAt: string;
  categories: FilterOption[];
  languages: FilterOption[];
  licenses: FilterOption[];
  difficulties: FilterOption[];
}