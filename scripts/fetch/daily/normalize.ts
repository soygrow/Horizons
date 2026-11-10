// 归一化：把三种来源统一成同一套 RawItem 字段。
// 这一层的目标是「可比」，不是「判好坏」。

import crypto from "node:crypto";
import { keywordGroups } from "./config";
import type { RawItem, SourceName } from "./types";

/** 追踪参数清单：只清这些，其余查询参数保留（有些站点的正文靠它们定位） */
const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "ref",
  "ref_src",
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
];

/**
 * 规范化 URL：小写主机、去追踪参数与锚点、去尾部斜杠。
 * 用于跨源去重——同一个链接带不同 utm 必须合并成一条。
 */
export function canonicalUrl(input: string): string {
  try {
    const u = new URL(input.trim());
    u.hash = "";
    u.host = u.host.toLowerCase().replace(/^www\./, "");
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return input.trim();
  }
}

export function cleanTitle(input: string): string {
  return input
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/<[^>]+>/g, " ")
    // 数字实体先解，否则 &amp;#8217; 这类会残留成乱码
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;|&lsquo;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** 内容指纹：链接优先，没有链接时退化为标题 */
export function contentHash(source: SourceName, url: string, title: string): string {
  const key = url ? canonicalUrl(url) : `${source}|${title.toLowerCase()}`;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/**
 * AI 相关性词表：用于把「科技新闻」收敛成「AI 情报」。
 * 短词必须按整词匹配，否则 ai 会命中 said / chair 之类的噪声。
 */
const AI_TERMS = [
  "ai",
  "llm",
  "gpt",
  "claude",
  "gemini",
  "llama",
  "mistral",
  "qwen",
  "deepseek",
  "kimi",
  "grok",
  "openai",
  "anthropic",
  "hugging face",
  "transformer",
  "diffusion",
  "inference",
  "fine-tune",
  "fine tune",
  "embedding",
  "agent",
  "mcp",
  "copilot",
  "chatbot",
  "machine learning",
  "neural",
  "gpu",
  "cuda",
  "multimodal",
  "text-to-image",
  "speech-to-text",
  "大模型",
  "人工智能",
  "智能体",
  "生成式",
  "多模态",
  "机器学习",
];

const SHORT_TERMS = new Set(["ai", "llm", "gpt", "gpu", "cuda", "mcp", "rag"]);

/**
 * 弱词：单独出现时与 AI 无关。
 * "agent" 就是典型——实测把「Undercover ICE Agents」的移民新闻当成了 Agent 情报，
 * 还进了头条。这类词必须有第二个弱词或强词兜底才算相关。
 */
const WEAK_TERMS = new Set(["agent", "transformer", "inference", "embedding", "neural", "gpu", "cuda", "mcp"]);

/** 返回命中的 AI 词，空数组表示与主题无关 */
export function aiMatch(text: string): string[] {
  const hay = ` ${text.toLowerCase()} `;
  return AI_TERMS.filter((term) =>
    SHORT_TERMS.has(term)
      ? new RegExp(`\\b${term}\\b`, "i").test(text)
      : hay.includes(term),
  );
}

export function isAiRelevant(text: string): boolean {
  const hits = aiMatch(text);
  if (hits.length === 0) return false;
  const strong = hits.filter((t) => !WEAK_TERMS.has(t));
  if (strong.length > 0) return true;
  // 全是弱词时要求至少两个，避免单词误命中
  return hits.length >= 2;
}

/** 命中哪些关键词组，用于分类与回溯 */
export function matchKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const [group, words] of Object.entries(keywordGroups)) {
    if (words.some((w) => lower.includes(w.toLowerCase()))) hits.push(group);
  }
  return hits;
}

/** 主分类：取第一个命中组，全不命中归为 other */
export function primaryCategory(text: string): string {
  return matchKeywords(text)[0] ?? "other";
}

export function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

export function round(value: number, digits = 0): number {
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

/** 建 RawItem 的唯一入口，保证各源字段形状一致 */
export function makeItem(input: {
  source: SourceName;
  sourceItemId: string;
  title: string;
  url: string;
  author?: string | null;
  publishedAt?: string | null;
  signals?: Record<string, number>;
  firstHand?: boolean;
  raw?: Record<string, unknown>;
  fetchedAt?: string;
  /** 分类用的附加文本（GitHub 用 description + topics，RSS 用摘要） */
  categoryText?: string;
}): RawItem {
  const title = cleanTitle(input.title) || "(无标题)";
  const url = canonicalUrl(input.url);
  /**
   * 分类只看标题；GitHub 例外，因为它没有语义标题。
   *
   * 摘要里出现「model」「workflow」这类词太容易了 —— AWS 的
   * 「How CrossnoKaye grounds physical AI with Bedrock AgentCore」是客户案例，
   * 却因为正文提到 model 被归进 model_release，拿到了模型发布的分类权重；
   * Simon Willison 的随笔「Yonkers Rises」也因摘要提到模型名被判成模型发布。
   *
   * 标题判不出来就归 other —— 退回摘要的代价是「凡是正文聊到模型都能蹭到
   * 分类权重」，那等于没有分类。仓库名（nace-ai/kapitsa）本身不含语义，
   * 只能靠 description + topics。
   */
  const matched =
    input.source === "github"
      ? matchKeywords(`${title} ${input.categoryText ?? ""}`)
      : matchKeywords(title);
  return {
    id: `${input.source}:${input.sourceItemId}`,
    source: input.source,
    sourceItemId: input.sourceItemId,
    title,
    url,
    author: input.author ?? null,
    publishedAt: input.publishedAt ?? null,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
    firstSeenAt: null,
    repeat: false,
    category: matched[0] ?? "other",
    signals: input.signals ?? {},
    firstHand: input.firstHand ?? false,
    matched,
    raw: input.raw ?? {},
  };
}

/** 窗口过滤：无发布时间的条目保留（人工录入常见），有时间的要求落在窗口内 */
export function withinWindow(item: RawItem, sinceIso: string): boolean {
  if (!item.publishedAt) return true;
  return item.publishedAt >= sinceIso;
}

export function windowStartIso(hours: number, now = new Date()): string {
  return new Date(now.getTime() - hours * 3600_000).toISOString();
}

/**
 * 源内信号强度。只在「同一个源内部」有意义：
 * HN 的分数和 GitHub 的 Star 数不能直接相加，合并排序前必须各自归一化。
 */
export function sourceSignalScore(item: RawItem): number {
  const s = item.signals;
  if (item.source === "hackernews") return (s.points ?? 0) + (s.comments ?? 0) * 1.5;
  if (item.source === "github") {
    // 有跨日采样就优先用真实增量；没有时退化为「平均每日得星」，并对超高值取对数压缩
    const delta = s.starDelta ?? 0;
    const perDay = Math.log10(1 + (s.starPerDay ?? 0)) * 120;
    return delta * 30 + perDay;
  }
  return 0;
}

/** 按源做 min-max 归一化到 0–100，避免某个源的量纲压过其他源 */
export function normalizeScores(items: RawItem[]): Map<string, number> {
  const groups = new Map<string, RawItem[]>();
  for (const item of items) {
    const list = groups.get(item.source) ?? [];
    list.push(item);
    groups.set(item.source, list);
  }
  const out = new Map<string, number>();
  for (const list of groups.values()) {
    const scores = list.map(sourceSignalScore);
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    const span = max - min;
    list.forEach((item, i) => {
      out.set(item.id, span === 0 ? 50 : Math.round(((scores[i] - min) / span) * 100));
    });
  }
  return out;
}