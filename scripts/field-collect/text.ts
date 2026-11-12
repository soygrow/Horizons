/**
 * 文本类字段：AI 工具分类 / 核心功能 / 目标用户（文档第 1 节「自行提取」的三个）
 * 和首页关键词密度 / 文本总词数（文档第 6 节，AITDK 模式的本地等价物）。
 *
 * 分类这三个字段文档没给接口，只能靠模型理解页面内容。有 DEEPSEEK_API_KEY 就走 LLM，
 * 没 key 或调用失败退回关键词规则 —— 规则命中率明显更低，所以 actualSource 会写明
 * 走的是哪条路，避免把「规则猜的」当成「模型判断的」。
 */
import { truncate } from "./util";

export interface ProfileParsed {
  category: string | null;
  features: string | null;
  targetAudience: string | null;
  source: "deepseek" | "heuristic";
  note?: string;
}

/* ------------------------------ 关键词规则分类 ------------------------------ */

const CATEGORY_RULES: { category: string; keywords: RegExp }[] = [
  { category: "AI 编程", keywords: /\b(code|coding|developer|programming|ide|copilot|repo|debug)\b|代码|编程/i },
  { category: "AI 写作", keywords: /\b(writ|copywrit|blog|content|essay|paraphras|文案|写作)\w*/i },
  { category: "AI 图像", keywords: /\b(image|photo|picture|logo|design|illustrat|avatar|图片|设计|绘图)\w*/i },
  { category: "AI 视频", keywords: /\b(video|clip|film|animation|视频|剪辑)\w*/i },
  { category: "AI 音频", keywords: /\b(audio|voice|speech|music|podcast|transcri|语音|音乐|配音)\w*/i },
  { category: "AI 搜索与研究", keywords: /\b(search|research|answer engine|perplexity|citation|搜索|研究)\b/i },
  { category: "AI 客服", keywords: /\b(customer support|helpdesk|chatbot|客服|工单)\b/i },
  { category: "AI Agent / 自动化", keywords: /\b(agent|workflow|automation|automate|rpa|智能体|自动化)\b/i },
  { category: "AI 数据与分析", keywords: /\b(analytics|spreadsheet|data|bi\b|dashboard|数据|表格|分析)\b/i },
  { category: "AI 营销与增长", keywords: /\b(marketing|seo|ads|advertis|campaign|营销|推广|获客)\b/i },
  { category: "AI 效率与办公", keywords: /\b(productivity|note|meeting|pdf|slides|office|文档|会议|笔记|办公)\b/i },
  { category: "AI 模型与 API", keywords: /\b(llm|model|inference|api platform|fine-?tun|模型|推理)\b/i },
];

function heuristicCategory(haystack: string): string | null {
  let best: { category: string; hits: number } | null = null;
  for (const rule of CATEGORY_RULES) {
    const hits = (haystack.match(rule.keywords) ?? []).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { category: rule.category, hits };
  }
  return best?.category ?? null;
}

/** 核心功能：优先取 h1/h2，去掉纯导航词后前三条 */
function heuristicFeatures(headings: string[], text: string): string | null {
  const noise = /^(features?|pricing|blog|docs?|about|contact|login|sign ?(in|up)|get started|home|menu|产品|定价|登录)$/i;
  const useful = headings.map((h) => h.trim()).filter((h) => h.length >= 4 && h.length <= 80 && !noise.test(h));
  if (useful.length) return [...new Set(useful)].slice(0, 4).join("；");

  const sentences = text
    .split(/[。.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 120);
  return sentences.length ? sentences.slice(0, 2).join("；") : null;
}

/** 目标用户：找 "for marketers" / "适合…" 这类明确句式 */
function heuristicAudience(text: string): string | null {
  const patterns = [
    /\b(perfect|designed|built|made) for ([a-z0-9 ,&/-]{3,60})/i,
    /\bfor (developers|designers|marketers|students|teams|creators|researchers|startups|enterprises|agencies)\b/i,
    /适合([^\n。，]{2,40})/,
    /面向([^\n。，]{2,40})/,
  ];
  for (const re of patterns) {
    const m = re.exec(text.slice(0, 20_000));
    if (m) return truncate(m[0].replace(/\s+/g, " ").trim(), 80);
  }
  return null;
}

/* --------------------------------- LLM 分类 -------------------------------- */

interface DeepSeekResp {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/** 调 DeepSeek 抽三个字段（POST，失败返回 null 交给规则兜底） */
async function llmProfile(payload: {
  title: string;
  description: string;
  headings: string[];
  text: string;
}): Promise<{ category: string; features: string; targetAudience: string } | null> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;

  const body = {
    model: "deepseek-chat",
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: "你是 AI 工具目录的字段整理助手，只输出合法 JSON。",
      },
      {
        role: "user",
        content: [
          "根据官网信息输出 JSON：",
          '{"category":"一级分类（AI 写作/AI 编程/AI 图像/AI 视频/AI 音频/AI 搜索与研究/AI 客服/AI Agent/自动化/AI 数据与分析/AI 营销与增长/AI 效率与办公/其他）",',
          '"features":"核心功能，中文，3-6 个短语，用「；」分隔",',
          '"targetAudience":"目标用户，中文一句话，20 字以内"}',
          "",
          `网站名称：${payload.title || "未知"}`,
          `网站介绍：${payload.description || "无"}`,
          `页面小标题：${payload.headings.slice(0, 8).join(" | ") || "无"}`,
          `正文节选：${truncate(payload.text.replace(/\s+/g, " "), 3000)}`,
        ].join("\n"),
      },
    ],
  };

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DeepSeekResp;
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;
    const parsed = JSON.parse(content) as { category?: string; features?: string; targetAudience?: string };
    if (!parsed.category && !parsed.features && !parsed.targetAudience) return null;
    return {
      category: (parsed.category ?? "").trim(),
      features: (parsed.features ?? "").trim(),
      targetAudience: (parsed.targetAudience ?? "").trim(),
    };
  } catch {
    return null;
  }
}

export async function parseProfile(input: {
  title: string;
  description: string;
  headings: string[];
  text: string;
}): Promise<ProfileParsed> {
  const llm = await llmProfile(input);
  if (llm) {
    return {
      category: llm.category || null,
      features: llm.features || null,
      targetAudience: llm.targetAudience || null,
      source: "deepseek",
      note: "DEEPSEEK_API_KEY 可用，走模型抽取",
    };
  }

  const haystack = [input.title, input.description, ...input.headings, input.text.slice(0, 8000)].join("\n");
  return {
    category: heuristicCategory(haystack),
    features: heuristicFeatures(input.headings, input.text),
    targetAudience: heuristicAudience(input.text),
    source: "heuristic",
    note: process.env.DEEPSEEK_API_KEY
      ? "LLM 调用失败，退回关键词规则"
      : "未配置 DEEPSEEK_API_KEY，走关键词规则",
  };
}

/* ------------------------------- 关键词密度 ------------------------------- */

const STOPWORDS = new Set(
  (
    "the a an and or of to in for on with your you our we is are be it this that from at by as can will " +
    "all more most no not so than then there their they them its has have had do does did get got into out up " +
    "about what which who when where why how if but because while just also very much many any some such only"
  ).split(" "),
);

export interface KeywordDensity {
  totalWords: number;
  items: { term: string; count: number; density: number }[];
}

/**
 * 首页关键词密度与总词数（本地分词）。
 *
 * 口径：英文按单词切（去停用词，长度 ≥3），中文按 2-gram 切（中文没有空格，
 * 2-gram 是无需分词的通用近似），密度 = 词频 / 总词数。
 * 与 Similarweb AITDK 的结果不会完全一致（它用真实分词器），但用于「同一站点横向比较」够用，
 * 因此展示页会标明 actualSource = 本地解析。
 */
export function computeKeywordDensity(text: string, topN = 12): KeywordDensity {
  const latin = (text.toLowerCase().match(/[a-z][a-z0-9'+-]{2,}/g) ?? []).filter((w) => !STOPWORDS.has(w));

  const counts = new Map<string, number>();
  for (const w of latin) counts.set(w, (counts.get(w) ?? 0) + 1);

  const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  let cjkCount = 0;
  for (const run of cjkRuns) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const gram = run.slice(i, i + 2);
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
      cjkCount++;
    }
  }

  const totalWords = latin.length + cjkCount;
  if (!totalWords) return { totalWords: 0, items: [] };

  const items = [...counts.entries()]
    .filter(([term, n]) => n >= 2 && term.length >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term, count]) => ({
      term,
      count,
      density: Math.round((count / totalWords) * 10_000) / 100,
    }));

  return { totalWords, items };
}