// 科技媒体 / 官方博客：RSS 与 Atom。
// 不引第三方解析库：feed 结构固定，正则足够，且少一个依赖。

import { dailyConfig, type RssSource } from "../config";
import { getText } from "../http";
import { cleanTitle, isAiRelevant, makeItem, toIso, withinWindow, windowStartIso } from "../normalize";
import type { RawItem } from "../types";

interface ParsedEntry {
  title: string;
  link: string;
  id: string;
  publishedAt: string | null;
  summary: string;
}

function tag(block: string, names: string[]): string {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
    const m = block.match(re);
    if (m) return cleanTitle(m[1]);
  }
  return "";
}

function atomLink(block: string): string {
  // 优先 rel="alternate"，其次第一个带 href 的 link
  const all = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pick =
    all.find((attrs) => /rel=["']alternate["']/i.test(attrs) && /href=/i.test(attrs)) ??
    all.find((attrs) => /href=/i.test(attrs));
  if (!pick) return "";
  const href = pick.match(/href=["']([^"']+)["']/i);
  return href ? href[1] : "";
}

/** 解析 RSS 2.0 与 Atom，返回条目；解析失败返回空数组而不是抛错 */
export function parseFeed(xml: string): ParsedEntry[] {
  const blocks = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
  const out: ParsedEntry[] = [];
  for (const block of blocks) {
    const title = tag(block, ["title"]);
    const rawLink = tag(block, ["link"]) || atomLink(block);
    const id = tag(block, ["guid", "id"]) || rawLink;
    const date = tag(block, ["pubDate", "published", "updated", "dc:date"]);
    // content:encoded 通常更接近全文，信息密度高于 description 的手写摘要；优先取它
    const summary = tag(block, ["content:encoded", "content", "description", "summary"]).slice(0, 400);
    if (!title || !rawLink) continue;
    out.push({ title, link: rawLink, id, publishedAt: toIso(date), summary });
  }
  return out;
}

export interface RssResult {
  items: RawItem[];
  note: string;
}

export async function collectRss(sources: RssSource[] = dailyConfig.rss): Promise<RssResult> {
  const since = windowStartIso(dailyConfig.lookbackHours);
  const items: RawItem[] = [];
  const seen = new Set<string>();
  const notes: string[] = [];

  for (const src of sources) {
    const t0 = Date.now();
    try {
      // 不可达的源会拖慢整轮：只重试 1 次，超时压到 12s
      const xml = await getText(src.url, {
        timeoutMs: 12_000,
        retries: 1,
        ...(src.userAgent ? { headers: { "user-agent": src.userAgent } } : {}),
      });
      // 有些站点的 feed 地址会返回 HTML（404 页 / 反爬页），先确认根节点
      if (!/<rss\b|<feed\b|<rdf:RDF\b/i.test(xml)) {
        notes.push(`${src.name} 非 feed（返回了 HTML 或错误页）`);
        continue;
      }
      const all = parseFeed(xml);
      // 论文/社区源的日更量远大于媒体，先截断再过滤，避免把候选池挤满
      const entries = src.maxItems ? all.slice(0, src.maxItems) : all;
      let kept = 0;
      let relevant = 0;
      for (const e of entries) {
        const item = makeItem({
          source: "rss",
          sourceItemId: e.id || e.link,
          title: e.title,
          url: e.link,
          publishedAt: e.publishedAt,
          firstHand: src.firstHand ?? false,
          categoryText: e.summary,
          raw: { feed: src.name, summary: e.summary },
        });
        if (!withinWindow(item, since)) continue;
        if (!isAiRelevant(`${e.title} ${e.summary}`)) continue;
        relevant++;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
        kept++;
      }
      notes.push(
        `${src.name} ${kept}/${all.length}${src.maxItems ? `（只看前 ${src.maxItems}）` : ""}（AI 相关 ${relevant}）`,
      );
    } catch (e) {
      notes.push(`${src.name} 失败（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  return { items, note: notes.join("，") };
}