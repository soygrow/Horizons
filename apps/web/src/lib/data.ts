import type { AITool, PricingModel } from "@horizons/shared";
import toolsData from "@content/aitools.json";

export const tools = toolsData as AITool[];

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

/** 按热度降序 */
export function getToolsSorted(): AITool[] {
  return [...tools].sort((a, b) => b.heatScore - a.heatScore);
}

export function getToolByDomain(domain: string): AITool | undefined {
  return tools.find((t) => t.domain === domain);
}

/** 相似工具：按共享分类数量排序 */
export function getSimilarTools(tool: AITool, limit = 6): AITool[] {
  const set = new Set(tool.categories);
  return tools
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

/** 月访问量：vortex(SimilarWeb) 优先，回退 DFS metrics */
export function getMonthlyVisits(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisits ?? tool.metrics?.monthlyVisits;
}

/** 环比增长 %：vortex 优先，回退 DFS metrics */
export function getMoMGrowth(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisitsGrowth ?? tool.metrics?.momGrowth;
}

/** 自然搜索量：vortex 优先，回退 DFS metrics */
export function getOrganicVisits(tool: AITool): number | undefined {
  return tool.trafficMetrics?.organicSearchVisits ?? tool.metrics?.organicVisits;
}

/** 域名权重（DR）：数值 + 展示标签 */
export function getDomainWeight(tool: AITool): { value?: number; label?: string } {
  return { value: tool.metrics?.domainWeight, label: tool.metrics?.domainWeightLabel };
}

/** 注册 / 上线时间：launchedAt 优先，回退 WHOIS registeredAt */
export function getLaunchedAt(tool: AITool): string | undefined {
  return tool.launchedAt ?? tool.metrics?.registeredAt;
}

/** 分页 */
export function paginate<T>(list: T[], page: number, pageSize: number): T[] {
  return list.slice((page - 1) * pageSize, page * pageSize);
}

/** 首页多榜单切片 */
export function getBoards() {
  const sorted = getToolsSorted();
  const newest = [...tools].sort((a, b) =>
    b.firstSeenAt.localeCompare(a.firstSeenAt),
  );
  return {
    hot: sorted.slice(0, 8),
    newest: newest.slice(0, 8),
    byCategory: allCategories
      .map((cat) => ({
        category: cat,
        items: sorted.filter((t) => t.categories.includes(cat)).slice(0, 5),
      }))
      .filter((b) => b.items.length > 0),
  };
}
