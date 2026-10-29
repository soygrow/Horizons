import type { TrendSeries } from "@horizons/shared";
import { sleep, stripXssi, trendsGet } from "../http";
import { proxyGet } from "../../proxy";

/** 与 Explore 页面一致：3 个月日粒度，落库时只保留最近 30 天 */
export const TIME_RANGE = "today 3-m";
export const KEEP_POINTS = 30;

interface ExploreWidget {
  id: string;
  token: string;
  request: unknown;
}

export interface InterestResult {
  series: TrendSeries;
  relatedQueries: string[];
}

export interface TrendingRssItem {
  keyword: string;
  approxTraffic: number | null;
  publishedAt: string | null;
  geo: string;
  newsUrls: string[];
}

function toDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * 拉取单个关键词的兴趣曲线（0–100 归一化相对热度）。
 * 单个关键词单独请求，避免多词对比把数值归一到组内最大值。
 */
export async function fetchInterest(
  keyword: string,
  geo: string,
  withRelated = true,
): Promise<InterestResult> {
  const req = {
    comparisonItem: [{ keyword, geo, time: TIME_RANGE }],
    category: 0,
    property: "",
  };
  const explore = JSON.parse(
    stripXssi(
      await trendsGet("/trends/api/explore", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(req),
      }),
    ),
  ) as { widgets?: ExploreWidget[] };

  const widgets = explore.widgets ?? [];
  const tsWidget = widgets.find((w) => w.id === "TIMESERIES");
  if (!tsWidget) throw new Error(`无 TIMESERIES widget：${keyword}`);

  const multi = JSON.parse(
    stripXssi(
      await trendsGet("/trends/api/widgetdata/multiline", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(tsWidget.request),
        token: tsWidget.token,
      }),
    ),
  ) as { default?: { timelineData?: Array<{ time: string; value: number[] }> } };

  const points = multi.default?.timelineData ?? [];
  if (points.length === 0) throw new Error(`空序列：${keyword}`);

  const startIndex = Math.max(0, points.length - KEEP_POINTS);
  const kept = points.slice(startIndex);
  const values = kept.map((p) => p.value?.[0] ?? 0);
  if (values.every((v) => v === 0)) throw new Error(`全 0 序列（无足够搜索量）：${keyword}`);

  const series: TrendSeries = {
    start: toDate(Number(kept[0].time)),
    stepDays: 1,
    values,
  };

  let relatedQueries: string[] = [];
  if (withRelated) {
    try {
      relatedQueries = await fetchRelatedQueries(widgets, keyword);
    } catch {
      // 相关查询属于加分证据，失败不影响主流程
    }
  }

  return { series, relatedQueries };
}

/** 对比组上限：Google Trends 的 comparisonItem 最多 5 项 */
export const COMPARE_LIMIT = 5;
/** 尺度锚点词：常年在高位，用来把不同批次的归一化曲线还原到同一尺度 */
export const ANCHOR_KEYWORD = "chatgpt";
/** 锚点峰值基准：锚点自身峰值视为 100 */
const ANCHOR_PEAK = 100;
/** 批内原始峰值低于此值说明值域太窄（0–100 整数），量化误差过大 */
const WEAK_PEAK = 10;

export interface BatchInterest {
  /** keyword → 曲线（已按锚点还原尺度） */
  series: Map<string, TrendSeries>;
  /** 批内值域太小、精度不足，调用方应单词重取 */
  weak: string[];
  /** 批内无搜索量（全 0） */
  missing: string[];
}

/**
 * 批量拉取：一批最多 4 个词 + 1 个锚点，只花 2 次请求（explore + multiline），
 * 相比单词请求（每词 2–3 次）请求量降 4–6 倍，是绕开 429 的主要手段。
 *
 * 归一化问题：comparisonItem 会把整组归一到组内最大值，绝对值不可比。
 * 由于 T 分全部是比例指标（growth7 / aboveBaseline / peak÷baseline），
 * 常量缩放不影响评分；这里仍用锚点把各组统一到「锚点峰值 = 100」的尺度，
 * 让 series 的绝对值在不同批次间保持一致含义。
 */
export async function fetchInterestBatch(
  keywords: string[],
  geo: string,
  anchor = ANCHOR_KEYWORD,
): Promise<BatchInterest> {
  const rest = keywords.filter((k) => k.toLowerCase() !== anchor.toLowerCase());
  const group = [anchor, ...rest].slice(0, COMPARE_LIMIT);

  const req = {
    comparisonItem: group.map((keyword) => ({ keyword, geo, time: TIME_RANGE })),
    category: 0,
    property: "",
  };
  const explore = JSON.parse(
    stripXssi(
      await trendsGet("/trends/api/explore", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(req),
      }),
    ),
  ) as { widgets?: ExploreWidget[] };

  const widgets = explore.widgets ?? [];
  const tsWidget = widgets.find((w) => w.id === "TIMESERIES");
  if (!tsWidget) throw new Error(`无 TIMESERIES widget：${group.join(" / ")}`);

  const multi = JSON.parse(
    stripXssi(
      await trendsGet("/trends/api/widgetdata/multiline", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(tsWidget.request),
        token: tsWidget.token,
      }),
    ),
  ) as { default?: { timelineData?: Array<{ time: string; value: number[] }> } };

  const points = multi.default?.timelineData ?? [];
  if (points.length === 0) throw new Error(`空序列：${group.join(" / ")}`);

  const kept = points.slice(Math.max(0, points.length - KEEP_POINTS));
  const start = toDate(Number(kept[0].time));
  const columns = group.map((_, i) => kept.map((p) => p.value?.[i] ?? 0));

  const anchorPeak = Math.max(0, ...columns[0]);
  const scale = anchorPeak > 0 ? ANCHOR_PEAK / anchorPeak : 1;

  const series = new Map<string, TrendSeries>();
  const weak: string[] = [];
  const missing: string[] = [];

  for (let i = 1; i < group.length; i++) {
    const keyword = group[i];
    const raw = columns[i];
    const rawPeak = Math.max(0, ...raw);
    if (rawPeak === 0) {
      missing.push(keyword);
      continue;
    }
    if (rawPeak < WEAK_PEAK) {
      weak.push(keyword);
      continue;
    }
    series.set(keyword, {
      start,
      stepDays: 1,
      values: raw.map((v) => Math.max(0, Math.round(v * scale))),
    });
  }

  return { series, weak, missing };
}

async function fetchRelatedQueries(
  widgets: ExploreWidget[],
  keyword: string,
): Promise<string[]> {
  const widget = widgets.find((w) => w.id === "RELATED_QUERIES");
  if (!widget) return [];
  await sleep(800);
  const data = JSON.parse(
    stripXssi(
      await trendsGet("/trends/api/widgetdata/relatedsearches", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(widget.request),
        token: widget.token,
      }),
    ),
  ) as { default?: { rankedList?: Array<{ rankedKeyword?: Array<{ query?: string }> }> } };

  const list = data.default?.rankedList ?? [];
  const out = new Set<string>();
  for (const group of list) {
    for (const item of group.rankedKeyword ?? []) {
      const q = item.query?.trim();
      if (q && q.toLowerCase() !== keyword.toLowerCase()) out.add(q);
    }
  }
  return [...out].slice(0, 12);
}

/** Trending now 官方 RSS：免费、无限流压力，用于发现新词 */
export async function fetchTrendingRss(geo: string): Promise<TrendingRssItem[]> {
  const res = await proxyGet(`https://trends.google.com/trending/rss?geo=${geo}`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "application/rss+xml, application/xml, text/xml",
    },
    timeoutMs: 20_000,
  });
  if (!res.ok) throw new Error(`Trends RSS ${geo} ${res.status}`);
  const xml = await res.text();

  const items: TrendingRssItem[] = [];
  for (const block of xml.match(/<item>([\s\S]*?)<\/item>/g) ?? []) {
    const pick = (tag: string): string | null => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
    };
    const title = pick("title");
    if (!title) continue;
    const traffic = pick("ht:approx_traffic");
    const pubDate = pick("pubDate");
    const newsUrls: string[] = [];
    for (const m of block.matchAll(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/g)) {
      newsUrls.push(m[1].trim());
    }
    items.push({
      keyword: title,
      approxTraffic: traffic ? parseInt(traffic.replace(/[^0-9]/g, ""), 10) || null : null,
      publishedAt: pubDate ? new Date(pubDate).toISOString().slice(0, 10) : null,
      geo,
      newsUrls: newsUrls.slice(0, 3),
    });
  }
  return items;
}