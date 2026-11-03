// 评分与核验：证据等级优先于分数，传闻不进头条。
// 重要性 = 影响 40 + 新颖 25 + 相关性 20 + 证据 15；热度单独算，不叠加原始分数。

import type { EvidenceLevel, Event, ModuleKey, RawItem } from "./types";

const RUMOR_HINTS = [
  "rumor", "rumour", "reportedly", "leaked", "allegedly", "said to be",
  "传闻", "据传", "据悉", "泄露", "外泄", "预告", "未证实", "网传",
];

const CN_ECOSYSTEM = [
  "deepseek", "qwen", "kimi", "glm", "智谱", "月之暗面", "通义", "文心",
  "阿里", "字节", "腾讯", "百度", "商汤", "中文",
];

const BIG_ORGS = [
  "openai", "anthropic", "google", "deepmind", "meta", "microsoft", "nvidia",
  "apple", "amazon", "mistral", "hugging face", "cohere", "xai", "perplexity",
];

const BUSINESS_HINTS = [
  "funding", "raises", "raised", "valuation", "acquisition", "acquire", "pricing",
  "price", "revenue", "ipo", "融资", "收购", "估值", "定价", "涨价", "降价", "营收",
];

const ACTION_HINTS = [
  "release", "released", "launch", "launched", "available", "open source",
  "open-source", "install", "docker", "docs", "beta", "开源", "上线", "发布", "试用",
];

function textOf(item: RawItem): string {
  const description = typeof item.raw.description === "string" ? item.raw.description : "";
  const summary = typeof item.raw.summary === "string" ? item.raw.summary : "";
  return `${item.title} ${description} ${summary}`.toLowerCase();
}

function hit(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
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
}

export function scoreEvent(ev: Event, rank: number): Scored {
  const primary = ev.items[0];
  const text = ev.items.map(textOf).join(" ");
  const { evidence, missing } = gradeEvidence(ev);
  const category = primary.category ?? "other";

  // 影响：源内归一化后的强度（0–100）+ 分类权重，上限 40
  const impact = Math.min(40, Math.round((rank / 100) * 28) + (CATEGORY_WEIGHT[category] ?? 3));

  // 新颖：越新越高；重复出现过的扣分；新仓库加成
  const ageHours = primary.publishedAt
    ? (Date.now() - Date.parse(primary.publishedAt)) / 3600_000
    : 24;
  let novelty = 15;
  if (ageHours <= 12) novelty += 6;
  else if (ageHours <= 24) novelty += 3;
  const createdAt = typeof primary.raw.createdAt === "string" ? Date.parse(primary.raw.createdAt) : NaN;
  if (!Number.isNaN(createdAt) && Date.now() - createdAt < 30 * 86_400_000) novelty += 4;
  if (primary.repeat) novelty -= 10;
  novelty = Math.max(0, Math.min(25, novelty));

  // 相关性：大厂与中国生态各加分——读者更关心能否马上用上
  let relevance = 10;
  if (hit(text, BIG_ORGS)) relevance += 5;
  if (hit(text, CN_ECOSYSTEM)) relevance += 5;
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
  };
}

export function isBusiness(s: Scored): boolean {
  return s.category === "business" || hit(s.ev.items.map(textOf).join(" "), BUSINESS_HINTS);
}

export function isActionable(s: Scored): boolean {
  if (s.evidence !== "verified") return false;
  const primary = s.ev.items[0];
  const createdAt = typeof primary.raw.createdAt === "string" ? Date.parse(primary.raw.createdAt) : NaN;
  const fresh = !Number.isNaN(createdAt) && Date.now() - createdAt < 45 * 86_400_000;
  return fresh || hit(textOf(primary), ACTION_HINTS);
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
}

/**
 * 模块分配：每个事件只进一个模块，不重复出现。
 * 传闻、单一转述一律不发布——这里卖的是能用的确定信息，不是「大概」。
 */
export function allocate(scored: Scored[]): Allocation {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const eligible = sorted.filter(
    (s) => s.evidence !== "rumor" && !s.ev.items[0].repeat && s.score >= 45,
  );

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

  // 头条只从新闻类来源挑：仓库 Star 数容易刷，不该决定「今天最大的事」；
  // 仓库类内容全部进开源/产品模块，两条轨道不互相挤占。
  const headlinePool = eligible
    .filter((s) => s.ev.items[0].source !== "github")
    .sort((a, b) => headlinePriority(b) - headlinePriority(a));
  // 第一轮排除 other（客户案例、行业随笔一类），凑不满 3 条才允许 other 兜底
  const headline = take(headlinePool, 4, (s) => s.score >= 62 && s.category !== "other");
  if (headline.length < 3) {
    const extra = take(headlinePool, 3 - headline.length, (s) => s.score >= 62);
    headline.push(...extra);
  }
  const rest = eligible;

  // 顺序即优先级：先认钱，再认能直接用的东西，最后才是可执行动作。
  // 否则「能直接用的」会被 Star 高的仓库占满，商业信号一条都进不来。
  const money = take(rest, 3, isBusiness);
  const tools = take(rest, 5, (s) =>
    s.ev.items[0].source === "github" ||
    s.category === "open_source" ||
    s.category === "ai_agent" ||
    s.category === "ai_coding",
  );
  const action = take(rest, 2, (s) => isActionable(s) && !isBusiness(s));

  const modules: Array<{ key: ModuleKey; items: Scored[] }> = [
    { key: "headline", items: headline },
    { key: "tools", items: tools },
    { key: "money", items: money },
    { key: "action", items: action },
  ];

  return {
    modules: modules.filter((m) => m.items.length > 0),
    dropped: scored.length - used.size,
  };
}