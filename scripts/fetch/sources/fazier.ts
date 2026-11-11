import type { AITool } from "@horizons/shared";
import { getDomain } from "tldts";
import { isExcludedHost } from "../../admin/verdict";

/**
 * Fazier 采集源（Product Hunt 的竞品 launch 平台）。
 *
 * 接它的原因：PH 的 `/r/` 短链被 Cloudflare 挑战覆盖后完全解析不出域名，
 * 而 Fazier 是服务端直出的 HTML，卡片里同时带产品名、一句话描述、
 * 票数，以及**指向官网的直链**（带 `?ref=fazier` 来源参数）。
 * 形态上它就是 PH 的平替，单页实测可解析 55 张卡片。
 *
 * 卡片结构（2026-11 实测）：
 *   <div class="homeMainCard ...">
 *     <h5 class="... launch-title ...">PromptWise</h5>
 *     <p  class="... launch-tagline ...">Seedance, Kling, … </p>
 *     <div class="... upvote-count-text">8</div>
 *     <a href="https://promptwise.com?ref=fazier">
 */

const FAZIER_URL = "https://fazier.com/";

const HTML_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

interface FazierCard {
  name: string;
  tagline: string;
  visitUrl: string;
  upvotes: number;
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

/** 去掉 `?ref=fazier` 之类的来源标记 */
function cleanVisitUrl(raw: string): string {
  try {
    const u = new URL(decodeEntities(raw));
    for (const k of [...u.searchParams.keys()]) {
      if (/^(ref|utm_\w+|source|via)$/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\?$/, "");
  } catch {
    return "";
  }
}

function extractDomain(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    return getDomain(host) || host;
  } catch {
    return "";
  }
}

function parseCards(html: string): FazierCard[] {
  // 首页里 homeMainCard 有多种变体（广告位、骨架屏），只留字段齐全的
  const blocks = html.split('<div class="homeMainCard').slice(1);
  const cards: FazierCard[] = [];

  for (const block of blocks) {
    const nameMatch = /class="[^"]*launch-title[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i.exec(block);
    const taglineMatch = /class="[^"]*launch-tagline[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const voteMatch = /upvote-count-text[^>]*>\s*([0-9]+)\s*</i.exec(block);
    const linkMatch = /href="(https?:\/\/[^"]+)"/i.exec(block);

    if (!nameMatch || !linkMatch) continue;

    const name = stripTags(nameMatch[1]);
    const visitUrl = cleanVisitUrl(linkMatch[1]);
    if (!name || !visitUrl) continue;
    // 站内相对跳转 / 平台自身链接不算官网
    if (visitUrl.includes("fazier.com")) continue;

    cards.push({
      name,
      tagline: taglineMatch ? stripTags(taglineMatch[1]) : "",
      visitUrl,
      upvotes: voteMatch ? Number(voteMatch[1]) : 0,
    });
  }

  return cards;
}

function heatFromUpvotes(v: number): number {
  return Math.min(100, Math.round(Math.log10(v + 1) * 25));
}

export interface FazierFetchResult {
  items: AITool[];
  scanned: number;
  skipped: { excluded: number; seen: number; duplicate: number };
}

export async function fetchFazierTools(
  limit: number,
  existingNames: Set<string> = new Set(),
  seenDomains: Set<string> = new Set(),
): Promise<FazierFetchResult> {
  const skipped = { excluded: 0, seen: 0, duplicate: 0 };
  const items: AITool[] = [];

  let html: string;
  try {
    const res = await fetch(FAZIER_URL, { headers: HTML_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (e) {
    console.warn(`[fetch] Fazier 请求失败：${e instanceof Error ? e.message : e}，跳过本能源`);
    return { items, scanned: 0, skipped };
  }

  const cards = parseCards(html);
  console.log(`[fetch] Fazier 解析到 ${cards.length} 张卡片`);

  for (const card of cards) {
    if (items.length >= limit) break;

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
      skipped.duplicate++;
      continue;
    }

    seenDomains.add(domain);
    existingNames.add(card.name.toLowerCase());

    const now = new Date().toISOString();
    items.push({
      id: `tool-fazier-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
      name: card.name.slice(0, 80),
      domain,
      url: `https://${domain}`,
      description: card.tagline || `${card.name} — Fazier 上的新产品`,
      descriptionSource: "source",
      categories: ["Other"],
      industry: "人工智能",
      heatScore: heatFromUpvotes(card.upvotes),
      phUpvotes: null,
      phComments: null,
      hnPoints: null,
      githubStars: null,
      launchedAt: now,
      firstSeenAt: now,
      collectedAt: now,
      verified: "pending",
      sourceType: "directory",
      sourceUrl: card.visitUrl,
    });

    console.log(`[fetch] Fazier ${card.name} → ${domain}（${card.upvotes} 票）`);
  }

  console.log(
    `[fetch] Fazier 产出 ${items.length}/${limit}｜平台/黑名单 ${skipped.excluded}` +
      `｜已在库 ${skipped.seen}｜重名 ${skipped.duplicate}`,
  );

  return { items, scanned: cards.length, skipped };
}