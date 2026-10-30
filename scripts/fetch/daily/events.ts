// 事件合并：把「多条信息」收敛成「一个事件」。
// 原则：宁可漏合并，不可错合并。靠标题相似度合并的标 mergedByTitle，留给人工复核。

import { canonicalUrl, sourceSignalScore } from "./normalize";
import type { Event, RawItem } from "./types";

/** 英文停用词：不参与相似度计算，否则 "the / a / new" 会把不相关标题拉到一起 */
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "were",
  "has", "have", "had", "not", "you", "your", "its", "it's", "can", "will", "now",
  "new", "how", "what", "why", "who", "when", "out", "over", "after", "before",
  "about", "than", "then", "them", "they", "there", "here", "but", "all", "any",
  "our", "their", "his", "her", "one", "two", "just", "more", "most", "some",
]);

/** 标题 → 词集合；中文用二元组，避免整句无法匹配 */
export function titleTokens(title: string): Set<string> {
  const lowered = title.toLowerCase();
  const tokens = new Set<string>();

  for (const word of lowered.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ").split(" ")) {
    if (word.length > 2 && !STOP.has(word)) tokens.add(word);
    else if (word.length === 2) tokens.add(word);
  }

  const cjk = lowered.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  for (const run of cjk) {
    for (let i = 0; i < run.length - 1; i++) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 合并判定不能用纯词集 Jaccard：实测「同事件不同写法」得分 0.38、
 * 「不同事件」得分 0.40–0.44，指标完全无法区分。标题改写度高，
 * 词面重叠本来就低，必须靠实体、版本号、动作词三项做闸门。
 */
const ACTIONS: Record<string, string> = {
  release: "release", releases: "release", released: "release", releasing: "release",
  launch: "release", launches: "release", launched: "release", ships: "release", shipped: "release",
  open: "release", opens: "release", "open-sourced": "release",
  price: "price", prices: "price", pricing: "price", cheaper: "price", expensive: "price",
  raise: "funding", raises: "funding", raised: "funding", funding: "funding",
  valuation: "funding", invests: "funding", investment: "funding",
  acquire: "acquire", acquires: "acquire", acquisition: "acquire", buys: "acquire",
  leak: "leak", leaks: "leak", leaked: "leak",
  outage: "incident", down: "incident", breach: "incident",
  benchmark: "bench", benchmarks: "bench", tops: "bench",
};

const KEY_ORGS = [
  "openai", "anthropic", "google", "deepmind", "meta", "microsoft", "nvidia", "apple",
  "amazon", "mistral", "deepseek", "qwen", "alibaba", "bytedance", "xai", "cohere",
  "perplexity", "hugging", "github", "copilot", "claude", "gemini", "gpt", "llama",
  "kimi", "glm", "grok", "sora", "midjourney", "stability", "langchain",
];

function actionsOf(title: string): Set<string> {
  const out = new Set<string>();
  for (const word of title.toLowerCase().split(/[^a-z-]+/)) {
    const canon = ACTIONS[word];
    if (canon) out.add(canon);
  }
  return out;
}

/** 专有名词 + 已知机构名，作为「说的是不是同一个东西」的硬约束 */
function entitiesOf(title: string): Set<string> {
  const out = new Set<string>();
  const words = title.split(/\s+/);
  words.forEach((word, i) => {
    const cleaned = word.replace(/[^A-Za-z0-9.+-]/g, "");
    // 句首单词不算专有名词，否则 "Show HN:" 会让所有 Show HN 互相匹配
    if (i > 0 && /^[A-Z][A-Za-z0-9.+-]{1,}$/.test(cleaned) && !STOP.has(cleaned.toLowerCase())) {
      out.add(cleaned.toLowerCase());
    }
  });
  const lower = title.toLowerCase();
  for (const org of KEY_ORGS) {
    if (new RegExp(`\\b${org}\\b`).test(lower)) out.add(org);
  }
  return out;
}

/** 机构/产品名：只要两边都点名了不同机构，就直接判定不是同一事件 */
function orgsOf(title: string): Set<string> {
  const lower = title.toLowerCase();
  const out = new Set<string>();
  for (const org of KEY_ORGS) {
    if (new RegExp(`\\b${org}\\b`).test(lower)) out.add(org);
  }
  return out;
}

function numbersOf(title: string): Set<string> {
  return new Set(title.match(/\d+(?:\.\d+)?/g) ?? []);
}

function overlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / Math.min(a.size, b.size);
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

export function sameEvent(titleA: string, titleB: string): boolean {
  const wordsA = titleTokens(titleA);
  const wordsB = titleTokens(titleB);

  const actionsA = actionsOf(titleA);
  const actionsB = actionsOf(titleB);
  // 发布会 vs 定价 / 融资 vs 收购，是不同事件，不能并
  if (actionsA.size > 0 && actionsB.size > 0 && !intersects(actionsA, actionsB)) return false;

  // 「DeepSeek 发布 X」和「Qwen 发布 X」共享版本号但主体不同，必须先拦掉
  const orgsA = orgsOf(titleA);
  const orgsB = orgsOf(titleB);
  if (orgsA.size > 0 && orgsB.size > 0 && !intersects(orgsA, orgsB)) return false;

  const entitiesA = entitiesOf(titleA);
  const entitiesB = entitiesOf(titleB);
  if (entitiesA.size > 0 && entitiesB.size > 0 && !intersects(entitiesA, entitiesB)) return false;

  const numbersA = numbersOf(titleA);
  const numbersB = numbersOf(titleB);
  // GPT-5 与 GPT-6、1.0 与 2.0 是两件事
  if (numbersA.size > 0 && numbersB.size > 0 && !intersects(numbersA, numbersB)) return false;

  const ratio = overlapRatio(wordsA, wordsB);
  const hasEntityAnchor = intersects(entitiesA, entitiesB);
  return hasEntityAnchor ? ratio >= 0.6 : ratio >= 0.85;
}

export function mergeEvents(rawItems: RawItem[], date: string): Event[] {
  // 信号强的先入桶，作为「主条目」
  const sorted = [...rawItems].sort((a, b) => sourceSignalScore(b) - sourceSignalScore(a));
  const buckets: Bucket[] = [];

  for (const item of sorted) {
    let target: Bucket | undefined;

    for (const bucket of buckets) {
      const head = bucket.items[0];
      // 1) 同一链接：确定的同一条内容
      if (canonicalUrl(head.url) === canonicalUrl(item.url)) {
        target = bucket;
        break;
      }
      // 2) 仓库之间只认仓库名，不参与标题相似度
      if (item.source === "github" || head.source === "github") continue;
      // 3) 实体 + 版本 + 动作三重校验通过，才算同一事件；仍标记为边界样本
      if (sameEvent(head.title, item.title)) {
        target = bucket;
        target.mergedByTitle = true;
        break;
      }
    }

    if (target) target.items.push(item);
    else buckets.push({ items: [item], mergedByTitle: false });
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  return buckets.map((bucket, i) => ({
    id: `evt_${date.replace(/-/g, "")}_${pad(i + 1)}`,
    items: bucket.items,
    sourceCount: new Set(bucket.items.map((it) => it.source)).size,
    mergedByTitle: bucket.mergedByTitle,
  }));
}