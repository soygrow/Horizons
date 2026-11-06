/** 文案映射：与 data.ts 一致 */

export type PricingModel = "free" | "freemium" | "paid";

export const pricingModelLabels: Record<PricingModel, string> = {
  free: "免费",
  freemium: "免费增值",
  paid: "付费",
};

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

export function categoryLabel(cat: string): string {
  return categoryLabels[cat] ?? cat;
}

/** 得分分级配色（与源站 scoreGradeTone 一致） */
export const scoreGradeTone: Record<"S" | "A" | "B" | "C", string> = {
  S: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  A: "border-primary/40 bg-primary/10 text-primary",
  B: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  C: "border-border bg-surface-2 text-ink-muted",
};