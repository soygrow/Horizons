/**
 * 榜单产物生成器（W1-D1）
 *
 * 输入：content/*.json      —— 只读，唯一真源（花钱采集的数据，任何脚本都不写）
 * 输出：content/dist/**     —— 派生，可随时删除重建
 *
 * 口径：直接复用 apps/web/src/lib/data.ts 的派生函数，保证新旧站计算结果完全一致。
 *
 * 用法：pnpm --filter @horizons/site data
 *   或：cd apps/web && pnpm exec tsx --tsconfig ./tsconfig.json ../../scripts/build/artifacts.ts
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  tools,
  listedTools,
  tierOf,
  githubRepos,
  githubUpdatedAt,
  getToolsByScore,
  getReposByScore,
  getBoards,
  getGithubTop,
  allCategories,
  computeGrowth,
  trafficSparklinePoints,
  getMonthlyVisits,
  getMoMGrowth,
  getOrganicVisits,
  getOrganicShare,
  getDomainWeight,
  getLaunchedAt,
  derivePricingModel,
  repoScore,
  repoIntro,
  repoDifficulty,
  computeStarGrowth,
  repoUpdatedDays,
  starSparklinePoints,
  isPermissiveLicense,
} from "../../apps/web/src/lib/data";

// 趋势词口径同样复用 web 端实现
import {
  trendKeywords,
  trendsUpdatedAt,
  trendDataMode,
  trendCategoryLabels,
  trendStatusMeta,
  trendConfidenceMeta,
  opportunityTypeMeta,
  trendMetrics,
  trendSparkline,
  hasEnoughData,
  trendScore,
  opportunityScore,
  overallScore,
  daysSince,
} from "../../apps/web/src/lib/trends";

// 行 HTML 唯一模板源（同一样式在构建期与浏览器筛选时共用）
import { modelRowHtml, repoRowHtml, toolRowHtml, trendRowHtml } from "../../apps/site/src/lib/row-html";
import type { ModelRow, RepoRow, ToolRow, TrendRow } from "../../apps/site/src/lib/types";
import { formatCount, formatDateShort } from "../../apps/site/src/lib/format";
import {
  formatTokens,
  gradeOf,
  modelModalityLabels,
  // 注意：model-score 与 trends 都导出 overallScore，这里重命名避免后者覆盖前者
  overallScore as modelOverallScore,
  priceText,
  valueScores,
} from "../../apps/site/src/lib/model-score";

// 机会榜：评分口径、证据解析、构建期硬闸门（唯一实现，页面与本脚本共用）
import {
  BOARD_LABELS,
  OPPORTUNITY_WEIGHTS,
  buildOpportunityDetails,
  buildOpportunityRows,
  summarizeBatches,
  validateOpportunities,
} from "../../apps/site/src/lib/opportunity";
import type { BoardIndex, OpportunityFile } from "../../apps/site/src/lib/opportunity";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "content/dist");
const GENERATED_AT = new Date().toISOString();

/* ------------------------------- 工具函数 ------------------------------- */

const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 12);

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
const gz = (v: unknown) => kb(gzipSync(JSON.stringify(v)).length);

async function write(rel: string, data: unknown) {
  const file = path.join(OUT, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

async function writeMany(entries: { rel: string; data: unknown }[], batch = 120) {
  for (let i = 0; i < entries.length; i += batch) {
    await Promise.all(entries.slice(i, i + batch).map((e) => write(e.rel, e.data)));
  }
}

function fail(msg: string): never {
  console.error(`\n✗ 产物校验失败：${msg}\n构建已中断，源数据未被修改。\n`);
  process.exit(1);
}

function tally(values: (string | null | undefined)[]) {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));
}

/* ------------------------------- 行数据 ------------------------------- */

/** AI 工具榜列表行（客户端筛选/渲染所需字段 + 预渲染 HTML） */
function toToolRow(t: (typeof tools)[number], rank: number): ToolRow {
  const dw = getDomainWeight(t);
  // 上游会把缺失的 DR 写成字符串 "n/a"，只认有限数值，否则按无数据处理
  const drValue = typeof dw.value === "number" && Number.isFinite(dw.value) ? dw.value : null;
  const row: Omit<ToolRow, "h"> = {
    rank,
    tier: tierOf(t) === "watch" ? "watch" : "core",
    id: t.id,
    domain: t.domain,
    name: t.name,
    url: t.url,
    desc: t.description,
    cats: t.categories,
    visits: getMonthlyVisits(t) ?? null,
    mom: getMoMGrowth(t) ?? null,
    organic: getOrganicVisits(t) ?? null,
    org: getOrganicShare(t) ?? null,
    scale: t.githubStars
      ? `★ ${formatCount(t.githubStars)}`
      : t.phUpvotes
        ? `▲ ${formatCount(t.phUpvotes)}`
        : null,
    dr: drValue,
    drLabel: drValue === null ? null : (dw.label ?? null),
    heat: t.heatScore,
    growth: computeGrowth(t),
    spark: trafficSparklinePoints(t)?.map((v) => Math.round(v * 100)) ?? null,
    launchedAt: getLaunchedAt(t) ?? null,
    pricing: derivePricingModel(t) ?? null,
    verified: t.verified,
    tags: t.tags ?? [],
    firstSeenAt: t.firstSeenAt,
    collectedAt: t.collectedAt,
  };
  return { ...row, h: toolRowHtml(row as ToolRow) };
}

/** GitHub 榜列表行 */
function toRepoRow(r: (typeof githubRepos)[number], rank: number): RepoRow {
  const s = repoScore(r);
  const row: Omit<RepoRow, "h"> = {
    rank,
    fullName: r.fullName,
    owner: r.owner,
    repo: r.repo,
    name: r.name,
    url: r.htmlUrl,
    avatar: r.avatarUrl ?? null,
    intro: repoIntro(r).slice(0, 120),
    // 搜索口径与现站一致：fullName + description + repoIntro
    desc: r.description ?? null,
    diff: repoDifficulty(r),
    cats: r.categories,
    lang: r.language ?? null,
    stars: r.stars,
    forks: r.forks,
    score: s.score,
    grade: s.grade,
    dv: typeof r.derivative?.space === "number" ? r.derivative.space : null,
    g7: computeStarGrowth(r, 7),
    g30: computeStarGrowth(r, 30),
    // 0-100 整数：88px 宽度下与 4 位小数视觉无差异，体积约为 1/3
    spark: starSparklinePoints(r)?.map((v) => Math.round(v * 100)) ?? null,
    license: r.license?.spdx ?? null,
    permissive: isPermissiveLicense(r),
    pushedDaysAgo: repoUpdatedDays(r),
    updatedAt: r.pushedAt ?? null,
    createdAt: r.createdAt ?? null,
  };
  return { ...row, h: repoRowHtml(row as RepoRow) };
}

/** AI 趋势词行 */
function toTrendRow(t: (typeof trendKeywords)[number], rank: number): TrendRow {
  const m = trendMetrics(t);
  const scored = hasEnoughData(t);
  const st = trendStatusMeta[t.status];
  const cf = trendConfidenceMeta[t.confidence];
  const growth = m.growth7;
  const growthCls =
    growth === null
      ? "text-ink-muted"
      : growth > 0
        ? "text-emerald-500"
        : growth < 0
          ? "text-rose-400"
          : "text-ink-secondary";

  const row: Omit<TrendRow, "h"> = {
    slug: t.slug,
    keyword: t.keyword,
    normalizedName: t.normalizedName,
    category: t.category,
    catLabel: trendCategoryLabels[t.category],
    status: t.status,
    statusLabel: st.label,
    statusCls: st.cls,
    statusDot: st.dot,
    statusHint: st.hint,
    confidence: t.confidence,
    confLabel: cf.label,
    confCls: cf.cls,
    confHint: cf.hint,
    why: t.why,
    growth,
    growthText: growth === null ? "—" : `${growth > 0 ? "+" : ""}${growth}%`,
    growthCls,
    baselineText: m.baseline === null ? "—" : String(m.baseline),
    // trendSparkline 已是 0-1，落盘为 0-100 整数
    spark: trendSparkline(t)?.map((v) => Math.round(v * 100)) ?? null,
    seenDays: daysSince(t.firstSeenAt),
    scored,
    tv: scored ? Math.round(trendScore(t)) : 0,
    op: scored ? Math.round(opportunityScore(t)) : 0,
    overall: scored ? overallScore(t) : 0,
    rank,
    oppTypes: Array.from(new Set(t.opportunities.map((o) => o.type)))
      .slice(0, 2)
      .map((k) => ({
        label: opportunityTypeMeta[k].label.replace("机会", ""),
        cls: opportunityTypeMeta[k].cls,
      })),
    oppCount: t.opportunities.length,
    updatedShort: formatDateShort(t.updatedAt),
    sortTrend: scored ? trendScore(t) : -1,
    sortOpp: scored ? opportunityScore(t) : -1,
    sortOverall: scored ? overallScore(t) : -1,
    // JSON 不支持 Infinity：无可比增长时排最后
    sortGrowth: growth ?? -1e9,
    firstSeenAt: t.firstSeenAt,
    hay: [t.keyword, t.normalizedName, t.why, t.intentSummary ?? "", ...(t.relatedQueries ?? [])]
      .join(" ")
      .toLowerCase(),
  };
  return { ...row, h: trendRowHtml(row as TrendRow) };
}

/* ------------------------------- AI 模型榜 ------------------------------- */

type ModelSource = {
  slug: string;
  name: string;
  provider: string;
  modality: string;
  tags?: string[];
  open: boolean;
  license?: string | null;
  context?: number | null;
  maxOutput?: number | null;
  params?: string | null;
  price?: { input?: number | null; output?: number | null; cachedInput?: number | null };
  freeTier?: string | null;
  capability: number;
  knowledgeCutoff?: string | null;
  releasedAt?: string | null;
  desc?: string | null;
  /** 中文简介（enrich:models:zh 生成）；有则列表优先展示 */
  descZh?: string | null;
  strengths?: string[];
  weaknesses?: string[];
  useCases?: string[];
  benchmarks?: { name: string; value: string | number; unit?: string }[];
  sources?: { label: string; url: string }[];
};

function toModelRow(
  m: ModelSource,
  rank: number,
  valueMap: Map<string, number>,
  updatedAt: string,
): ModelRow {
  const priceIn = m.price?.input ?? null;
  const priceOut = m.price?.output ?? null;
  const priceCached = m.price?.cachedInput ?? null;
  const value = valueMap.get(m.slug) ?? 0;
  const score = modelOverallScore(m.capability, value);
  const row: Omit<ModelRow, "h"> = {
    rank,
    slug: m.slug,
    name: m.name,
    provider: m.provider,
    modality: m.modality,
    modalityLabel: modelModalityLabels[m.modality] ?? m.modality,
    tags: m.tags ?? [],
    open: m.open,
    license: m.license ?? null,
    context: m.context ?? null,
    contextText: formatTokens(m.context ?? null),
    maxOutput: m.maxOutput ?? null,
    maxOutputText: formatTokens(m.maxOutput ?? null),
    params: m.params ?? null,
    priceIn,
    priceOut,
    priceCached,
    priceInText: priceText(priceIn),
    priceOutText: priceText(priceOut),
    priceCachedText: priceText(priceCached),
    priceUnit: "USD / 1M tokens",
    freeTier: m.freeTier ?? null,
    hasFree: Boolean(m.freeTier),
    capability: m.capability,
    value,
    score,
    grade: gradeOf(score),
    desc: m.descZh ?? m.desc ?? null,
    descEn: m.desc ?? null,
    knowledgeCutoff: m.knowledgeCutoff ?? null,
    releasedAt: m.releasedAt ?? null,
    updatedShort: formatDateShort(updatedAt),
    hay: [
      m.name,
      m.provider,
      modelModalityLabels[m.modality] ?? m.modality,
      ...(m.tags ?? []),
      m.license ?? "",
      m.params ?? "",
      m.desc ?? "",
      ...(m.useCases ?? []),
    ]
      .join(" ")
      .toLowerCase(),
  };
  return { ...row, h: modelRowHtml(row as ModelRow) };
}

/* ------------------------------- 主流程 ------------------------------- */

async function main() {
  const t0 = Date.now();
  await rm(OUT, { recursive: true, force: true });

  // ---------- AI 工具榜 ----------
  // 榜单顺序 = 综合得分名次：rank 在此固化，筛选、排序、翻页都不会改变它
  const toolRows = getToolsByScore().map((t, i) => toToolRow(t, i + 1));

  const toolDetail = tools.map((t) => ({
    rel: `tools/detail/${t.domain}.json`,
    data: { data: t, derived: toToolRow(t, 0) },
  }));

  const toolFilters = {
    generatedAt: GENERATED_AT,
    categories: allCategories.map((c) => ({
      value: c,
      count: tools.filter((t) => t.categories.includes(c)).length,
    })),
    sorts: [
      { value: "hot", label: "热度" },
      { value: "recent", label: "最新" },
    ],
  };

  // ---------- GitHub 榜 ----------
  const repoRows = getReposByScore().map((r, i) => toRepoRow(r, i + 1));

  const repoDetail = githubRepos.map((r) => ({
    rel: `github/detail/${r.owner}__${r.repo}.json`,
    data: { data: r, derived: toRepoRow(r, 0) },
  }));

  const repoFilters = {
    generatedAt: GENERATED_AT,
    categories: tally(githubRepos.flatMap((r) => r.categories)),
    languages: tally(githubRepos.map((r) => r.language)),
    licenses: tally(githubRepos.map((r) => r.license?.spdx)),
    difficulties: tally(githubRepos.map((r) => repoDifficulty(r))),
  };

  // ---------- 首页聚合 ----------
  const boards = getBoards();
  const home = {
    generatedAt: GENERATED_AT,
    stats: {
      tools: tools.length,
      repos: githubRepos.length,
      trends: trendKeywords.length,
      githubUpdatedAt,
    },
    toolsHot: boards.hot.map((t, i) => toToolRow(t, i + 1)),
    toolsNewest: boards.newest.map((t, i) => toToolRow(t, i + 1)),
    byCategory: boards.byCategory.map((b) => ({
      category: b.category,
      total: b.total,
      items: b.items.map((t, i) => toToolRow(t, i + 1)),
    })),
    githubTop: getGithubTop(8).map(({ repo }, i) => toRepoRow(repo, i + 1)),
  };

  // ---------- AI 趋势词 ----------
  // 名次 = 综合得分 S 降序（同分先比 T，再按 slug 稳定排序），与 apps/web 口径一致
  const orderedTrends = [...trendKeywords].sort((a, b) => {
    const sa = hasEnoughData(a) ? overallScore(a) : -1;
    const sb = hasEnoughData(b) ? overallScore(b) : -1;
    if (sb !== sa) return sb - sa;
    if (sa >= 0) {
      const ta = trendScore(a);
      const tb = trendScore(b);
      if (tb !== ta) return tb - ta;
    }
    return a.slug.localeCompare(b.slug);
  });

  let rankSeq = 0;
  const trendRows = orderedTrends.map((t) =>
    toTrendRow(t, hasEnoughData(t) ? ++rankSeq : 0),
  );
  const trendRowBySlug = new Map(trendRows.map((r) => [r.slug, r]));

  const trendDetail = trendKeywords.map((t) => ({
    rel: `trends/detail/${t.slug}.json`,
    data: { data: t, derived: trendRowBySlug.get(t.slug) ?? toTrendRow(t, 0) },
  }));

  const trendFilters = {
    generatedAt: GENERATED_AT,
    updatedAt: trendsUpdatedAt,
    mode: trendDataMode,
    total: trendRows.length,
    categories: Object.keys(trendCategoryLabels)
      .map((value) => ({ value, count: trendRows.filter((r) => r.category === value).length }))
      .filter((c) => c.count > 0),
    statuses: (["breaking", "gaining", "new", "cooling"] as const)
      .map((value) => ({ value, count: trendRows.filter((r) => r.status === value).length }))
      .filter((s) => s.count > 0),
    confidences: (["high", "medium", "low"] as const)
      .map((value) => ({ value, count: trendRows.filter((r) => r.confidence === value).length }))
      .filter((c) => c.count > 0),
  };

  // ---------- AI 模型榜 ----------
  const modelsRaw = JSON.parse(
    await readFile(path.join(ROOT, "content/models.json"), "utf8"),
  ) as {
    mode: string;
    updatedAt: string;
    source?: string;
    note?: string;
    capabilityNote?: string;
    models: ModelSource[];
  };
  const modelUpdatedAt = modelsRaw.updatedAt;

  // 性价比：能力 ÷ 平均单价，在全库样本内归一（口径见 lib/model-score.ts）
  const valueMap = valueScores(
    modelsRaw.models.map((m) => ({
      slug: m.slug,
      capability: m.capability,
      priceIn: m.price?.input ?? null,
      priceOut: m.price?.output ?? null,
    })),
  );

  // 名次 = 综合得分降序（同分按名称稳定排序）
  const orderedModels = [...modelsRaw.models].sort((a, b) => {
    const sa = modelOverallScore(a.capability, valueMap.get(a.slug) ?? 0);
    const sb = modelOverallScore(b.capability, valueMap.get(b.slug) ?? 0);
    if (sb !== sa) return sb - sa;
    return a.name.localeCompare(b.name);
  });
  const modelRows = orderedModels.map((m, i) => toModelRow(m, i + 1, valueMap, modelUpdatedAt));
  const modelRowBySlug = new Map(modelRows.map((r) => [r.slug, r]));

  const modelDetail = modelsRaw.models.map((m) => ({
    rel: `models/detail/${m.slug}.json`,
    data: {
      data: { ...m, updatedAt: modelUpdatedAt },
      derived: modelRowBySlug.get(m.slug) ?? toModelRow(m, 0, valueMap, modelUpdatedAt),
    },
  }));

  const modelFilters = {
    generatedAt: GENERATED_AT,
    updatedAt: modelUpdatedAt,
    mode: modelsRaw.mode,
    note: modelsRaw.note,
    capabilityNote: modelsRaw.capabilityNote,
    source: modelsRaw.source,
    total: modelRows.length,
    providers: tally(modelsRaw.models.map((m) => m.provider)),
    modalities: tally(modelsRaw.models.map((m) => m.modality)),
    licenses: [
      { value: "open", count: modelRows.filter((r) => r.open).length },
      { value: "closed", count: modelRows.filter((r) => !r.open).length },
    ],
    sorts: [
      { value: "score", label: "综合得分" },
      { value: "capability", label: "能力分" },
      { value: "value", label: "性价比" },
      { value: "price", label: "价格低→高" },
      { value: "context", label: "上下文" },
      { value: "newest", label: "最新发布" },
    ],
  };

  // ---------- 机会榜（跨榜汇编：唯一真源 content/opportunities.json）----------
  const oppFile = JSON.parse(
    await readFile(path.join(ROOT, "content/opportunities.json"), "utf8"),
  ) as OpportunityFile;

  const boardIndex: BoardIndex = { trendRows, toolRows, repoRows, modelRows };
  const oppErrors = validateOpportunities(oppFile, boardIndex);
  if (oppErrors.length) {
    fail(`机会榜未通过原则校验：\n  - ${oppErrors.join("\n  - ")}`);
  }

  const oppRows = buildOpportunityRows(oppFile, oppFile.updatedAt);
  const oppDetails = buildOpportunityDetails(oppFile, oppRows, boardIndex, oppFile.updatedAt);

  const oppPolicy = {
    title: "机会榜收录原则",
    version: oppFile.version,
    intro:
      "六条规则、一个公式、六道闸门。规则不是宣言，而是每次构建都要跑一遍的检查：证据回查不到就中断，一个人做不到就不进榜。分数只表示同类机会之间的相对排序，不预测成功率。",
    rules: [
      {
        id: "00",
        name: "一人公司适配",
        desc: "启动 ≤ 150 美元、稳定期 ≤ 300 美元/月；一个人 6 周内做出能收费的版本；获客只靠搜索、平台市场、社区、开源或内容；付费方是自己刷卡的个体，不走采购流程；单价 ≤ 99 美元/月或一次性 ≤ 199 美元；不需要驻场与定制交付。任何一条不满足，无论多热都不进榜。",
      },
      {
        id: "01",
        name: "跨榜交叉 ≥ 3 源",
        desc: "每条机会至少引用 3 个不同榜单，且至少 1 个趋势词。单榜热度不构成机会：词热不代表能变现，工具流量大不代表还有空间。",
      },
      {
        id: "02",
        name: "证据必须可追溯",
        desc: "每条证据都指向榜单里的具体条目，构建期逐个回查，找不到即中断构建。数字由构建期从榜单实时注入，人工判断里不写会被数据更新打脸的硬数字。",
      },
      {
        id: "03",
        name: "可执行性优先于热度",
        desc: "可执行性既是分数也是门槛：低于 60 不进榜。判分看现有开源件与模型能否承担六成基础工作量，难点是否只在编排、交互与领域判断。",
      },
      {
        id: "04",
        name: "供给缺口是核心判据",
        desc: "只收三种一人公司能吃的缝：价格缺口（对手按席位卖给企业）、本地化缺口（海外已验证、中文没人做或做得差）、形态缺口（通用工具缺一个能交付的闭环）。正面红海只在口径明显不同时收录，并写明「不要做什么」。",
      },
      {
        id: "05",
        name: "写下失效条件",
        desc: "每条机会必须给出风险与应对、每个阶段达不到就停的通过标准、以及效果数字不成立的条件。禁止「潜力巨大」这类无法证伪的表述。",
      },
    ],
    formula: "O = 0.30 × D + 0.25 × G + 0.20 × F + 0.15 × T + 0.10 × M",
    weights: OPPORTUNITY_WEIGHTS,
    grades: [
      { grade: "S", range: "≥ 80" },
      { grade: "A", range: "72 – 79" },
      { grade: "B", range: "64 – 71" },
      { grade: "C", range: "< 64" },
    ],
    gates: [
      "引用榜单 < 3 或缺少趋势词证据 → 构建中断",
      "任一证据主键在榜单中不存在 → 构建中断",
      "需求证据分与所引用趋势词机会分均值偏差 > 20 → 构建中断",
      "可执行性 < 60 或自助变现 < 50 → 构建中断",
      "单人周数 > 6、缺启动预算、缺自分发渠道、第一周动作少于 3 条 → 构建中断",
      "风险少于 2 条、缺阶段通过标准、缺「前 10 个付费用户」路径 → 构建中断",
    ],
    boards: (Object.keys(BOARD_LABELS) as (keyof typeof BOARD_LABELS)[]).map((k) => ({
      key: k,
      label: BOARD_LABELS[k],
    })),
    policyDoc: oppFile.policyDoc ?? "",
    updatedAt: oppFile.updatedAt,
  };

  const oppBatches = summarizeBatches(oppRows);
  const oppIndex = {
    generatedAt: GENERATED_AT,
    updatedAt: oppFile.updatedAt,
    version: oppFile.version,
    policy: oppPolicy,
    total: oppRows.length,
    latestBatch: oppBatches[0]?.batch ?? "",
    batches: oppBatches,
    rows: oppRows,
  };

  // ---------- 写入 ----------
  await write("tools/index.json", toolRows);
  await write("tools/filters.json", toolFilters);
  await write("trends/index.json", trendRows);
  await write("trends/filters.json", trendFilters);
  await writeMany(trendDetail);
  await write("github/index.json", repoRows);
  await write("github/filters.json", repoFilters);
  await write("models/index.json", modelRows);
  await write("models/filters.json", modelFilters);
  await write("opportunity/index.json", oppIndex);
  await writeMany(
    oppDetails.map((d) => ({ rel: `opportunity/detail/${d.slug}.json`, data: d })),
  );
  await write("home.json", home);
  await writeMany(toolDetail);
  await writeMany(repoDetail);
  await writeMany(modelDetail);

  // ---------- 校验（数据不丢的硬闸门）----------
  // 注意：源文件保存全部候选（tools），只有达到收录门槛的 listedTools 才上榜
  if (toolRows.length !== listedTools.length) {
    fail(`tools 条数不一致：产物 ${toolRows.length} ≠ 达标 ${listedTools.length}（源 ${tools.length}）`);
  }
  if (repoRows.length !== githubRepos.length) {
    fail(`github 条数不一致：产物 ${repoRows.length} ≠ 源 ${githubRepos.length}`);
  }
  if (new Set(toolRows.map((r) => r.domain)).size !== listedTools.length) {
    fail("tools 存在重复 domain 主键");
  }
  if (new Set(repoRows.map((r) => r.fullName)).size !== githubRepos.length) {
    fail("github 存在重复 fullName 主键");
  }
  if (toolRows.some((r) => !r.name || !r.domain)) fail("tools 存在缺失必填字段的行");
  if (repoRows.some((r) => !r.fullName || !r.name)) fail("github 存在缺失必填字段的行");
  if (trendRows.length !== trendKeywords.length) {
    fail(`trends 条数不一致：产物 ${trendRows.length} ≠ 源 ${trendKeywords.length}`);
  }
  if (new Set(trendRows.map((r) => r.slug)).size !== trendKeywords.length) {
    fail("trends 存在重复 slug 主键");
  }
  if (trendRows.some((r) => !r.slug || !r.keyword)) fail("trends 存在缺失必填字段的行");
  if (modelRows.length !== modelsRaw.models.length) {
    fail(`models 条数不一致：产物 ${modelRows.length} ≠ 源 ${modelsRaw.models.length}`);
  }
  if (new Set(modelRows.map((r) => r.slug)).size !== modelsRaw.models.length) {
    fail("models 存在重复 slug 主键");
  }
  if (modelRows.some((r) => !r.slug || !r.name || !r.provider)) {
    fail("models 存在缺失必填字段的行");
  }

  // ---------- manifest ----------
  const manifest = {
    version: digest([toolRows, repoRows, home]),
    generatedAt: GENERATED_AT,
    boards: {
      tools: {
        status: "ready",
        count: toolRows.length,
        source: "content/aitools.json",
        updatedAt: toolRows
          .map((r) => r.collectedAt)
          .sort()
          .at(-1) ?? "",
        hash: digest(toolRows),
        indexBytes: bytes(toolRows),
        detailCount: toolDetail.length,
      },
      github: {
        status: "ready",
        count: repoRows.length,
        source: "content/github-web.json",
        updatedAt: githubUpdatedAt,
        hash: digest(repoRows),
        indexBytes: bytes(repoRows),
        detailCount: repoDetail.length,
      },
      trends: {
        status: "ready",
        count: trendRows.length,
        source: "content/trends.json",
        mode: trendDataMode,
        updatedAt: trendsUpdatedAt,
        hash: digest(trendRows),
        indexBytes: bytes(trendRows),
        detailCount: trendDetail.length,
      },
      models: {
        status: "ready",
        count: modelRows.length,
        source: "content/models.json",
        mode: modelsRaw.mode,
        updatedAt: modelUpdatedAt,
        hash: digest(modelRows),
        indexBytes: bytes(modelRows),
        detailCount: modelDetail.length,
      },
      opportunity: {
        status: "ready",
        count: oppRows.length,
        source: "content/opportunities.json",
        updatedAt: oppFile.updatedAt,
        hash: digest(oppRows),
        indexBytes: bytes(oppIndex),
        detailCount: oppDetails.length,
      },
    },
  };
  await write("manifest.json", manifest);

  // ---------- 发布客户端数据（浏览器筛选时抓取，构建期不需要）----------
  const PUB = path.join(ROOT, "apps/site/public/data");
  await mkdir(PUB, { recursive: true });
  await copyFile(path.join(OUT, "tools/index.json"), path.join(PUB, "tools.json"));
  await copyFile(path.join(OUT, "github/index.json"), path.join(PUB, "github.json"));
  await copyFile(path.join(OUT, "trends/index.json"), path.join(PUB, "trends.json"));
  await copyFile(path.join(OUT, "models/index.json"), path.join(PUB, "models.json"));

  // ---------- 报告 ----------
  const ms = Date.now() - t0;
  console.log("\n✓ 产物生成完成\n");
  console.log(
    `  tools   ${String(toolRows.length).padStart(4)} 条   index ${kb(bytes(toolRows))} (gzip ${gz(toolRows)})   详情 ${toolDetail.length} 个`,
  );
  console.log(
    `  github  ${String(repoRows.length).padStart(4)} 条   index ${kb(bytes(repoRows))} (gzip ${gz(repoRows)})   详情 ${repoDetail.length} 个`,
  );
  console.log(
    `  trends  ${String(trendRows.length).padStart(4)} 条   index ${kb(bytes(trendRows))} (gzip ${gz(trendRows)})   详情 ${trendDetail.length} 个   模式 ${trendDataMode}`,
  );
  console.log(
    `  models  ${String(modelRows.length).padStart(4)} 条   index ${kb(bytes(modelRows))} (gzip ${gz(modelRows)})   详情 ${modelDetail.length} 个   模式 ${modelsRaw.mode}`,
  );
  console.log(
    `  opp      ${String(oppRows.length).padStart(4)} 条   批次 ${oppBatches.length} 个（最新 ${oppIndex.latestBatch || "—"}）   证据 ${oppRows.reduce((s, r) => s + r.evidenceCount, 0)} 条   详情 ${oppDetails.length} 个   最高 ${oppRows[0]?.overall ?? 0} 分`,
  );
  console.log(`  home    聚合板块 ${home.byCategory.length} 个分类 / 热度 ${home.toolsHot.length} / 新星 ${home.toolsNewest.length}`);
  console.log(`  version ${manifest.version}   耗时 ${(ms / 1000).toFixed(2)}s`);
  console.log(`  输出    content/dist/\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});