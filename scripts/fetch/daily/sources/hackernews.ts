// Hacker News：Algolia 公开接口（1–2 次请求拿到窗口内全部高分帖）。
// 不用「关键词搜索」做主力：Algolia 的多词查询命中率很低（"AI model release" 30 小时只回 2 条），
// 正确做法是先按分数拉全量候选，再在本地做 AI 相关性过滤。

import { dailyConfig } from "../config";
import { getJson, sleep } from "../http";
import { isAiRelevant, makeItem, toIso, withinWindow, windowStartIso } from "../normalize";
import type { RawItem } from "../types";

const BASE = "https://hn.algolia.com/api/v1/search";

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  story_title?: string | null;
  url: string | null;
  story_url?: string | null;
  author: string | null;
  created_at_i: number;
  points?: number | null;
  num_comments?: number | null;
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
  page: number;
  nbPages: number;
}

function toItem(hit: AlgoliaHit): RawItem | null {
  const title = hit.title ?? hit.story_title ?? null;
  if (!title) return null;
  // 无外链的「Ask HN / Show HN」保留，用讨论页作为原始链接
  const url = hit.url ?? hit.story_url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`;
  return makeItem({
    source: "hackernews",
    sourceItemId: hit.objectID,
    title,
    url,
    author: hit.author,
    publishedAt: toIso(hit.created_at_i),
    signals: { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
    raw: { points: hit.points ?? 0, comments: hit.num_comments ?? 0 },
  });
}

export async function collectHackerNews(): Promise<{ items: RawItem[]; note: string }> {
  const cfg = dailyConfig.hackernews;
  const sinceIso = windowStartIso(dailyConfig.lookbackHours);
  const sinceUnix = Math.floor(Date.parse(sinceIso) / 1000);
  const filters = encodeURIComponent(`created_at_i>${sinceUnix},points>${cfg.minPoints}`);

  const seen = new Set<string>();
  const items: RawItem[] = [];
  const notes: string[] = [];
  let scanned = 0;

  for (let page = 0; page < cfg.maxPages; page++) {
    const url =
      `${BASE}?tags=story&numericFilters=${filters}` +
      `&hitsPerPage=${cfg.hitsPerPage}&page=${page}`;
    try {
      const res = await getJson<AlgoliaResponse>(url, { timeoutMs: 15_000 });
      scanned += res.hits.length;
      for (const hit of res.hits) {
        const item = toItem(hit);
        if (!item || seen.has(item.id)) continue;
        // 高分帖里混着人物、币圈、体育，必须过 AI 相关性闸门
        if (!isAiRelevant(item.title)) continue;
        if (!withinWindow(item, sinceIso)) continue;
        seen.add(item.id);
        items.push(item);
      }
      if (res.page >= res.nbPages - 1) break;
    } catch (e) {
      notes.push(`第 ${page + 1} 页失败：${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    await sleep(600);
  }

  const note = `扫描 ${scanned} 条高分帖，AI 相关 ${items.length} 条${notes.length ? `；${notes.join("；")}` : ""}`;
  return { items, note };
}