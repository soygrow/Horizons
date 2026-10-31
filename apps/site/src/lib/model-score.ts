/**
 * AI 模型榜口径：标签、价格与规格格式化、评分。
 *
 * 评分只回答两件事：
 *   能力分 Capability —— 模型自身能力（数据源给出，0–100）
 *   性价比分 Value    —— 能力 ÷ 平均单价，样本内 min-max 归一到 40–100
 *   综合得分 Score    —— 0.9 × 能力 + 0.1 × 性价比（能力主导，性价比只做同档微调）
 */

export const modelModalityLabels: Record<string, string> = {
  text: "文本",
  multimodal: "多模态",
  reasoning: "推理",
  code: "代码",
  image: "图像",
  video: "视频",
  audio: "语音",
  embedding: "向量",
};

/** tokens 数量缩写：400000 → 400K，2000000 → 2M */
export function formatTokens(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return `${Number.isInteger(v) ? v : v.toFixed(1)}K`;
  }
  return String(n);
}

/** 单价展示：0.03 → $0.03，0.006 → $0.006，2.6 → $2.60；null → 待核实 */
export function priceText(v: number | null): string {
  if (v === null || v === undefined || v <= 0) return "待核实";
  if (v < 0.1) return `$${v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}

export function priceTone(v: number | null): string {
  if (v === null) return "text-ink-muted";
  if (v <= 0.5) return "text-emerald-500";
  if (v <= 3) return "text-ink";
  return "text-amber-500";
}

export function gradeOf(score: number): "S" | "A" | "B" | "C" {
  if (score >= 85) return "S";
  if (score >= 78) return "A";
  if (score >= 70) return "B";
  return "C";
}

/** 能力档位文案（能力分为校准估算，用于分档而非绝对排名） */
export function tierLabel(capability: number): string {
  if (capability >= 95) return "第一梯队";
  if (capability >= 88) return "主力梯队";
  if (capability >= 80) return "可用梯队";
  if (capability >= 70) return "轻量梯队";
  return "入门梯队";
}

/** 平均单价（输入、输出各占一半） */
export function avgPrice(priceIn: number | null, priceOut: number | null): number | null {
  if (priceIn === null && priceOut === null) return null;
  const i = priceIn ?? priceOut ?? 0;
  const o = priceOut ?? priceIn ?? 0;
  return (i + o) / 2;
}

/**
 * 性价比分：能力 ÷ 平均单价，样本内 min-max 归一到 30–100。
 * 单价缺失的模型给 0（不参与性价比排名）。
 */
export function valueScores(
  items: { slug: string; capability: number; priceIn: number | null; priceOut: number | null }[],
): Map<string, number> {
  const ratios: { slug: string; ratio: number }[] = [];
  for (const m of items) {
    const p = avgPrice(m.priceIn, m.priceOut);
    if (p === null || p <= 0) {
      ratios.push({ slug: m.slug, ratio: 0 });
      continue;
    }
    ratios.push({ slug: m.slug, ratio: m.capability / Math.max(p, 0.05) });
  }
  const positive = ratios.filter((r) => r.ratio > 0).map((r) => r.ratio);
  const min = positive.length ? Math.min(...positive) : 0;
  const max = positive.length ? Math.max(...positive) : 0;
  const span = max - min || 1;

  const out = new Map<string, number>();
  for (const r of ratios) {
    out.set(r.slug, r.ratio > 0 ? Math.round(40 + ((r.ratio - min) / span) * 60) : 0);
  }
  return out;
}

/** 综合得分：0.9 × 能力 + 0.1 × 性价比（性价比缺失时按能力计） */
export function overallScore(capability: number, value: number): number {
  const v = value > 0 ? value : capability;
  return Math.round((capability * 0.9 + v * 0.1) * 10) / 10;
}

/** 一个月 1000 万输入 + 200 万输出的估算成本（USD） */
export function monthlyCost(priceIn: number | null, priceOut: number | null): number | null {
  if (priceIn === null && priceOut === null) return null;
  return (priceIn ?? 0) * 10 + (priceOut ?? 0) * 2;
}

export const gradeTone: Record<string, string> = {
  S: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  A: "border-primary/40 bg-primary/10 text-primary",
  B: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  C: "border-border bg-surface-2 text-ink-muted",
};