import fs from "node:fs";
import path from "node:path";
import type {
  AITrend,
  TrendContentSnapshot,
  TrendDataset,
  TrendRankRow,
  TrendSourceRef,
  ValueVerdict,
} from "@horizons/shared";
import type { Enrichment } from "./enrich";
import type { KeywordEvidence, TrendCandidate } from "./discovery";
import { normalizeKey, slugify } from "./discovery";

export const DATASET_PATH = path.resolve(process.cwd(), "content/trends.json");
/**
 * 候选池：本轮采集出的词先落这里，等后台人工审核后才并入榜单。
 *
 * 和 tools-staging.json 同一套思路——采集与发布解耦，采集跑完线上不会有任何变化。
 * 只存本轮碰到的词（约 80 个），不是全量，避免 5MB 的榜单文件被整份复制。
 */
export const STAGING_PATH = path.resolve(process.cwd(), "content/trends-staging.json");

export interface TrendStaging {
  updatedAt: string;
  runAt: string;
  /** 本轮新增或刷新过的词，带完整数据，可直接进榜单 */
  items: AITrend[];
  /** 后台拒绝的词（按 keyword 原文），下次采集跳过、发布时过滤 */
  rejected: string[];
  /**
   * 未富化词的富化输入：HN/GitHub 原始条目 + Google 相关查询。
   * 富化时直接用，避免重新联网——Trends 配额贵，HN/GitHub 也要几秒。
   */
  pendingEvidence?: Record<string, { evidence: KeywordEvidence; relatedQueries: string[] }>;
  /**
   * 价值准入判定缓存（按 normalizeKey）。
   *
   * 候选池模式**不写 content/trends.json**（那会触发站点重建），判定结果只能记在这里；
   * 不然每轮采集都要把同一批候选重新判一遍，纯白烧 LLM 的钱。
   */
  verdicts?: Record<string, ValueVerdict>;
  /**
   * 采集那一刻的榜单计分快照（slug + 六项分，几十 KB）。
   *
   * 后台点「发布预览」要回答「谁的名次会变」，本来需要读 5MB 的 trends.json。
   * 把它压缩成这份快照存进候选池，Worker 里就能直接算，不用碰大文件。
   */
  board?: {
    updatedAt: string;
    rows: TrendRankRow[];
  };
  lastRun?: {
    ok: number;
    failed: number;
    total: number;
    budget: number;
    geo: string;
  };
  /**
   * 上一次发布的位次变化摘要。
   * 发布后 items 会被清空，没有这块的话「刚才那一下动了谁」就查不到了。
   */
  lastPublish?: {
    at: string;
    incoming: number;
    removed: number;
    boardBefore: number;
    boardAfter: number;
    entered: number;
    exited: number;
    significant: number;
    shifted: number;
    /** 因超出榜单上限被淘汰的词（含别名） */
    trimmed?: number;
    top: { keyword: string; slug: string; from: number | null; to: number | null; delta: number }[];
  };
}

export function loadStaging(): TrendStaging {
  try {
    const raw = JSON.parse(fs.readFileSync(STAGING_PATH, "utf-8")) as Partial<TrendStaging>;
    return {
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      runAt: raw.runAt ?? new Date().toISOString(),
      items: Array.isArray(raw.items) ? raw.items : [],
      rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
      // 这两个字段以前漏了映射：富化时取不到暂存证据，等于每词都空手喂 LLM
      ...(raw.pendingEvidence
        ? { pendingEvidence: raw.pendingEvidence as TrendStaging["pendingEvidence"] }
        : {}),
      ...(raw.verdicts ? { verdicts: raw.verdicts as TrendStaging["verdicts"] } : {}),
      ...(raw.board ? { board: raw.board } : {}),
      ...(raw.lastRun ? { lastRun: raw.lastRun } : {}),
      ...(raw.lastPublish ? { lastPublish: raw.lastPublish } : {}),
    };
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      runAt: new Date().toISOString(),
      items: [],
      rejected: [],
    };
  }
}

export function saveStaging(payload: TrendStaging): void {
  const seen = new Set<string>();
  const items: AITrend[] = [];
  for (const t of payload.items) {
    if (!t || typeof t.slug !== "string" || typeof t.keyword !== "string") continue;
    if (seen.has(t.slug)) continue;
    if (!Array.isArray(t.series?.values) || t.series.values.length === 0) continue;
    seen.add(t.slug);
    items.push(t);
  }
  const tmp = `${STAGING_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...payload, items }, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, STAGING_PATH);
}

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

export interface PendingTrendInput {
  keyword: string;
  series: AITrend["series"];
  trendParts: AITrend["trendParts"];
  status: AITrend["status"];
  confidence: AITrend["confidence"];
  sources: TrendSourceRef[];
  editorNote?: AITrend["editorNote"];
  region: string;
  now: Date;
}

/**
 * 阶段一产物：只带曲线与趋势分，内容字段留空等人工确认后富化。
 *
 * 刷新榜内已有词时**保留原有内容**，只覆盖序列类字段——
 * 「不勾选 = 不刷新内容」这条语义就是靠它成立的。
 */
export function buildPendingTrend(input: PendingTrendInput, existing?: AITrend): AITrend {
  const today = input.now.toISOString().slice(0, 10);
  if (existing) {
    return {
      ...existing,
      keyword: input.keyword,
      series: input.series,
      trendParts: input.trendParts,
      status: input.status,
      confidence: input.confidence,
      sources: input.sources,
      ...(input.editorNote ? { editorNote: input.editorNote } : {}),
      lastSeenAt: today,
      updatedAt: input.now.toISOString(),
    };
  }
  return {
    slug: uniqueSlug(input.keyword),
    keyword: input.keyword,
    normalizedName: input.keyword,
    category: "broadtech",
    region: input.region,
    status: input.status,
    confidence: input.confidence,
    why: "",
    firstSeenAt: today,
    lastSeenAt: today,
    updatedAt: input.now.toISOString(),
    series: input.series,
    trendParts: input.trendParts,
    oppParts: { demand: 0, wedge: 0, seo: 0, feasibility: 0, timing: 0 },
    sources: input.sources,
    evidence: [],
    ...(input.editorNote ? { editorNote: input.editorNote } : {}),
    intents: [],
    opportunities: [],
    actions: [],
    enrichStatus: "pending",
  };
}

/**
 * 阶段二产物：把富化结果装配成可发布的词。
 *
 * 采集主线（run.ts）与后台富化脚本（enrich-trends.ts）共用这一份装配，
 * 避免两处各抄一遍二十来个字段——以后加字段漏掉一边，线上内容就会缺块。
 */
export function buildEnrichedTrend(
  base: PendingTrendInput,
  enrich: Enrichment,
  existing?: AITrend,
): AITrend {
  const trend = buildTrend(
    {
      keyword: base.keyword,
      series: base.series,
      trendParts: base.trendParts,
      oppParts: enrich.oppParts,
      status: base.status,
      confidence: base.confidence,
      category: enrich.category,
      normalizedName: enrich.normalizedName,
      why: enrich.why,
      intentSummary: enrich.intentSummary,
      editorNote: enrich.editorNote ?? base.editorNote,
      sources: base.sources,
      evidence: enrich.evidence,
      intents: enrich.intents,
      relatedQueries: enrich.relatedQueries,
      competitors: enrich.competitors,
      opportunities: enrich.opportunities,
      actions: enrich.actions,
      region: base.region,
      now: base.now,
    },
    existing,
  );
  // 富化完成即视为可发布：去掉分段标记
  delete trend.enrichStatus;
  // 刷新在榜词时留一份旧内容：新版本可能更差，后台要能对比、能回滚
  if (existing) trend.previousSnapshot = snapshotOf(existing);
  return trend;
}

/**
 * 抽取内容快照。只留富化产物，曲线/评分/来源每轮都会重算，不进快照。
 */
export function snapshotOf(t: AITrend): TrendContentSnapshot {
  return {
    at: t.updatedAt,
    normalizedName: t.normalizedName,
    category: t.category,
    why: t.why,
    ...(t.intentSummary ? { intentSummary: t.intentSummary } : {}),
    ...(t.editorNote ? { editorNote: t.editorNote } : {}),
    oppParts: t.oppParts,
    evidence: t.evidence,
    intents: t.intents,
    ...(t.relatedQueries ? { relatedQueries: t.relatedQueries } : {}),
    ...(t.competitors ? { competitors: t.competitors } : {}),
    opportunities: t.opportunities,
    actions: t.actions,
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

/** 候选池保留天数：超过这个时间没再被采集命中就清掉，避免池子只涨不落 */
export const STAGING_TTL_DAYS = 15;

/**
 * 清理过期候选。
 *
 * 以「最近一次采集命中」（lastSeenAt）为准：firstSeenAt 永远不动，
 * 拿它算会把老词整片清掉；本轮命中的词 lastSeenAt 刚更新，不会被误伤。
 */
export function pruneStaging(
  items: AITrend[],
  now: Date = new Date(),
): { kept: AITrend[]; dropped: AITrend[] } {
  const cutoff = now.getTime() - STAGING_TTL_DAYS * 24 * 60 * 60 * 1000;
  const kept: AITrend[] = [];
  const dropped: AITrend[] = [];
  for (const t of items) {
    const seen = Date.parse(t.lastSeenAt || t.firstSeenAt || t.updatedAt || "");
    if (Number.isFinite(seen) && seen < cutoff) dropped.push(t);
    else kept.push(t);
  }
  return { kept, dropped };
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