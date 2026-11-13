import {
  compareByScore,
  compareByToolScore,
  computeProductScore,
  isListed,
  tierOf,
} from "@horizons/shared";
import type { AITool, PricingModel, GitHubRepo, ProductScore } from "@horizons/shared";
import toolsData from "@content/aitools.json";
import githubData from "@content/github-web.json";

export const tools = toolsData as AITool[];

/**
 * 收录判定已收拢到 `@horizons/shared` 的 tool-tier。
 * 这里重新导出，保持既有调用方（页面、脚本）不用改 import 路径。
 */
export { isListed, tierOf };
export type { ToolTier } from "@horizons/shared";

/** 达到收录门槛、可展示的工具（主榜 + 观察区） */
export const listedTools = tools.filter(isListed);
/** 主榜：参与综合得分排名、显示 #名次 */
export const coreTools = listedTools.filter((t) => tierOf(t) === "core");
/** 观察区：单独展示、标「待验证」、不占主榜名次 */
export const watchTools = listedTools.filter((t) => tierOf(t) === "watch");
const gh = githubData as unknown as { updatedAt: string; repos: GitHubRepo[] };
export const githubRepos = gh.repos ?? [];
/** GitHub 榜数据快照时间（页面上如实展示） */
export const githubUpdatedAt = gh.updatedAt ?? "";

export const allCategories = [
  "AI Chat",
  "Image Gen",
  "Video",
  "Voice & Audio",
  "Writing",
  "Coding",
  "Automation",
  "Marketing",
  "Productivity",
  "Data & Analytics",
  "Other",
] as const;

/**
 * 按热度降序（heatScore）。
 * 仅用于首页「热门」板块：首页排序口径与 /tools 榜单不同，改动请单独评估。
 */
export function getToolsSorted(): AITool[] {
  return [...listedTools].sort((a, b) => b.heatScore - a.heatScore);
}

/**
 * 榜单条数上限（产品口径：榜单稳定维护 1000 条，新工具按综合分替换尾部）。
 * 达标数不足 1000 时全部展示，因此对现有 200 余条数据不产生任何影响；
 * 只有候选池扩大到达标数超过 1000 后才开始截断。
 */
export const MAX_LISTED_TOOLS = 1000;

/**
 * 按综合得分降序（/tools 榜单默认顺序）。
 * 主榜 Core 在前、观察区 Watch 在后，各自按得分排序，
 * 保证 Watch 站不会插进主榜名次之间。
 */
export function getToolsByScore(): AITool[] {
  const ranked = [
    ...[...coreTools].sort(compareByToolScore),
    ...[...watchTools].sort(compareByToolScore),
  ];
  return ranked.length > MAX_LISTED_TOOLS ? ranked.slice(0, MAX_LISTED_TOOLS) : ranked;
}

/**
 * 全库综合得分名次：domain → 名次（1 起）。
 * 名次只由综合得分决定，与筛选条件无关，因此筛选后排到前面的站仍显示其真实名次。
 */
let rankMapCache: Map<string, number> | null = null;
export function getToolRankMap(): Map<string, number> {
  if (rankMapCache) return rankMapCache;
  rankMapCache = new Map(
    getToolsByScore().map((t, i) => [t.domain, i + 1]),
  );
  return rankMapCache;
}

export function getToolByDomain(domain: string): AITool | undefined {
  return tools.find((t) => t.domain === domain);
}

/** 相似工具：按共享分类数量排序 */
export function getSimilarTools(tool: AITool, limit = 6): AITool[] {
  const set = new Set(tool.categories);
  return listedTools
    .filter((t) => t.id !== tool.id)
    .map((t) => {
      const shared = t.categories.filter((c) => set.has(c)).length;
      return { t, shared };
    })
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, limit)
    .map((x) => x.t);
}

export const pricingModelLabels: Record<PricingModel, string> = {
  free: "免费",
  freemium: "免费增值",
  paid: "付费",
};

/** 定价模式：优先用数据字段，缺失时按来源启发式推导（GitHub 开源 → free） */
export function derivePricingModel(tool: AITool): PricingModel | undefined {
  if (tool.pricingModel) return tool.pricingModel;
  if (tool.sourceType === "github") return "free";
  return undefined;
}

/** 标签：优先用数据字段，缺失时用分类兜底 */
export function deriveTags(tool: AITool): string[] {
  if (tool.tags && tool.tags.length > 0) return tool.tags;
  return tool.categories;
}

/** 涨幅：最近两次 heat 快照的环比 %；快照不足 2 个返回 null */
export function computeGrowth(tool: AITool): number | null {
  const h = tool.heatHistory;
  if (!h || h.length < 2) return null;
  const sorted = [...h].sort((a, b) => a.date.localeCompare(b.date));
  const prev = sorted[sorted.length - 2].score;
  const last = sorted[sorted.length - 1].score;
  if (prev <= 0) return null;
  return Math.round(((last - prev) / prev) * 1000) / 10;
}

/** 归一化 sparkline 点（0-1）；无快照时返回 null */
export function sparklinePoints(tool: AITool): number[] | null {
  const h = tool.heatHistory;
  if (!h || h.length < 2) return null;
  const sorted = [...h].sort((a, b) => a.date.localeCompare(b.date));
  const vals = sorted.map((p) => p.score);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals.map((v) => (v - min) / range);
}

/** 流量趋势 sparkline 点：基于 trend.total，取最近 maxPoints 个月；无数据返回 null */
export function trafficSparklinePoints(tool: AITool, maxPoints = 6): number[] | null {
  const t = tool.trend;
  if (!t || t.length < 2) return null;
  const sorted = [...t].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxPoints);
  const vals = sorted.map((p) => p.total);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals.map((v) => (v - min) / range);
}

/** 月访问量：vortex(SimilarWeb) 优先，回退存量 metrics（历史快照） */
export function getMonthlyVisits(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisits ?? tool.metrics?.monthlyVisits;
}

/**
 * 占比字段归一化成百分数。
 *
 * vortex 的渠道/地域占比是 0~1 小数（0.42 = 42%），而页面统一按百分数渲染；
 * 历史数据里两种口径都出现过（写入端曾经漏乘 100），所以这里按
 * 「>1 视为已经是百分数」兜底，两批数据都能显示对。
 */
export function toPercent(value?: number | null): number | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  return value > 1 ? Math.round(value * 10) / 10 : Math.round(value * 1000) / 10;
}

/**
 * 判断一份渠道占比是 0~1 小数还是 0~100 百分数。
 *
 * 逐字段用「>1 就当百分数」去猜，会误伤真实占比正好 1% 的项（1 被放大成 100%）；
 * 看整份数据的总和更可靠：九个渠道加起来 ≈1 就是小数口径。
 */
function shareScale(shares: Record<string, number> | undefined): number {
  if (!shares) return 1;
  const sum = Object.values(shares).reduce(
    (acc, v) => acc + (typeof v === "number" && Number.isFinite(v) ? v : 0),
    0,
  );
  return sum > 0 && sum <= 1.2 ? 100 : 1;
}

/** 整份渠道占比，统一换算成百分数（百分数口径的原样返回） */
export function channelSharesPct(tool: AITool): Record<string, number> {
  const raw = (tool.channelShares ?? {}) as Record<string, number>;
  const scale = shareScale(raw);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = Math.round(value * scale * 10) / 10;
    }
  }
  return out;
}

/** 某个渠道的占比（百分数），无数据返回 undefined */
export function getChannelShare(tool: AITool, key: string): number | undefined {
  return channelSharesPct(tool)[key];
}

/**
 * 渠道访问量 = 月访问量 × 渠道占比。
 *
 * 不直接用库里存的绝对量：占比和总量来自同一次采集，乘出来一定自洽；
 * 而早一批数据的绝对量是「把 0.42 当百分数」算的，只有正确值的 1/100。
 */
export function getChannelVisits(tool: AITool, key: string): number | undefined {
  const visits = getMonthlyVisits(tool);
  const share = getChannelShare(tool, key);
  if (visits === undefined || share === undefined) return undefined;
  return Math.round((visits * share) / 100);
}

/**
 * 国家展示名：ISO 码 → 中文（ID → 印度尼西亚）。
 *
 * 采集结果里 countryName 是英文（Indonesia），中文页面直接用会像没翻译；
 * 用 Intl 的区域名表转换，不另外维护一份映射。
 */
const REGION_NAMES = new Intl.DisplayNames(["zh-CN"], { type: "region" });

export function countryLabel(code?: string | null): string | undefined {
  if (!code) return undefined;
  const key = code.trim().toUpperCase();
  if (key.length !== 2) return code;
  try {
    const name = REGION_NAMES.of(key);
    return name && name !== key ? name : code;
  } catch {
    return code;
  }
}

/** 环比增长 %：vortex 优先，回退存量 metrics */
export function getMoMGrowth(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisitsGrowth ?? tool.metrics?.momGrowth;
}

/**
 * 自然搜索量：先用渠道占比 × 总访问量（与「渠道结构」同源、必然自洽），
 * 再回退库里存的绝对量。历史绝对量是按小数当百分数算的，会偏小 100 倍。
 */
export function getOrganicVisits(tool: AITool): number | undefined {
  return (
    getChannelVisits(tool, "organicSearch") ??
    tool.trafficMetrics?.organicSearchVisits ??
    tool.metrics?.organicVisits
  );
}

/**
 * 趋势点是否属于「待累积」的占位月份（不是真实的 0 访问）。
 *
 * 新数据带 `collected: false` 标记，直接信任它。存量数据没这个标记，
 * 但首尾连续为 0 的点必然是当年补的月份（网页流量不会真的从 0 起步再爬升）：
 * 不识别出来的话，趋势图会画出一条从 0 冲上峰值的假爆涨。
 * 中间夹着 0 的情况不当占位，那是真断档，照常画。
 */
export function pendingTrendFlags(points: { total?: number; collected?: boolean }[]): boolean[] {
  const flags = points.map((p) => p.collected === false);
  const isLegacyZero = (p?: { total?: number; collected?: boolean }) =>
    p?.collected === undefined && (p?.total ?? 0) <= 0;

  for (let i = 0; i < points.length && isLegacyZero(points[i]); i++) flags[i] = true;
  for (let j = points.length - 1; j >= 0 && isLegacyZero(points[j]); j--) flags[j] = true;
  return flags;
}

/**
 * 上线时间：launchedAt（Wayback 首快照）优先，回退域名注册时间。
 * 注册时间不可信（如 .ai 2017-12 注册局迁移日）时不回退，避免把迁移日当成上线时间。
 */
export function getLaunchedAt(tool: AITool): string | undefined {
  if (tool.launchedAt) return tool.launchedAt;
  if (tool.metrics?.registeredAtSuspect) return undefined;
  return tool.metrics?.registeredAt;
}

/** 分类中文名（当前仅中文页面使用，英文页面后续补齐） */
export const categoryLabels: Record<string, string> = {
  "AI Chat": "AI 对话",
  Automation: "自动化",
  Coding: "编程开发",
  "Data & Analytics": "数据与分析",
  "Image Gen": "图像生成",
  Marketing: "营销",
  Other: "其他",
  Productivity: "效率",
  Video: "视频",
  "Voice & Audio": "语音与音频",
  Writing: "写作",
  Agent: "智能体",
  Inference: "模型推理",
  RAG: "知识库检索",
};

/** 旧数据里的无信息量占位语，读到后忽略 */
const LEGACY_TAGLINE = /能收钱的小产品/;

/**
 * 项目简介：优先真实中文定位（精编 / 大模型生成），
 * 没有就回落到 GitHub 上的原始项目简介，保证每条都不一样。
 */
export function repoIntro(r: GitHubRepo): string {
  const tagline = r.insight?.taglineZh?.trim();
  if (tagline && !LEGACY_TAGLINE.test(tagline)) return tagline;
  const desc = r.description?.trim();
  if (desc) return desc;
  return `${categoryLabel(r.categories[0] ?? "Other")} 方向的开源项目`;
}

/** 上手难度（情报优先，默认中） */
export function repoDifficulty(r: GitHubRepo): "低" | "中" | "高" {
  return r.insight?.difficulty ?? "中";
}

export function categoryLabel(cat: string): string {
  return categoryLabels[cat] ?? cat;
}

/**
 * 自然搜索占比 %。
 * 只能用同源的全渠道数据（SimilarWeb 的 organic / total）计算：
 * DFS 的 metrics.organicVisits / monthlyVisits 是「搜索渠道内部」的构成（organic + paid = total），
 * 付费搜索为 0 时比值恒等于 100%，与直接访问/引荐/社媒无关，不能当作全渠道占比。
 */
export function getOrganicShare(tool: AITool): number | undefined {
  // 渠道结构里的 organicSearch 是同一份全渠道口径，与「渠道结构」那块天然一致
  const fromChannel = getChannelShare(tool, "organicSearch");
  if (fromChannel !== undefined) return fromChannel;
  if (tool.metrics?.organicShare !== undefined) return toPercent(tool.metrics.organicShare);
  const tm = tool.trafficMetrics;
  if (tm?.organicSearchVisits !== undefined && tm?.monthlyVisits) {
    return (tm.organicSearchVisits / tm.monthlyVisits) * 100;
  }
  return undefined;
}

/** 分页 */
export function paginate<T>(list: T[], page: number, pageSize: number): T[] {
  return list.slice((page - 1) * pageSize, page * pageSize);
}

/** 首页多榜单切片 */
/**
 * 首页榜单数据：跟随当前库内实际分布（175 个工具），
 * 分类板块只取工具数最多的 6 个分类，避免首页拉出十几个半空板块。
 */
export function getBoards() {
  const sorted = getToolsSorted();
  const newest = [...listedTools].sort((a, b) =>
    b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
  const byCategory = allCategories
    .map((cat) => {
      const items = sorted.filter((t) => t.categories.includes(cat));
      return { category: cat, total: items.length, items: items.slice(0, 8) };
    })
    .filter((b) => b.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);
  return {
    hot: sorted.slice(0, 10),
    newest: newest.slice(0, 10),
    byCategory,
  };
}

/** 首页 GitHub 榜：按综合得分取前 N，附得分与分级 */
export function getGithubTop(limit = 8) {
  return getReposByScore()
    .slice(0, limit)
    .map((repo) => ({ repo, score: repoScore(repo) }));
}

/* ------------------------------- GitHub 榜单 ------------------------------- */

export const allGithubCategories = [
  "AI Chat",
  "Image Gen",
  "Video",
  "Voice & Audio",
  "Writing",
  "Coding",
  "Automation",
  "Marketing",
  "Productivity",
  "Data & Analytics",
  "Agent",
  "Inference",
  "RAG",
  "Other",
] as const;

export function getRepoByFullName(fullName: string): GitHubRepo | undefined {
  return githubRepos.find((r) => r.fullName === fullName);
}

/** 综合得分：优先用采集时算好的，缺失时前端兜底计算（保证榜单永远有分） */
export function repoScore(r: GitHubRepo): ProductScore {
  return r.productScore ?? computeProductScore(r);
}

/** 得分等级配色 */
export const scoreGradeTone: Record<ProductScore["grade"], string> = {
  S: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  A: "border-primary/40 bg-primary/10 text-primary",
  B: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  C: "border-border bg-surface-2 text-ink-muted",
};

/** 榜单默认顺序：综合得分降序 */
export function getReposByScore(): GitHubRepo[] {
  return [...githubRepos].sort(compareByScore);
}

/** 最近更新距今多少天 */
export function repoUpdatedDays(r: GitHubRepo): number | null {
  if (!r.pushedAt) return null;
  const t = Date.parse(r.pushedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

export function getGithubLanguages(): string[] {
  const set = new Set<string>();
  githubRepos.forEach((r) => r.language && set.add(r.language));
  return [...set].sort();
}

/** 近 N 天 Star 增量 %；历史不足返回 null */
/**
 * 近 N 天 Star 增量 %。
 * 只使用真实采样点：synthetic=true 是 backfillHistory 按当前星标反推的估算值，
 * 包含它们会得出「所有项目都在匀速上涨」的假结论，因此一律剔除。
 */
export function computeStarGrowth(repo: GitHubRepo, days: number): number | null {
  const h = [...(repo.history ?? [])]
    .filter((p) => !p.synthetic)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const target =
    h.find((p) => (Date.parse(last.date) - Date.parse(p.date)) / 86_400_000 >= days - 1) ??
    h[0];
  const prev = target.stars;
  if (prev <= 0) return null;
  const span = (Date.parse(last.date) - Date.parse(target.date)) / 86_400_000;
  if (span < 7) return null; // 采样跨度不足 7 天，增速没有意义
  return Math.round(((last.stars - prev) / prev) * 1000) / 10;
}

/** Star 趋势 sparkline 点（0-1 归一化），取最近 maxPoints 天 */
export function starSparklinePoints(repo: GitHubRepo, maxPoints = 30): number[] | null {
  const h = [...(repo.history ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-maxPoints);
  if (h.length < 2) return null;
  const vals = h.map((p) => p.stars);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  return vals.map((v) => (v - min) / range);
}

/** 是否宽松许可证（可商用） */
const PERMISSIVE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "Unlicense",
  "MPL-2.0",
  "ISC",
  "0BSD",
  "MIT-0",
]);
export function isPermissiveLicense(repo: GitHubRepo): boolean {
  const spdx = repo.license?.spdx;
  return !!spdx && PERMISSIVE.has(spdx);
}
