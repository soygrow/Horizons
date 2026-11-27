import {
  compareByScore,
  compareByToolScore,
  computeProductScore,
  isListed,
  tierOf,
} from "@horizons/shared";
import type { AITool, GitHubRepo, ProductScore } from "@horizons/shared";
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
 * 榜单条数上限（产品口径：榜单稳定维护 3000 条，新工具按综合分替换尾部）。
 * 达标数不足 3000 时全部展示，因此对现有 200 余条数据不产生任何影响；
 * 只有候选池扩大到达标数超过 3000 后才开始截断。
 *
 * 2026-11-27 从 1000 上调到 3000：榜单规模计划逐步扩充，
 * 改这里即可（tool-stats.ts 的 TARGET_LISTED 必须同步，构建产物的截断口径跟它走）。
 */
export const MAX_LISTED_TOOLS = 3000;

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

/*
 * 纯字段推导函数已迁到 ./tool-fields：详情页改为按需渲染后要进 Worker bundle，
 * 不能顺着这个文件把 23MB JSON 一起带进去。这里重新导出，既有 import 路径不变。
 */
export * from "./tool-fields";


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
