import type { AITool } from "@horizons/shared";
import { getDomain } from "tldts";
import { isExcludedHost } from "../../admin/verdict";
import { config } from "../config";

/**
 * Hacker News（Show HN）采集源。
 *
 * 为什么接这个源：Product Hunt 的 `website` 字段全是 `producthunt.com/r/xxx`
 * 短链，而 producthunt.com 整站已被 Cloudflare 托管挑战覆盖（服务端 403、
 * 有头 Chrome 也停在挑战页），域名解析不出来就等于整条链路断掉。
 *
 * HN 走 Algolia 的公开 API，直接给真实外链，无需跳转、无需浏览器。
 * 代价是产品类型偏开发者工具，所以用关键词先做一轮 AI 相关性预筛，
 * 精确分类留给后台人工确认。
 */

const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date";

/** 只看最近 N 天，和 PH 那边的「新星」口径保持一致 */
const WINDOW_DAYS = 14;
/** Show HN 的票数普遍偏低（首页级 100+，普通 5–30），门槛放到 3 */
const MIN_POINTS = 3;
const PAGE_SIZE = 100;
/** 单次最多翻几页，防 API 返回异常时死循环 */
const MAX_PAGES = 5;

/**
 * AI 相关性预筛。刻意放宽：这里只是「值不值得进候选池」，
 * 真正的收录判定在 verdict.ts，误收一条的成本远低于漏掉一条。
 */
const AI_PATTERN = new RegExp(
  [
    "\\bai\\b",
    "\\ba\\.i\\.",
    "\\bllm",
    "\\bgpt",
    "chatgpt",
    "\\bclaude\\b",
    "\\bgemini\\b",
    "openai",
    "anthropic",
    "\\bllama\\b",
    "\\bmistral\\b",
    "deepseek",
    "\\bagents?\\b",
    "\\bagentic\\b",
    "\\bml\\b",
    "machine learning",
    "\\bneural\\b",
    "\\bmodels?\\b",
    "\\bembeddings?\\b",
    "\\brag\\b",
    "\\bvector\\b",
    "diffusion",
    "midjourney",
    "\\btransformer",
    "\\bprompts?\\b",
    "\\bcopilot\\b",
    "inference",
    "fine-?tun",
    "multimodal",
    "\\bgpu\\b",
    "\\bspeech\\b",
    "whisper",
    "\\btts\\b",
    "\\bocr\\b",
    "\\bnlp\\b",
    "chatbot",
    "\\bassistants?\\b",
    "\\bmcp\\b",
    "text-to-",
    "\\bdiffusion\\b",
  ].join("|"),
  "i",
);

interface HNHit {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  created_at: string;
  author: string | null;
}

interface HNResponse {
  hits?: HNHit[];
  nbHits?: number;
  page?: number;
  nbPages?: number;
}

/** 把 "Show HN: Obeya, a spatial canvas…" 拆成名字和一句话描述 */
function parseShowHnTitle(raw: string): { name: string; tagline: string } {
  const body = raw.replace(/^\s*show\s+hn\s*[:：]\s*/i, "").trim();
  // 长破折号优先，其次连字符、逗号、冒号
  const seps = [" – ", " — ", " - ", ", ", ": "];
  for (const sep of seps) {
    const i = body.indexOf(sep);
    if (i > 0) {
      const name = body.slice(0, i).trim();
      const tagline = body.slice(i + sep.length).trim();
      if (name.length > 0 && name.length <= 48) return { name, tagline };
    }
  }
  return { name: body.slice(0, 60).trim(), tagline: "" };
}

/** 名字不可信时的兜底：用域名的主体部分 */
function nameFromDomain(domain: string): string {
  const sld = domain.split(".")[0] ?? domain;
  return sld
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * 判断「解析出来的名字」是否真的像产品名。
 *
 * Show HN 的标题写法很杂差，常见三类不合格：
 *   - 「Show HN: I built X」→ 叙述句
 *   - 「Show HN: A company running in an AI harness」→ 冠词开头，是描述不是名字
 *   - 「Show HN: AI agents that barter your stuff for things you want」→ 整句
 * 命中任一条就退回用域名主体当名字（一定短且唯一）。
 */
function looksLikeNarrative(name: string): boolean {
  return (
    /^(a|an|the|i|we|my|our|just|finally|after|why|how|introducing|meet)\b/i.test(name) ||
    name.includes(".") ||
    name.length > 36
  );
}

function extractDomain(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    return getDomain(host) || host;
  } catch {
    return "";
  }
}

function heatFromPoints(points: number): number {
  return Math.min(100, Math.round(Math.log10(points + 1) * 25));
}

/** HN points 是社区票数，语义最接近 PH 的 upvotes，但没有对应字段，故单独保留 */
function toTags(title: string): string[] {
  const tags: string[] = [];
  const lower = title.toLowerCase();
  if (/\bagents?\b|agentic|mcp/.test(lower)) tags.push("AI Agent");
  if (/\bllm\b|gpt|claude|llama|model/.test(lower)) tags.push("LLM");
  if (/image|diffusion|midjourney|photo/.test(lower)) tags.push("AI 图像");
  if (/video/.test(lower)) tags.push("AI 视频");
  if (/voice|speech|tts|audio|whisper/.test(lower)) tags.push("AI 语音");
  if (/code|coding|developer|devtool|ide|git/.test(lower)) tags.push("AI 编程");
  if (/search|rag|vector/.test(lower)) tags.push("AI 搜索");
  return tags;
}

export interface HackerNewsFetchResult {
  items: AITool[];
  scanned: number;
  skipped: {
    noUrl: number;
    notAi: number;
    excluded: number;
    seen: number;
    duplicate: number;
  };
}

/**
 * 抓 Show HN 里的 AI 相关新产品。
 *
 * 与 PH 源保持同一套契约：`limit` 是产出数，凑够就停；
 * `seenDomains` 就地写入，调用方不用再筛一遍。
 */
export async function fetchHackerNewsTools(
  limit: number,
  existingNames: Set<string> = new Set(),
  seenDomains: Set<string> = new Set(),
  maxScan?: number,
): Promise<HackerNewsFetchResult> {
  const skipped = { noUrl: 0, notAi: 0, excluded: 0, seen: 0, duplicate: 0 };
  const items: AITool[] = [];
  const scanCap = maxScan ?? Math.max(limit * 10, 200);

  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86400;
  const filters = encodeURIComponent(`created_at_i>${since},points>=${MIN_POINTS}`);

  let scanned = 0;
  let pages = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (items.length >= limit || scanned >= scanCap) break;

    const url =
      `${HN_SEARCH_URL}?tags=show_hn&hitsPerPage=${PAGE_SIZE}&page=${page}` +
      `&numericFilters=${filters}`;

    let data: HNResponse;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": config.userAgent },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = (await res.json()) as HNResponse;
    } catch (e) {
      console.warn(
        `[fetch] HN 第 ${page + 1} 页请求失败：${e instanceof Error ? e.message : e}`,
      );
      break;
    }

    const hits = data.hits ?? [];
    if (hits.length === 0) break;

    pages++;
    scanned += hits.length;
    console.log(
      `[fetch] HN 第 ${pages} 页：${hits.length} 条（共 ${data.nbHits ?? "?"}），已产出 ${items.length}/${limit}`,
    );

    for (const hit of hits) {
      if (items.length >= limit) break;

      const title = (hit.title ?? "").trim();
      const rawUrl = (hit.url ?? "").trim();

      // Ask HN / 无外链的帖子拿不到官网
      if (!rawUrl) {
        skipped.noUrl++;
        continue;
      }
      if (!AI_PATTERN.test(title)) {
        skipped.notAi++;
        continue;
      }

      const domain = extractDomain(rawUrl);
      if (!domain) {
        skipped.noUrl++;
        continue;
      }
      // github.com / youtube.com 等平台主站走各自流水线，这里不算产品官网
      if (isExcludedHost(domain)) {
        skipped.excluded++;
        continue;
      }
      if (seenDomains.has(domain)) {
        skipped.seen++;
        continue;
      }

      const parsed = parseShowHnTitle(title);
      const name = looksLikeNarrative(parsed.name) ? nameFromDomain(domain) : parsed.name;
      if (!name || existingNames.has(name.toLowerCase())) {
        skipped.duplicate++;
        continue;
      }

      seenDomains.add(domain);
      existingNames.add(name.toLowerCase());

      const now = new Date().toISOString();
      const points = hit.points ?? 0;
      const tags = toTags(title);

      items.push({
        id: `tool-hn-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
        name: name.slice(0, 80),
        domain,
        url: `https://${domain}`,
        description: parsed.tagline || title,
        descriptionSource: "source",
        categories: ["Other"],
        topicSlugs: tags,
        industry: "人工智能",
        heatScore: heatFromPoints(points),
        phUpvotes: null,
        phComments: null,
        hnPoints: points,
        githubStars: null,
        launchedAt: hit.created_at,
        firstSeenAt: now,
        collectedAt: now,
        verified: "pending",
        sourceType: "hackernews",
        sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      });

      console.log(`[fetch] HN ${name} → ${domain}（${points} pts）`);
    }
  }

  console.log(
    `[fetch] HN 翻 ${pages} 页扫 ${scanned} 条，产出 ${items.length}/${limit}` +
      `｜无外链 ${skipped.noUrl}｜非 AI ${skipped.notAi}｜平台域名 ${skipped.excluded}` +
      `｜已在库 ${skipped.seen}｜重名 ${skipped.duplicate}`,
  );

  return { items, scanned, skipped };
}