import type {
  AITrend,
  OpportunityScoreParts,
  TrendCategory,
  TrendConfidence,
  TrendDataset,
  TrendScoreParts,
  TrendStatus,
} from "@horizons/shared";
import trendsData from "@content/trends.json";

const ds = trendsData as unknown as TrendDataset;

export const trendKeywords: AITrend[] = ds.keywords ?? [];
/** seed = 结构演示数据；live = 已接入真实采集 */
export const trendDataMode = ds.mode ?? "seed";
export const trendsUpdatedAt = ds.updatedAt ?? "";
export const trendRegion = ds.region ?? "US";

/* ------------------------------- 展示字典 ------------------------------- */

export const trendCategoryLabels: Record<TrendCategory, string> = {
  model: "AI 模型与品牌",
  tool: "AI 工具与应用",
  agent: "AI Agent 与工作流",
  devtech: "AI 开发技术",
  usecase: "AI 使用场景",
  business: "AI 商业与行业动态",
  broadtech: "广义科技趋势",
};

export const trendStatusMeta: Record<
  TrendStatus,
  { label: string; hint: string; cls: string; dot: string }
> = {
  breaking: {
    label: "正在爆发",
    hint: "短期显著放量，且多时点证据排除单点噪声",
    cls: "border-rose-400/30 bg-rose-400/10 text-rose-400",
    dot: "bg-rose-400",
  },
  gaining: {
    label: "持续增长",
    hint: "多个时间点持续高于基线，增长更稳定",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
    dot: "bg-emerald-500",
  },
  new: {
    label: "新词观察",
    hint: "最近才发现，历史数据不足，暂不宣称爆发",
    cls: "border-primary/30 bg-primary/10 text-primary",
    dot: "bg-primary",
  },
  cooling: {
    label: "热度回落",
    hint: "已低于爆发峰值，向历史基线回归",
    cls: "border-border bg-surface-2 text-ink-muted",
    dot: "bg-ink-muted",
  },
};

export const trendConfidenceMeta: Record<
  TrendConfidence,
  { label: string; hint: string; cls: string }
> = {
  high: {
    label: "高",
    hint: "多个有效采样点 + 持续高于基线 + 独立来源支持",
    cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500",
  },
  medium: {
    label: "中",
    hint: "有趋势证据，但采样点或独立来源不足",
    cls: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  },
  low: {
    label: "低",
    hint: "历史数据不足或基线不稳定，仅作观察",
    cls: "border-border bg-surface-2 text-ink-muted",
  },
};

export const claimTypeMeta = {
  fact: { label: "已验证事实", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" },
  inference: { label: "合理推断", cls: "border-amber-500/30 bg-amber-500/10 text-amber-500" },
  hypothesis: { label: "待验证假设", cls: "border-border bg-surface-2 text-ink-muted" },
} as const;

export const intentLabels: Record<string, string> = {
  learn: "了解概念",
  howto: "使用方法",
  problem: "解决问题",
  compare: "替代对比",
  price: "价格查询",
  alternative: "寻找替代",
};

export const opportunityTypeMeta: Record<
  string,
  { label: string; cls: string }
> = {
  content: { label: "内容机会", cls: "border-primary/30 bg-primary/10 text-primary" },
  product: { label: "产品机会", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" },
  opensource: { label: "开源机会", cls: "border-amber-500/30 bg-amber-500/10 text-amber-500" },
  feature: { label: "功能机会", cls: "border-border bg-surface-2 text-ink-secondary" },
};

export const verdictMeta: Record<string, { label: string; cls: string }> = {
  research: { label: "立即研究", cls: "border-primary/30 bg-primary/10 text-primary" },
  content: { label: "先做内容验证", cls: "border-amber-500/30 bg-amber-500/10 text-amber-500" },
  mvp: { label: "做最小可行产品", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" },
  watch: { label: "继续观察", cls: "border-border bg-surface-2 text-ink-muted" },
};

export const sourceKindLabels: Record<string, string> = {
  google_trends: "搜索趋势",
  official: "官方来源",
  news: "新闻报道",
  community: "社区讨论",
  repo: "开源仓库",
  serp: "搜索结果",
};

/* ------------------------------- 指标计算 ------------------------------- */

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(list: number[]): number | null {
  if (list.length === 0) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}

function addDays(start: string, days: number): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return start;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 序列展开为 {date, value} */
export function seriesPoints(t: AITrend): { date: string; value: number }[] {
  const step = t.series.stepDays || 1;
  return t.series.values.map((value, i) => ({ date: addDays(t.series.start, i * step), value }));
}

/** 采样点不足 14 个视为「数据不足，暂不评分」 */
export function hasEnoughData(t: AITrend): boolean {
  return t.series.values.length >= 14;
}

export interface TrendMetrics {
  samples: number;
  spanDays: number;
  baseline: number | null;
  recent7: number | null;
  growth7: number | null;
  growth30: number | null;
  peak: number;
  peakDate: string | null;
  /** 近 14 个采样点中高于基线的点数 */
  aboveBaseline: number;
  window: number;
}

/**
 * 趋势指标全部由序列确定性计算，页面不写死数字：
 * 基线 = 最近 7 点之前的均值；增长 = (近期均值 − 基线) / 基线。
 */
export function trendMetrics(t: AITrend): TrendMetrics {
  const values = t.series.values;
  const n = values.length;
  const cut = Math.max(1, n - 7);
  const baseline = mean(values.slice(0, cut));
  const recent7 = mean(values.slice(cut));
  const peak = n > 0 ? Math.max(...values) : 0;
  const peakIndex = n > 0 ? values.indexOf(peak) : -1;
  const window = Math.min(14, n);
  const tail = values.slice(n - window);
  const aboveBaseline =
    baseline === null ? 0 : tail.filter((v) => v > baseline).length;

  const first7 = mean(values.slice(0, Math.min(7, n)));
  const growth7 =
    baseline && baseline > 0 && recent7 !== null
      ? round1(((recent7 - baseline) / baseline) * 100)
      : null;
  const growth30 =
    first7 && first7 > 0 && recent7 !== null
      ? round1(((recent7 - first7) / first7) * 100)
      : null;

  return {
    samples: n,
    spanDays: n * (t.series.stepDays || 1),
    baseline: baseline === null ? null : round1(baseline),
    recent7: recent7 === null ? null : round1(recent7),
    growth7,
    growth30,
    peak,
    peakDate:
      peakIndex >= 0
        ? addDays(t.series.start, peakIndex * (t.series.stepDays || 1))
        : null,
    aboveBaseline,
    window,
  };
}

/** 列表迷你曲线：0-1 归一化 */
export function trendSparkline(t: AITrend, maxPoints = 30): number[] | null {
  const values = t.series.values.slice(-maxPoints);
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => (v - min) / range);
}

/* ------------------------------- 评分 ------------------------------- */

/** 趋势强度分权重：增长 30 / 持续 25 / 爆发 20 / 新颖 15 / 可靠 10 */
export const TREND_WEIGHTS: { key: keyof TrendScoreParts; label: string; weight: number }[] = [
  { key: "growth", label: "增长幅度", weight: 0.3 },
  { key: "persistence", label: "持续性", weight: 0.25 },
  { key: "breakout", label: "爆发强度", weight: 0.2 },
  { key: "novelty", label: "新颖度", weight: 0.15 },
  { key: "reliability", label: "数据可靠性", weight: 0.1 },
];

/** 机会潜力分权重：需求 30 / 切入 25 / SEO 20 / 可行 15 / 时机 10 */
export const OPPORTUNITY_WEIGHTS: {
  key: keyof OpportunityScoreParts;
  label: string;
  weight: number;
}[] = [
  { key: "demand", label: "用户需求证据", weight: 0.3 },
  { key: "wedge", label: "可切入空间", weight: 0.25 },
  { key: "seo", label: "搜索与内容机会", weight: 0.2 },
  { key: "feasibility", label: "独立开发可行性", weight: 0.15 },
  { key: "timing", label: "趋势时机", weight: 0.1 },
];

/** T = 0.30G + 0.25P + 0.20B + 0.15N + 0.10R */
export function trendScore(t: AITrend): number {
  return round1(
    TREND_WEIGHTS.reduce((sum, w) => sum + w.weight * t.trendParts[w.key], 0),
  );
}

/** O = 0.30D + 0.25M + 0.20S + 0.15F + 0.10W */
export function opportunityScore(t: AITrend): number {
  return round1(
    OPPORTUNITY_WEIGHTS.reduce((sum, w) => sum + w.weight * t.oppParts[w.key], 0),
  );
}

export function scoreTone(score: number): string {
  if (score >= 75) return "text-emerald-500";
  if (score >= 55) return "text-ink";
  return "text-ink-muted";
}

/** 系统建议：由两个分数推导，页面可解释 */
export function systemVerdict(t: AITrend): { label: string; cls: string } {
  if (!hasEnoughData(t)) {
    return { label: "数据不足，暂不评分", cls: "border-border bg-surface-2 text-ink-muted" };
  }
  const tv = trendScore(t);
  const op = opportunityScore(t);
  if (tv >= 70 && op >= 65) {
    return { label: "值得研究，先验证需求", cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" };
  }
  if (tv >= 70 && op < 50) {
    return { label: "热度高但切入拥挤，建议只做内容", cls: "border-amber-500/30 bg-amber-500/10 text-amber-500" };
  }
  if (tv >= 50) {
    return { label: "可观察，等待更多证据", cls: "border-primary/30 bg-primary/10 text-primary" };
  }
  return { label: "暂不投入", cls: "border-border bg-surface-2 text-ink-muted" };
}

/* ------------------------------- 查询 ------------------------------- */

export function getTrendBySlug(slug: string): AITrend | undefined {
  return trendKeywords.find((t) => t.slug === slug);
}

export type TrendSort = "trend" | "opp" | "growth" | "newest";

export function sortTrends(list: AITrend[], sort: TrendSort): AITrend[] {
  const copy = [...list];
  if (sort === "opp") {
    return copy.sort((a, b) => opportunityScore(b) - opportunityScore(a));
  }
  if (sort === "growth") {
    return copy.sort(
      (a, b) => (trendMetrics(b).growth7 ?? -Infinity) - (trendMetrics(a).growth7 ?? -Infinity),
    );
  }
  if (sort === "newest") {
    return copy.sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt));
  }
  return copy.sort(
    (a, b) => (hasEnoughData(b) ? trendScore(b) : -1) - (hasEnoughData(a) ? trendScore(a) : -1),
  );
}

export function trendsByStatus(status: TrendStatus, limit?: number): AITrend[] {
  const list = sortTrends(
    trendKeywords.filter((t) => t.status === status),
    "trend",
  );
  return limit ? list.slice(0, limit) : list;
}

/** 同类别优先，其次按趋势分 */
export function getRelatedTrends(t: AITrend, limit = 4): AITrend[] {
  return [...trendKeywords]
    .filter((x) => x.slug !== t.slug)
    .sort((a, b) => {
      const ca = a.category === t.category ? 1 : 0;
      const cb = b.category === t.category ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return trendScore(b) - trendScore(a);
    })
    .slice(0, limit);
}

export function formatGrowth(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n}%`;
}

export function growthTone(n: number | null): string {
  if (n === null) return "text-ink-muted";
  if (n > 0) return "text-emerald-500";
  if (n < 0) return "text-rose-400";
  return "text-ink-secondary";
}

/** 首次发现距今多少天（以数据集快照时间为基准，避免构建期漂移） */
export function daysSince(dateStr: string): number | null {
  const a = Date.parse(`${dateStr}T00:00:00Z`);
  const b = Date.parse(trendsUpdatedAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}