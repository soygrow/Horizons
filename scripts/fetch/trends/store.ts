import fs from "node:fs";
import path from "node:path";
import type { AITrend, TrendDataset, TrendSourceRef } from "@horizons/shared";
import type { TrendCandidate } from "./discovery";
import { normalizeKey, slugify } from "./discovery";

export const DATASET_PATH = path.resolve(process.cwd(), "content/trends.json");

export function loadDataset(): TrendDataset {
  try {
    const raw = JSON.parse(fs.readFileSync(DATASET_PATH, "utf-8")) as TrendDataset;
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      mode: raw.mode ?? "live",
      region: raw.region ?? "US",
      keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
      ...(raw.policy ? { policy: raw.policy } : {}),
    };
  } catch {
    return { updatedAt: new Date().toISOString(), mode: "live", region: "US", keywords: [] };
  }
}

/** 原子写入：先写临时文件再 rename，避免采集中断留下半个 JSON */
export function saveDataset(ds: TrendDataset): void {
  const seen = new Set<string>();
  const keywords: AITrend[] = [];
  for (const t of ds.keywords) {
    if (!t || typeof t.slug !== "string" || typeof t.keyword !== "string") continue;
    if (seen.has(t.slug)) continue;
    if (!Array.isArray(t.series?.values) || t.series.values.length === 0) continue;
    seen.add(t.slug);
    keywords.push(t);
  }
  const payload: TrendDataset = { ...ds, keywords };
  const tmp = `${DATASET_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, DATASET_PATH);
}

export interface TrendInput {
  keyword: string;
  series: AITrend["series"];
  trendParts: AITrend["trendParts"];
  oppParts: AITrend["oppParts"];
  status: AITrend["status"];
  confidence: AITrend["confidence"];
  category: AITrend["category"];
  normalizedName: string;
  why: string;
  intentSummary: string;
  editorNote?: AITrend["editorNote"];
  sources: TrendSourceRef[];
  evidence: AITrend["evidence"];
  intents: AITrend["intents"];
  relatedQueries: string[];
  competitors: string[];
  opportunities: AITrend["opportunities"];
  actions: AITrend["actions"];
  region: string;
  now: Date;
}

export function buildTrend(input: TrendInput, existing?: AITrend): AITrend {
  const today = input.now.toISOString().slice(0, 10);
  return {
    slug: existing?.slug ?? uniqueSlug(input.keyword),
    keyword: input.keyword,
    normalizedName: input.normalizedName,
    category: input.category,
    region: input.region,
    status: input.status,
    confidence: input.confidence,
    why: input.why,
    intentSummary: input.intentSummary,
    // 判定结论跟着词走：没有就别硬塞空对象
    ...((input.editorNote ?? existing?.editorNote)
      ? { editorNote: input.editorNote ?? existing?.editorNote }
      : {}),
    // 首次发现永不覆盖，用于「新颖度」与页面展示
    firstSeenAt: existing?.firstSeenAt ?? today,
    lastSeenAt: today,
    updatedAt: input.now.toISOString(),
    series: input.series,
    trendParts: input.trendParts,
    oppParts: input.oppParts,
    sources: input.sources,
    evidence: input.evidence,
    intents: input.intents,
    relatedQueries: input.relatedQueries,
    competitors: input.competitors,
    opportunities: input.opportunities,
    actions: input.actions,
  };
}

const globalSlugs = new Set<string>();

export function primeSlugs(trends: AITrend[]): void {
  for (const t of trends) globalSlugs.add(t.slug);
}

export function uniqueSlug(keyword: string): string {
  const base = slugify(keyword);
  if (!globalSlugs.has(base)) {
    globalSlugs.add(base);
    return base;
  }
  let i = 2;
  while (globalSlugs.has(`${base}-${i}`)) i++;
  const slug = `${base}-${i}`;
  globalSlugs.add(slug);
  return slug;
}

export function indexByKey(trends: AITrend[]): Map<string, AITrend> {
  const map = new Map<string, AITrend>();
  for (const t of trends) map.set(normalizeKey(t.keyword), t);
  return map;
}

export function upsert(trends: AITrend[], trend: AITrend): AITrend[] {
  const key = normalizeKey(trend.keyword);
  const idx = trends.findIndex((t) => normalizeKey(t.keyword) === key);
  if (idx >= 0) {
    const next = [...trends];
    next[idx] = trend;
    return next;
  }
  return [...trends, trend];
}

export interface BatchItem {
  keyword: string;
  origin: TrendCandidate["origin"] | "refresh";
  seedSources: TrendSourceRef[];
  existing?: AITrend;
}

/**
 * 采集排队：新词与「陈旧词刷新」按比例混合。
 * budget = 本次最多联网验证多少个词（采集频率的唯一开关）。
 */
export function planBatch(params: {
  candidates: TrendCandidate[];
  existing: AITrend[];
  budget: number;
  refreshAfterDays: number;
  newRatio: number;
  today: string;
}): BatchItem[] {
  const { candidates, existing, budget, refreshAfterDays, newRatio, today } = params;
  const keyed = indexByKey(existing);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const daysSince = (d: string): number => {
    const ms = Date.parse(`${d}T00:00:00Z`);
    return Number.isNaN(ms) ? 999 : Math.round((todayMs - ms) / 86_400_000);
  };

  const fresh: TrendCandidate[] = [];
  for (const c of candidates) {
    if (keyed.has(c.normalizedKey)) continue;
    fresh.push(c);
  }
  // 先按来源可信度排，再按热度信号：手工种子 > 工具库 > 已收词相关搜索 > Trending RSS > PH > GitHub
  const ORIGIN_RANK: Record<TrendCandidate["origin"], number> = {
    seed: 0,
    aitools: 1,
    related: 2,
    rss: 3,
    ph: 4,
    github: 5,
  };
  fresh.sort(
    (a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || b.weight - a.weight,
  );

  const stale: AITrend[] = existing
    .filter((t) => daysSince(t.lastSeenAt) >= refreshAfterDays)
    .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt));

  const newQuota = Math.min(fresh.length, Math.max(0, Math.round(budget * newRatio)));
  const refreshQuota = Math.min(stale.length, budget - newQuota);

  const batch: BatchItem[] = [];
  for (const c of fresh.slice(0, newQuota)) {
    batch.push({ keyword: c.keyword, origin: c.origin, seedSources: c.sources });
  }
  for (const t of stale.slice(0, refreshQuota)) {
    batch.push({ keyword: t.keyword, origin: "refresh", seedSources: [], existing: t });
  }
  // 配额没用满时互相补位
  if (batch.length < budget) {
    for (const c of fresh.slice(newQuota, newQuota + (budget - batch.length))) {
      batch.push({ keyword: c.keyword, origin: c.origin, seedSources: c.sources });
    }
  }
  if (batch.length < budget) {
    for (const t of stale.slice(refreshQuota, refreshQuota + (budget - batch.length))) {
      batch.push({ keyword: t.keyword, origin: "refresh", seedSources: [], existing: t });
    }
  }
  return batch;
}