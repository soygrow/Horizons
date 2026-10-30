import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import type { AITrend, TrendSourceRef } from "@horizons/shared";
import { fetchTrendingRss } from "./sources/google-trends";
import { sleep } from "./http";

/** 候选词来源：RSS 发现 / 现有工具库 / 手工种子 / GitHub 新仓库 / Product Hunt */
export type CandidateOrigin = "rss" | "aitools" | "seed" | "github" | "ph";

export interface TrendCandidate {
  keyword: string;
  normalizedKey: string;
  origin: CandidateOrigin;
  sources: TrendSourceRef[];
  /** 发现时的热度信号，仅用于排序，不展示 */
  weight: number;
}

/** AI 相关性正则：只放行与 AI 技术/产品/玩法有关的词 */
const AI_PATTERN =
  /(\bai\b|a\.i\.|artificial intelligence|machine learning|deep learning|\bllm\b|gpt|chatgpt|claude|gemini|copilot|midjourney|stable diffusion|sora|veo|runway|agent|agentic|\bmcp\b|prompt|rag\b|embedding|fine-?tun|transformer|diffusion|text-to-|speech-to-|voice clone|openai|anthropic|deepseek|qwen|llama|mistral|nvidia|hugging ?face|vibe cod|no-?code|automation|向量|大模型|智能体|生成式|文生)/i;

/** 明显的新闻噪声词：人物、赛事、天气、股价符号 */
const NOISE_PATTERN =
  /^(who|what|why|how|when|where)\b|\b(score|vs\.?|weather|stock|price today|election|match|game|lottery|result)\b/i;

export function isAiRelevant(keyword: string): boolean {
  return AI_PATTERN.test(keyword);
}

export function isUsableKeyword(keyword: string): boolean {
  const k = keyword.trim();
  if (k.length < 3 || k.length > 48) return false;
  if (k.split(/\s+/).length > 5) return false;
  if (/^[\d\s.,%-]+$/.test(k)) return false;
  if (NOISE_PATTERN.test(k)) return false;
  return true;
}

/** 候选词准入：可用 + 与 AI 相关（趋势验证仍会再筛一次） */
export function matchKeyword(keyword: string): boolean {
  return isUsableKeyword(keyword) && isAiRelevant(keyword);
}

export function normalizeKey(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/\s+/g, " ");
}

export function slugify(keyword: string): string {
  const base = keyword
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `trend-${Date.now().toString(36)}`;
}

/* ------------------------------ 发现来源 ------------------------------ */

export async function discoverFromTrendingRss(geos: string[]): Promise<TrendCandidate[]> {
  const out: TrendCandidate[] = [];
  for (const geo of geos) {
    try {
      const items = await fetchTrendingRss(geo);
      for (const item of items) {
        if (!isUsableKeyword(item.keyword)) continue;
        out.push({
          keyword: item.keyword,
          normalizedKey: normalizeKey(item.keyword),
          origin: "rss",
          weight: item.approxTraffic ?? 0,
          sources: [
            {
              label: `Google Trends · Trending now（${geo}）`,
              url: `https://trends.google.com/trending?geo=${geo}&hours=24`,
              site: "trends.google.com",
              kind: "google_trends",
              ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
            },
            ...item.newsUrls.map<TrendSourceRef>((url) => ({
              label: "Google Trends 关联新闻",
              url,
              site: safeHost(url),
              kind: "news",
            })),
          ],
        });
      }
      console.log(`[rss] ${geo}：${items.length} 条`);
    } catch (e) {
      console.warn(`[rss] ${geo} 失败：${e instanceof Error ? e.message : e}`);
    }
    await sleep(800);
  }
  return out;
}

/** 月搜索量门槛：低于这个数的词只有品牌流量，进榜说明不了任何需求 */
const MIN_SEARCH_VOLUME = 1000;

/**
 * AI 工具库作为词池，但取「搜索词」而不是「产品名」。
 *
 * 之前用 tool.name 当候选，收进来的全是 ayven / ferndesk 这类小众品牌：
 * 搜的人只有品牌自己，没有需求信号，对读者零价值。
 * 库里的 keywords 字段是真实搜索词 + 月搜索量，这才是需求：
 * 「ai music generator」11 万次搜索 = 有大量人在找东西，「picova ai」140 次 = 没人搜。
 */
export function discoverFromAitools(): TrendCandidate[] {
  const file = path.resolve(process.cwd(), "content/aitools.json");
  let tools: AITool[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as AITool[] | { tools?: AITool[] };
    tools = Array.isArray(raw) ? raw : (raw.tools ?? []);
  } catch {
    console.warn("[aitools] 读取失败，跳过");
    return [];
  }

  const out: TrendCandidate[] = [];
  const merged = new Map<string, TrendCandidate>();

  for (const tool of tools) {
    for (const item of tool.keywords ?? []) {
      const keyword = item.term?.trim();
      if (!keyword) continue;
      // 只有真的带了搜索量才用它做门槛：这个库里 1031 个词只有 6 个有 volume，
      // 把「缺失」当 0 会把整库滤空
      if (item.volume !== undefined && item.volume < MIN_SEARCH_VOLUME) continue;
      if (!isUsableKeyword(keyword) || !isAiRelevant(keyword)) continue;

      const key = normalizeKey(keyword);
      const source = {
        label: `搜索量 ${Math.round((item.volume ?? 0) / 1000)}k/月`,
        url: tool.url || `https://${tool.domain}`,
        site: "google-keyword",
        kind: "serp" as const,
      };

      const exist = merged.get(key);
      if (exist) {
        // 同一个搜索词被多个工具共用：需求更真实，权重叠加
        exist.weight += item.volume ?? 0;
        if (!exist.sources.some((s) => s.site === source.site && s.label === source.label)) {
          exist.sources.push(source);
        }
        continue;
      }

      const candidate: TrendCandidate = {
        keyword,
        normalizedKey: key,
        origin: "aitools",
        weight: item.volume ?? 0,
        sources: [source],
      };
      merged.set(key, candidate);
      out.push(candidate);
    }
  }

  console.log(`[aitools] 候选 ${out.length} 个（来自带搜索量的真实关键词）`);
  return out;
}

/** 手工种子：content/trends-seeds.txt，一行一个词，# 开头为注释 */
export function discoverFromSeeds(): TrendCandidate[] {
  const file = path.resolve(process.cwd(), "content/trends-seeds.txt");
  let text = "";
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const out: TrendCandidate[] = [];
  for (const line of text.split("\n")) {
    const keyword = line.replace(/#.*$/, "").trim();
    if (!keyword || !isUsableKeyword(keyword)) continue;
    out.push({
      keyword,
      normalizedKey: normalizeKey(keyword),
      origin: "seed",
      weight: 0,
      sources: [
        {
          label: "手工种子词",
          url: "https://trends.google.com/trends/explore",
          site: "trends.google.com",
          kind: "google_trends",
        },
      ],
    });
  }
  if (out.length > 0) console.log(`[seed] 候选 ${out.length} 个`);
  return out;
}

interface GithubRepoHit {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
  homepage?: string | null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "Horizons-trends-collector/0.1",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

/** 最近新建的高星 AI 仓库：新项目名≈新搜索词 */
export async function discoverFromGithub(days: number, minStars: number): Promise<TrendCandidate[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const url =
    "https://api.github.com/search/repositories?q=" +
    encodeURIComponent(`topic:ai created:>${since} stars:>${minStars}`) +
    "&sort=stars&order=desc&per_page=50";
  try {
    const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GitHub search ${res.status}`);
    const data = (await res.json()) as { items?: GithubRepoHit[] };
    const out: TrendCandidate[] = [];
    for (const repo of data.items ?? []) {
      const name = repo.full_name.split("/")[1];
      if (!isUsableKeyword(name)) continue;
      // 仓库名本身常常是随机词（tessera / kubic），必须靠描述说明它和 AI 有关
      if (!isAiRelevant(`${name} ${repo.description ?? ""}`)) continue;
      out.push({
        keyword: name.replace(/[-_]/g, " "),
        normalizedKey: normalizeKey(name.replace(/[-_]/g, " ")),
        origin: "github",
        weight: repo.stargazers_count,
        sources: [
          {
            label: `GitHub 仓库 ${repo.full_name}（★${repo.stargazers_count}）`,
            url: repo.html_url,
            site: "github.com",
            kind: "repo",
            publishedAt: repo.created_at.slice(0, 10),
          },
        ],
      });
    }
    console.log(`[github] 候选 ${out.length} 个`);
    return out;
  } catch (e) {
    console.warn(`[github] 失败：${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/** Product Hunt：复用现有抓取器（需要 PH_TOKEN / Playwright），失败则跳过 */
export async function discoverFromProductHunt(): Promise<TrendCandidate[]> {
  try {
    const { fetchProductHuntTools, closePHBrowser } = await import("../sources/productHunt");
    try {
      const tools = await fetchProductHuntTools(30, "VOTES", "artificial-intelligence", new Set());
      const out: TrendCandidate[] = [];
      for (const tool of tools) {
        if (!isUsableKeyword(tool.name)) continue;
        out.push({
          keyword: tool.name,
          normalizedKey: normalizeKey(tool.name),
          origin: "ph",
          weight: 0,
          sources: [
            {
              label: `Product Hunt：${tool.name}`,
              url: tool.url || `https://${tool.domain}`,
              site: "producthunt.com",
              kind: "official",
            },
          ],
        });
      }
      console.log(`[ph] 候选 ${out.length} 个`);
      return out;
    } finally {
      await closePHBrowser();
    }
  } catch (e) {
    console.warn(`[ph] 跳过：${e instanceof Error ? e.message : e}`);
    return [];
  }
}

/* ------------------------------ 证据补齐 ------------------------------ */

export interface EvidenceHit {
  title: string;
  url: string;
  detail?: string;
  publishedAt?: string;
}

export interface KeywordEvidence {
  hn: EvidenceHit[];
  repos: EvidenceHit[];
}

/** HN（Algolia 免费）与 GitHub 搜索：为「为什么升温」提供真实可点来源 */
export async function collectEvidence(keyword: string): Promise<KeywordEvidence> {
  const hn: EvidenceHit[] = [];
  const repos: EvidenceHit[] = [];

  try {
    const url =
      "https://hn.algolia.com/api/v1/search?query=" +
      encodeURIComponent(keyword) +
      "&tags=story&hitsPerPage=4";
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as {
        hits?: Array<{
          title?: string | null;
          url?: string | null;
          objectID: string;
          points?: number;
          created_at?: string;
        }>;
      };
      for (const hit of data.hits ?? []) {
        if (!hit.title) continue;
        hn.push({
          title: hit.title,
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          detail: `${hit.points ?? 0} points`,
          publishedAt: hit.created_at?.slice(0, 10),
        });
      }
    }
  } catch {
    // 证据可缺省
  }

  await sleep(400);

  try {
    const url =
      "https://api.github.com/search/repositories?q=" +
      encodeURIComponent(`${keyword} in:name,description`) +
      "&sort=stars&order=desc&per_page=3";
    const res = await fetch(url, { headers: githubHeaders(), signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as { items?: GithubRepoHit[] };
      for (const repo of data.items ?? []) {
        repos.push({
          title: `${repo.full_name}（★${repo.stargazers_count}）`,
          url: repo.html_url,
          detail: repo.description?.slice(0, 120) ?? undefined,
          publishedAt: repo.created_at.slice(0, 10),
        });
      }
    }
  } catch {
    // 证据可缺省
  }

  return { hn, repos };
}

/** 详情页的「相近趋势」与候选去重都依赖这个键 */
export function trendKey(t: Pick<AITrend, "keyword">): string {
  return normalizeKey(t.keyword);
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}