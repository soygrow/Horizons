import type { AITool } from "@horizons/shared";
import { getDomain } from "tldts";
import { isExcludedHost } from "../../admin/verdict";
import { config } from "../config";

/**
 * Futurepedia 采集源。
 *
 * 这个站是 SSR 的，服务端直出 HTML，卡片里同时带：
 *   - 工具名（`<h3>`）
 *   - PH 风格的 "Visit" 外链（指向官网，带 utm 参数）
 *   - 评分 / Pick 徽章
 *
 * 已知限制（实测 2026-11）：`/discover` 不支持服务端分页，
 * `?page=2` 返回的仍是同一批 15 个热门工具；`/whats-new` 是客户端渲染，
 * 首屏 HTML 里没有卡片。因此本源的**增量产出很低**，定位是
 * 「补几个头部工具」而不是主力发现源。
 */

const DISCOVER_URL = "https://www.futurepedia.io/discover";

const HTML_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

interface Card {
  name: string;
  visitUrl: string;
  slug: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** 去掉 utm 之类的来源标记，只留干净域名 */
function cleanVisitUrl(raw: string): string {
  try {
    const u = new URL(decodeEntities(raw));
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k) || /^(ref|source|affiliate)$/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\?$/, "");
  } catch {
    return "";
  }
}

/**
 * 按卡片容器切分再逐块提取。
 *
 * 之所以不整页正则一把梭：同一页里 `/tool/<slug>` 会出现 3 次（logo 链、
 * 标题链、图片链），整页匹配会把不同卡片的字段错配到一起。
 */
function parseCards(html: string): Card[] {
  const blocks = html.split(/<div class="cv-auto card-shine/).slice(1);
  const cards: Card[] = [];

  for (const block of blocks) {
    const slugMatch = /href="\/tool\/([a-z0-9-]+)"/.exec(block);
    const nameMatch = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(block);
    if (!slugMatch || !nameMatch) continue;

    const name = stripTags(nameMatch[1]);
    if (!name) continue;

    // "Visit" 按钮在整个卡片末尾，它是唯一指向外部站点的 a
    const visitIdx = block.indexOf(">Visit<");
    let visitUrl = "";
    if (visitIdx > 0) {
      const seg = block.slice(0, visitIdx);
      const anchors = [...seg.matchAll(/<a[^>]*href="([^"]+)"/g)];
      const last = anchors.at(-1)?.[1] ?? "";
      if (/^https?:\/\//i.test(last)) visitUrl = cleanVisitUrl(last);
    }

    cards.push({ name, visitUrl, slug: slugMatch[1] });
  }

  return cards;
}

export interface FuturepediaFetchResult {
  items: AITool[];
  scanned: number;
  skipped: { noLink: number; excluded: number; seen: number };
}

export async function fetchFuturepediaTools(
  limit: number,
  existingNames: Set<string> = new Set(),
  seenDomains: Set<string> = new Set(),
): Promise<FuturepediaFetchResult> {
  const skipped = { noLink: 0, excluded: 0, seen: 0 };
  const items: AITool[] = [];

  let html: string;
  try {
    const res = await fetch(DISCOVER_URL, { headers: HTML_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn(
      `[fetch] Futurepedia 请求失败：${e instanceof Error ? e.message : e}，跳过本能源`,
    );
    return { items, scanned: 0, skipped };
  }

  const cards = parseCards(html);
  console.log(`[fetch] Futurepedia 解析到 ${cards.length} 张卡片`);

  for (const card of cards) {
    if (items.length >= limit) break;

    if (!card.visitUrl) {
      skipped.noLink++;
      continue;
    }
    const domain = extractDomain(card.visitUrl);
    if (!domain || isExcludedHost(domain)) {
      skipped.excluded++;
      continue;
    }
    if (seenDomains.has(domain)) {
      skipped.seen++;
      continue;
    }
    if (existingNames.has(card.name.toLowerCase())) {
      skipped.seen++;
      continue;
    }

    seenDomains.add(domain);
    existingNames.add(card.name.toLowerCase());

    const now = new Date().toISOString();
    items.push({
      id: `tool-fp-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
      name: card.name.slice(0, 80),
      domain,
      url: `https://${domain}`,
      description: `${card.name} — Futurepedia 收录的 AI 工具`,
      descriptionSource: "source",
      categories: ["Other"],
      industry: "人工智能",
      // Futurepedia 不给票数信号，热度留空，交给流量富化后判定
      heatScore: 0,
      phUpvotes: null,
      phComments: null,
      githubStars: null,
      firstSeenAt: now,
      collectedAt: now,
      verified: "pending",
      sourceType: "directory",
      sourceUrl: `${DISCOVER_URL}#${card.slug}`,
    });
    console.log(`[fetch] FP ${card.name} → ${domain}`);
  }

  console.log(
    `[fetch] Futurepedia 产出 ${items.length}/${limit}｜无外链 ${skipped.noLink}` +
      `｜平台/黑名单 ${skipped.excluded}｜已在库 ${skipped.seen}`,
  );

  return { items, scanned: cards.length, skipped };
}

function extractDomain(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    return getDomain(host) || host;
  } catch {
    return "";
  }
}