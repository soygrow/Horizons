/**
 * 单个工具的纯字段推导函数（不触碰全量数据）。
 *
 * 为什么单独一个文件：`lib/data.ts` 顶层 import 了 aitools.json（5.9MB）和
 * github-web.json（17MB），任何引用它的组件都会把这 23MB 带进打包结果。
 * 详情页在改为按需渲染（/preview）后要进 Worker bundle，那是硬上限 ——
 * 所以详情组件链只允许依赖这里，`data.ts` 只给静态构建期的列表页用。
 *
 * 这里全部是「给一个 tool 对象，算出显示值」的纯函数，没有模块级状态，
 * 也没有对全量数组的引用。新增函数时请守住这条线。
 */
import type { AITool, GitHubRepo, PricingModel } from "@horizons/shared";

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

/** YYYY-MM 平移 n 个月 */
function shiftMonthKey(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 用当月访问量合成一条 6 个月趋势：只有快照那个月有值，其余补 0 并标 collected:false。
 *
 * 兜的是这一类坏数据：`traffic_history` 里没写成的月份被补 0 后整段覆盖过 trend，
 * 结果一个真实点都不剩，详情页只能显示「暂无历史数据」。
 * 单月也有单月的画法——前面几个月落回基线，读者能看出「这个月才起量」，
 * 往后每月采集补一格，曲线会自然长出来。
 */
export function trendFromMetrics(
  tool: AITool,
  count = 6,
): { date: string; total: number; organic: number; collected: boolean }[] {
  const tm = tool.trafficMetrics;
  const visits = tm?.monthlyVisits ?? tool.metrics?.monthlyVisits;
  const month = tm?.snapshotMonth ?? tool.dataSnapshot?.period;
  if (!visits || visits <= 0 || !month || !/^\d{4}-\d{2}$/.test(month)) return [];

  const organic = tm?.organicSearchVisits && tm.organicSearchVisits > 0 ? tm.organicSearchVisits : 0;
  return Array.from({ length: count }, (_, i) => {
    const date = shiftMonthKey(month, -(count - 1 - i));
    const isSnapshot = date === month;
    return {
      date,
      total: isSnapshot ? visits : 0,
      organic: isSnapshot ? organic : 0,
      collected: isSnapshot,
    };
  });
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