// 评分与核验：证据等级优先于分数，传闻不进头条。
// 重要性 = 影响 40 + 新颖 25 + 相关性 20 + 证据 15；热度单独算，不叠加原始分数。

import { dailyConfig, digestQuota } from "./config";
import type { EvidenceLevel, Event, ModuleKey, RawItem } from "./types";

const RUMOR_HINTS = [
  "rumor", "rumour", "reportedly", "leaked", "allegedly", "said to be",
  "传闻", "据传", "据悉", "泄露", "外泄", "预告", "未证实", "网传",
];

const CN_ECOSYSTEM = [
  "deepseek", "qwen", "kimi", "glm", "智谱", "月之暗面", "通义", "文心",
  // 「千问」是通义千问的独立子品牌，官方稿常只写「千问」；漏了它，
  // 「千问办公 2.0」这类国产模型新闻会被判成「与 AI 主题无关」直接丢掉。
  "千问", "豆包", "混元", "即梦",
  "阿里", "字节", "腾讯", "百度", "商汤", "中文",
];

const BIG_ORGS = [
  "openai", "anthropic", "google", "deepmind", "meta", "microsoft", "nvidia",
  "apple", "amazon", "mistral", "hugging face", "cohere", "xai", "perplexity",
];

/**
 * 具体模型 / 产品名：区分「泛泛谈 AI」与「提到了能立刻用的东西」。
 *
 * 与 AI_CORE_EN 的分工不同：那一组只回答「是不是 AI」，因此必须收
 * llm / inference / multimodal 这类抽象词；这里回答「读者能不能马上试」，
 * 只收确定的实体名。一条只说「多模态推理很重要」的文章不该和
 * 「Gemini 3 开放 API」拿同样的相关性分。
 */
const ENTITY_HINTS = [
  "claude", "gemini", "gemma", "llama", "qwen", "deepseek", "kimi", "glm",
  "grok", "sora", "veo", "whisper", "flux", "midjourney", "copilot", "cursor",
  "chatgpt", "gpt-4", "gpt-5", "stable diffusion", "perplexity", "hugging face",
];

const BUSINESS_HINTS = [
  "funding", "raises", "raised", "raise", "valuation", "acquisition", "acquire", "acquired",
  "pricing", "price", "revenue", "ipo",
  "融资", "收购", "估值", "定价", "涨价", "降价", "营收",
];

const ACTION_HINTS = [
  "release", "released", "launch", "launched", "available", "open source",
  "open-source", "install", "docker", "docs", "beta", "开源", "上线", "发布", "试用",
];

/**
 * 把词表编译成「按词边界匹配」的正则，中文仍按子串。
 *
 * 原来的 `text.includes(word)` 有个隐蔽的错误：`valuation` 是 `evaluation`
 * 的子串，于是 arXiv 论文摘要里一句 "for evaluation" 就把条目判成了商业信号，
 * 论文因此占满「钱与机会」。英文必须卡词边界，否则只要有一个词是另一个词的
 * 前缀/后缀（price/priceless、raise/raised、ipo/ipod），判定就不可信。
 */
function buildWordRe(words: string[]): RegExp {
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const en = escaped.filter((w) => !/[\u4e00-\u9fa5]/.test(w));
  const cn = escaped.filter((w) => /[\u4e00-\u9fa5]/.test(w));
  const parts: string[] = [];
  if (en.length) parts.push(`(?:^|[^a-z0-9])(?:${en.join("|")})(?:[^a-z0-9]|$)`);
  parts.push(...cn);
  return new RegExp(parts.join("|"), "i");
}

const BUSINESS_RE = buildWordRe(BUSINESS_HINTS);
const ACTION_RE = buildWordRe(ACTION_HINTS);

/**
 * 强相关词表：这条到底是不是 AI 情报。
 *
 * 与 config 里 keywordGroups 的分工不同 —— 那一组是「发现候选」的宽关键词，
 * 命中只能说明可能有关；这里是准入闸门，只在标题与摘要里找明确信号。
 *
 * 刻意不收 model / training / token / agent 这类泛词：商业文章里的
 * 「business model」、招聘里的「training」都会误判成 AI。
 * 要放也只放带修饰的形态（language model / model weights / ai agent）。
 */
const AI_CORE_EN = [
  "openai", "anthropic", "claude", "gemini", "gemma", "llama", "qwen", "deepseek",
  "kimi", "glm", "zhipu", "mistral", "grok", "hugging face", "huggingface",
  "cohere", "perplexity", "midjourney", "sora", "veo", "whisper", "flux",
  "stable diffusion", "text-to-image", "text-to-video", "image generation",
  "llm", "language model", "foundation model", "model weights", "open-weight",
  "neural network", "transformer", "diffusion", "embedding", "fine-tuning",
  "finetune", "inference", "prompt engineering", "rag", "mcp", "ai agent",
  "agentic", "multimodal", "machine learning", "deep learning", "copilot",
  "chatbot", "gpt", "ai model", "artificial intelligence",
];

const AI_CORE_CN = [
  "模型", "大模型", "智能体", "人工智能", "微调", "提示词", "上下文",
  "开源模型", "推理加速", "训练数据", "多模态",
];

/** 英文词表预编译成一条正则：逐词 new RegExp 在几百条候选上太慢 */
const AI_CORE_RE = new RegExp(
  `(^|[^a-z0-9])(?:${AI_CORE_EN.map((w) =>
    w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})([^a-z0-9]|$)`,
  "i",
);

function textOf(item: RawItem): string {
  const description = typeof item.raw.description === "string" ? item.raw.description : "";
  const summary = typeof item.raw.summary === "string" ? item.raw.summary : "";
  return `${item.title} ${description} ${summary}`.toLowerCase();
}

function hit(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

/**
 * 相关性硬门槛：不相关的直接不进候选，连分数都不必算。
 *
 * 扩头条席位到 10 条之后，原来只靠分数排序的软相关性把房地产新闻、
 * 漏洞悬赏公告一起放进了头条 —— 分数够，但不是 AI 情报。
 *
 * 仓库不参与判断：采集时已按 llm / mcp / ai-coding 等 topic 取过，
 * 再要求标题命中反而会漏掉描述写得很朴素的真仓库。
 *
 * 官方博客（firstHand）也不给豁免：OpenAI 会发安全公告与招聘，
 * 那是一手材料但不是情报。有模型名的公告照样能命中词表，不会漏。
 */
export function isOnTopic(ev: Event): boolean {
  const primary = ev.items[0];
  if (primary.source === "github") return true;
  const text = ev.items.map(textOf).join(" ");
  return AI_CORE_RE.test(text) || hit(text, AI_CORE_CN);
}

/** 证据分级：一手材料优先；来源只有一个时明确写缺什么 */
export function gradeEvidence(ev: Event): { evidence: EvidenceLevel; missing?: string } {
  const primary = ev.items[0];
  const text = ev.items.map(textOf).join(" ");

  if (hit(text, RUMOR_HINTS)) {
    return { evidence: "rumor", missing: "未发布或未证实，只有转述与预告" };
  }
  if (ev.items.some((it) => it.firstHand)) {
    return { evidence: "verified" };
  }
  if (ev.sourceCount >= 2) {
    return {
      evidence: "pending",
      missing: "多个来源均为转述，暂缺一手材料（官方公告 / 原始仓库 / 可复现数据）",
    };
  }
  return {
    evidence: "pending",
    missing: `只有单一来源（${primary.source}），需等官方公告或第二家独立报道`,
  };
}

/** 分类权重：模型发布与商业信号对读者的行动价值更高 */
const CATEGORY_WEIGHT: Record<string, number> = {
  model_release: 12,
  business: 11,
  ai_agent: 9,
  product_launch: 9,
  open_source: 7,
  ai_coding: 6,
  other: 3,
};

export interface Scored {
  ev: Event;
  score: number;
  heat: number;
  evidence: EvidenceLevel;
  missing?: string;
  category: string;
  rank: number;
  /** 是否与 AI 主题相关；false 的条目根本不参与分配 */
  onTopic: boolean;
}

/** 源名 → 权威度。RSS 没有 points/stars 这类组内信号，只能靠源本身分层 */
const RSS_AUTHORITY = new Map<string, number>(
  dailyConfig.rss.map((s) => [s.name, s.authority ?? 1]),
);

function authorityOf(item: RawItem): number {
  const feed = typeof item.raw.feed === "string" ? item.raw.feed : null;
  return (feed && RSS_AUTHORITY.get(feed)) || 1;
}

export function scoreEvent(ev: Event, rank: number): Scored {
  const primary = ev.items[0];
  const text = ev.items.map(textOf).join(" ");
  const { evidence, missing } = gradeEvidence(ev);
  const category = primary.category ?? "other";

  // 影响：源内归一化后的强度（0–100）+ 分类权重，上限 40，再乘源权威度
  const baseImpact = Math.min(40, Math.round((rank / 100) * 28) + (CATEGORY_WEIGHT[category] ?? 3));
  // PR / 软广降权：花钱买的位置不代表今天的重要性
  const prFactor = primary.promotional ? 0.6 : 1;
  const impact = Math.round(baseImpact * authorityOf(primary) * prFactor);

  /**
   * 新颖（0–25）：按新鲜度严格递减，不再给 15 的底分。
   *
   * 原先是「底 15 + 12 小时内再 +6」，等于窗口内所有条目都白拿 18–21 分，
   * 30 小时的回看窗口里根本没有区分度 —— 这是 62 分门槛失效的头号原因。
   * 现在按 6 小时一档递减，超出窗口只象征性留 3 分。
   *
   * 时间缺失按 24 小时算：发布时间不明不该被当作「刚发布」。
   */
  const ageHours = primary.publishedAt
    ? (Date.now() - Date.parse(primary.publishedAt)) / 3600_000
    : 24;
  let novelty: number;
  if (ageHours <= 6) novelty = 25;
  else if (ageHours <= 12) novelty = 21;
  else if (ageHours <= 18) novelty = 17;
  else if (ageHours <= 24) novelty = 13;
  else if (ageHours <= 30) novelty = 8;
  else novelty = 3;
  const createdAt = typeof primary.raw.createdAt === "string" ? Date.parse(primary.raw.createdAt) : NaN;
  if (!Number.isNaN(createdAt) && Date.now() - createdAt < 30 * 86_400_000) novelty += 4;
  // 重复出现（前几期已发）不是扣分而是近乎作废：读者不想看第二遍
  if (primary.repeat) novelty = Math.round(novelty * 0.3);
  novelty = Math.max(0, Math.min(25, novelty));

  /**
   * 相关性（0–20）：只看标题，取消 10 的底分。
   *
   * 原先「底 10 + 大厂/中国生态各 5」意味着随便一条新闻就先有 10 分。更要紧的是
   * 判据取自全文：Simon Willison 的随笔「Yonkers Rises」摘要里顺带提了几个模型名，
   * 相关性就拿满 14 分 —— 但这条讲的并不是那些模型。读者在意的是
   * 「这条新闻说的是谁」，那是标题的事，不是正文里出现过谁。
   */
  const headlineText = primary.title.toLowerCase();
  let relevance = 0;
  if (hit(headlineText, BIG_ORGS)) relevance += 10;
  if (hit(headlineText, CN_ECOSYSTEM)) relevance += 6;
  if (hit(headlineText, ENTITY_HINTS)) relevance += 4;
  relevance = Math.min(20, relevance);

  const evidenceScore = evidence === "verified" ? 15 : evidence === "pending" ? 8 : 3;

  const score = Math.max(0, Math.min(100, impact + novelty + relevance + evidenceScore));
  return {
    ev,
    score,
    heat: Math.max(1, Math.min(5, Math.ceil(score / 20))),
    evidence,
    missing,
    category,
    rank,
    onTopic: isOnTopic(ev),
  };
}

export function isBusiness(s: Scored): boolean {
  return s.category === "business" || BUSINESS_RE.test(s.ev.items.map(textOf).join(" "));
}

export function isActionable(s: Scored): boolean {
  if (s.evidence !== "verified") return false;
  const primary = s.ev.items[0];
  const createdAt = typeof primary.raw.createdAt === "string" ? Date.parse(primary.raw.createdAt) : NaN;
  const fresh = !Number.isNaN(createdAt) && Date.now() - createdAt < 45 * 86_400_000;
  return fresh || ACTION_RE.test(textOf(primary));
}

/**
 * 头条排序：只在新闻类来源之间比较，已核验再加一点。
 * 仓库类直接不进头条池——Star 数能刷，它说明不了「今天最大的事」；
 * 只降权不够，实测仍会让个人仓库挤掉第 4 条头条。
 */
function headlinePriority(s: Scored): number {
  const evidenceBonus = s.evidence === "verified" ? 4 : 0;
  return s.score + evidenceBonus;
}

export interface Allocation {
  modules: Array<{ key: ModuleKey; items: Scored[] }>;
  /** 分数不足或重复出现而未采用 */
  dropped: number;
  /** 实际条数没到席位的模块，供发布前告警（不影响发布） */
  shortfall: Array<{ key: ModuleKey; want: number; got: number }>;
  /** 因与 AI 主题无关被挡在候选之外的条数 */
  offTopic: number;
}

/**
 * 模块分配：每个事件只进一个模块，不重复出现。
 *
 * 只发已核验（有一手材料）的：传闻与「只有转述、缺一手材料」的条目一律不发布。
 * 原先还留了一档 pending 并在页面上标「待核实」，读者看到的第一反应是
 * 「你自己都没核实，为什么发给我」—— 既然拿不出可核对的出处，就不该占版面。
 */
export function allocate(scored: Scored[]): Allocation {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const eligible = sorted.filter(
    (s) =>
      s.onTopic &&
      s.evidence === "verified" &&
      !s.ev.items[0].repeat &&
      s.score >= 45,
  );
  const offTopic = scored.length - scored.filter((s) => s.onTopic).length;

  const used = new Set<string>();
  const take = (pool: Scored[], n: number, pick: (s: Scored) => boolean = () => true): Scored[] => {
    const out: Scored[] = [];
    for (const s of pool) {
      if (out.length >= n) break;
      if (used.has(s.ev.id) || !pick(s)) continue;
      used.add(s.ev.id);
      out.push(s);
    }
    return out;
  };

  /**
   * 同一来源在头条里最多占的席位数。
   *
   * 官方博客的分数天然偏高（一手材料 + 大厂词），实测 AWS ML 博客一天能发
   * 七八条，其中既有「Nemotron 上线 SageMaker」这种真新闻，也有
   * 「How X 用 Bedrock 做 Y」这种客户案例。不设上限时，一家厂商的
   * 内容营销稿能占掉头条一半席位 —— 那不是「今天最大的事」。
   *
   * 上限只管头条：工具榜、行动榜本来就该被同源占满（一个仓库方发多条很正常）。
   */
  const MAX_PER_ORIGIN_HEADLINE = 2;

  function originOf(s: Scored): string {
    const feed = s.ev.items[0].raw.feed;
    return typeof feed === "string" ? feed : s.ev.items[0].source;
  }

  // 头条只从新闻类来源挑：仓库 Star 数容易刷，不该决定「今天最大的事」；
  // 仓库类内容全部进开源/产品模块，两条轨道不互相挤占。
  const headlinePool = eligible
    .filter((s) => s.ev.items[0].source !== "github")
    .sort((a, b) => headlinePriority(b) - headlinePriority(a));

  /**
   * 头条兜底只降分数，不再按分类放宽。
   *
   * 三轮门槛：62 → 55 → 45（仅当不足 3 条）。原先第二轮就放到 45，
   * 结果是「llm-anthropic 0.31」这种库版本公告靠兜底占掉席位 ——
   * 重标定后 45 分只代表「勉强相关」，不足以当今日头条。
   *
   * 席位凑不满只告警、不填数：宁可 6 条，也不拿 45 分的公告占位。
   * github 全程不进头条：Star 数能刷，不该决定「今天最大的事」。
   */
  /**
   * 标题可识别的「软性内容」：案例、教程、观点、清单。
   *
   * 这类稿子几乎都来自官方博客，所以 evidence 是 verified、分数天然达标，
   * 却不是「今天发生了什么」。原先用 `category !== "other"` 挡，但那个判据
   * 两头都不准：AWS 的「How CrossnoKaye ...」被判成 model_release 混进来，
   * 而「Claude Fable 5.2」这种没有 model 字样的真新闻反被判成 other 挡在门外。
   *
   * 换成看标题句式：「How/Why/Guide/Opinion」开头的是论述，不是事件。
   */
  const SOFT_TITLE_RE =
    /^(how|why|what|when|where|who|understanding|a guide|guide to|best practices|the case for|opinion|recipe|tutorial|lessons?)\b/i;

  /** 纯「包名 + 版本号」标题：库更新公告，读者不需要从头条知道 */
  const VERSION_ONLY_RE = /^[a-z0-9][a-z0-9._-]*\s+v?\d+(\.\d+)+$/i;

  function isSoft(s: Scored): boolean {
    const title = s.ev.items[0].title.trim();
    return SOFT_TITLE_RE.test(title) || VERSION_ONLY_RE.test(title);
  }

  /**
   * 头条必须点名「谁的事」。
   *
   * onTopic 放得很松（全文命中任一 AI 词即可），那是准入闸门该有的宽容；
   * 但头条要回答「今天最需要知道什么」，标题里连公司名、模型名都没有的稿子
   * —— 教育政策评论、七层框架白皮书 —— 读者无从判断与自己是否相关。
   */
  function hasEntity(s: Scored): boolean {
    const title = s.ev.items[0].title.toLowerCase();
    return hit(title, BIG_ORGS) || hit(title, CN_ECOSYSTEM) || hit(title, ENTITY_HINTS);
  }

  const headlineOrigin = new Map<string, number>();
  const takeHeadline = (n: number, pick: (s: Scored) => boolean): Scored[] => {
    const out: Scored[] = [];
    for (const s of headlinePool) {
      if (out.length >= n) break;
      if (used.has(s.ev.id) || !pick(s)) continue;
      const origin = originOf(s);
      const count = headlineOrigin.get(origin) ?? 0;
      if (count >= MAX_PER_ORIGIN_HEADLINE) continue;
      headlineOrigin.set(origin, count + 1);
      used.add(s.ev.id);
      out.push(s);
    }
    return out;
  };

  const q = digestQuota;
  const headline = takeHeadline(q.headline, (s) => s.score >= 62 && !isSoft(s) && hasEntity(s));
  if (headline.length < q.headline) {
    headline.push(
      ...takeHeadline(q.headline - headline.length, (s) => s.score >= 55 && !isSoft(s) && hasEntity(s)),
    );
  }
  if (headline.length < 3) {
    // 极端日子才放宽同源上限：宁愿少一条，也不让一家厂商占满头条
    for (const s of headlinePool) {
      if (headline.length >= 3) break;
      if (used.has(s.ev.id) || s.score < 45) continue;
      used.add(s.ev.id);
      headline.push(s);
    }
  }
  const rest = eligible;

  // 顺序即优先级：先认钱，再认能直接用的东西，最后才是可执行动作。
  // 否则「能直接用的」会被 Star 高的仓库占满，商业信号一条都进不来。
  const money = take(rest, q.money, isBusiness);
  const tools = take(rest, q.tools, (s) =>
    s.ev.items[0].source === "github" ||
    s.category === "open_source" ||
    s.category === "ai_agent" ||
    s.category === "ai_coding",
  );
  const action = take(rest, q.action, (s) => isActionable(s) && !isBusiness(s));

  const modules: Array<{ key: ModuleKey; items: Scored[] }> = [
    { key: "headline", items: headline },
    { key: "tools", items: tools },
    { key: "money", items: money },
    { key: "action", items: action },
  ];

  const shortfall = modules
    .filter((m) => m.items.length < q[m.key])
    .map((m) => ({ key: m.key, want: q[m.key], got: m.items.length }));

  return {
    modules: modules.filter((m) => m.items.length > 0),
    dropped: scored.length - used.size,
    shortfall,
    offTopic,
  };
}