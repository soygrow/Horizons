import type {
  AITrend,
  OpportunityScoreParts,
  TrendConfidence,
  TrendScoreParts,
  TrendSeries,
  TrendSourceRef,
  TrendStatus,
} from "@horizons/shared";

/**
 * 序列 → 趋势强度分（确定性，可离线重算）。
 * 与前端 lib/trends.ts 的指标口径保持一致：基线 = 最近 7 点之前的均值。
 */

export interface SeriesMetrics {
  samples: number;
  baseline: number;
  recent7: number;
  growth7: number | null;
  peak: number;
  aboveBaseline: number;
  window: number;
}

const clamp = (n: number, min = 0, max = 100): number =>
  Math.max(min, Math.min(max, Math.round(n)));

const mean = (arr: number[]): number =>
  arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;

export function seriesMetrics(series: TrendSeries): SeriesMetrics {
  const values = series.values;
  const n = values.length;
  const cut = Math.max(1, n - 7);
  const baseline = mean(values.slice(0, cut));
  const recent7 = mean(values.slice(cut));
  const peak = n > 0 ? Math.max(...values) : 0;
  const window = Math.min(14, n);
  const aboveBaseline = values.slice(n - window).filter((v) => v > baseline).length;
  const growth7 = baseline > 0 ? Math.round(((recent7 - baseline) / baseline) * 1000) / 10 : null;
  return { samples: n, baseline, recent7, growth7, peak, aboveBaseline, window };
}

function daysBetween(fromDate: string, toDate: string): number {
  const a = Date.parse(`${fromDate}T00:00:00Z`);
  const b = Date.parse(`${toDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * 五维映射（每维 0–100）：
 * - growth：tanh 压缩增长率，避免低基线爆出离谱数值
 * - persistence：近 14 点中高于基线的比例
 * - breakout：峰值/基线 倍数的 log2 映射
 * - novelty：首次发现越近越高（随时间衰减）
 * - reliability：采样点 + 日粒度 + 独立来源数
 */
export function computeTrendParts(
  series: TrendSeries,
  firstSeenAt: string,
  today: string,
  sources: TrendSourceRef[],
): TrendScoreParts {
  const m = seriesMetrics(series);
  const g = m.growth7 ?? 0;
  const growth = clamp(50 + 50 * Math.tanh(g / 120));

  const persistence = clamp((m.aboveBaseline / Math.max(1, m.window)) * 100);

  const ratio = m.baseline > 0 ? m.peak / m.baseline : 1;
  const breakout = clamp(ratio <= 1 ? 20 : 20 + 22 * Math.log2(ratio));

  const age = daysBetween(firstSeenAt, today);
  const novelty = clamp(100 - age * 3, 10, 100);

  const independent = new Set(
    sources.filter((s) => s.kind !== "google_trends").map((s) => s.kind),
  ).size;
  const reliability = clamp(
    40 * Math.min(1, m.samples / 30) +
      30 * (series.stepDays === 1 ? 1 : 0.5) +
      15 * Math.min(2, independent),
  );

  return { growth, persistence, breakout, novelty, reliability };
}

/** 阶段判定：数据不足 → 新词观察；爆发需要「高增长 + 贴近峰值 + 多点数超基线」 */
export function deriveStatus(series: TrendSeries): TrendStatus {
  const m = seriesMetrics(series);
  if (m.samples < 14) return "new";

  const nearPeak = m.peak > 0 ? m.recent7 >= m.peak * 0.8 : false;
  const g = m.growth7 ?? 0;

  if (g >= 120 && nearPeak && m.aboveBaseline >= 10) return "breaking";
  if (g >= 25 && m.aboveBaseline >= 7) return "gaining";
  if (m.peak > 0 && m.recent7 < m.peak * 0.75 && g < 0) return "cooling";
  return g >= 0 ? "gaining" : "cooling";
}

/** 可信度：采样点 + 超基线点数 + 独立来源类型 */
export function deriveConfidence(
  series: TrendSeries,
  sources: TrendSourceRef[],
): TrendConfidence {
  const m = seriesMetrics(series);
  const independent = new Set(
    sources.filter((s) => s.kind !== "google_trends").map((s) => s.kind),
  ).size;
  if (m.samples >= 30 && m.aboveBaseline >= 10 && independent >= 2) return "high";
  if (m.samples >= 21 && m.aboveBaseline >= 6) return "medium";
  return "low";
}

const OPP_KEYS: (keyof OpportunityScoreParts)[] = [
  "demand",
  "wedge",
  "seo",
  "feasibility",
  "timing",
];

/** LLM 给的机会分：逐项夹到 0–100，缺失项用趋势分兜底 */
export function sanitizeOppParts(
  input: Partial<Record<keyof OpportunityScoreParts, unknown>> | undefined,
  trendParts: TrendScoreParts,
): OpportunityScoreParts {
  const fallback: OpportunityScoreParts = {
    demand: clamp(trendParts.growth * 0.8),
    wedge: 50,
    seo: 50,
    feasibility: 55,
    timing: clamp(trendParts.novelty * 0.7 + 20),
  };
  const out = { ...fallback };
  for (const key of OPP_KEYS) {
    const v = input?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = clamp(v);
  }
  return out;
}

/** 离线重算：不联网，只按最新口径刷新序列相关字段 */
export function rescore(trend: AITrend, today: string): AITrend {
  const trendParts = computeTrendParts(trend.series, trend.firstSeenAt, today, trend.sources);
  return {
    ...trend,
    trendParts,
    status: deriveStatus(trend.series),
    confidence: deriveConfidence(trend.series, trend.sources),
  };
}