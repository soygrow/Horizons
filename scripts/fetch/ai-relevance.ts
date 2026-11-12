/**
 * A1 粗筛：从「名称 + 一句话简介」判断像不像 AI 产品。
 *
 * 为什么需要这一层：通用 launch 平台和 HN 首页既有 AI 工具也有 VPN、
 * 社交营销、人脸搜索这类产品。此前采集器把所有卡片都当候选，全靠人工在
 * 后台逐条拒，一次 10 条里能用的只有三四条。
 *
 * 这里是**关键词粗筛**，不是语义判断：
 *   - 命中任一 AI 信号 → 放行，交给人工/A4 继续判
 *   - 一个都不命中 → 判 A1 不通过
 *
 * 取向是「宁可漏掉，不可放过」：AI 产品基本都会在名字或 tagline 里提一句
 * AI / GPT / Agent / prompt，而通用产品的文案不会。真被误杀的条目会以
 * rejected 落库，后台点「恢复」即可救回，并在下一轮 JSON 里保留。
 */
import type { AITool } from "@horizons/shared";

/** 命任一条即视为 AI 相关。全部带词边界，避免 "email" 里的 ai、"chair" 里的 air 误命中 */
const AI_PATTERNS: readonly RegExp[] = [
  /\bai\b/i,
  /\ba\.i\./i,
  /artificial intelligence/i,
  /\bgpt\b/i,
  /\bllms?\b/i,
  /\bai[-\s]?agents?\b/i,
  /\bagentic\b/i,
  /\brag\b/i,
  /\bembeddings?\b/i,
  /fine[-\s]?tun/i,
  /chatbot|chat\s?bot/i,
  /copilot/i,
  /machine learning|deep learning|neural net/i,
  /generative|\bgen[-\s]?ai\b/i,
  /prompt/i,
  /text[-\s]to[-\s](image|video|speech|audio|voice|text)/i,
  /(image|video|voice|music)\s?gen(eration|erator)?\b/i,
  /transcri(be|pt|ption)/i,
  /summari[sz]e|summarization/i,
  /paraphrase|rewrit(e|ing) (with|using)/i,
  /openai|anthropic|chatgpt|claude|gemini|mistral|llama|stable diffusion|midjourney|deepseek|hugging ?face/i,
];

/** 返回命中的模式（用于日志），未命中返回 null */
export function aiSignalOf(text: string): string | null {
  for (const re of AI_PATTERNS) if (re.test(text)) return String(re);
  return null;
}

/**
 * 名称 + 简介是否像 AI 产品。
 *
 * 只看这两个字段：分类字段在多数源里恒为 "Other"，正文要富化之后才有，
 * 拿它们判会把整批都判成非 AI。
 */
export function looksLikeAiProduct(t: Pick<AITool, "name" | "description">): boolean {
  const text = `${t.name ?? ""} ${t.description ?? ""}`;
  return aiSignalOf(text) !== null;
}