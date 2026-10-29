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
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  tools,
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
import { repoRowHtml, toolRowHtml, trendRowHtml } from "../../apps/site/src/lib/row-html";
import type { RepoRow, ToolRow, TrendRow } from "../../apps/site/src/lib/types";
import { formatCount, formatDateShort } from "../../apps/site/src/lib/format";

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
  const row: Omit<ToolRow, "h"> = {
    rank,
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
    dr: dw.value ?? null,
    drLabel: dw.label ?? null,
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

  // ---------- 写入 ----------
  await write("tools/index.json", toolRows);
  await write("tools/filters.json", toolFilters);
  await write("trends/index.json", trendRows);
  await write("trends/filters.json", trendFilters);
  await writeMany(trendDetail);
  await write("github/index.json", repoRows);
  await write("github/filters.json", repoFilters);
  await write("home.json", home);
  await writeMany(toolDetail);
  await writeMany(repoDetail);

  // ---------- 校验（数据不丢的硬闸门）----------
  if (toolRows.length !== tools.length) {
    fail(`tools 条数不一致：产物 ${toolRows.length} ≠ 源 ${tools.length}`);
  }
  if (repoRows.length !== githubRepos.length) {
    fail(`github 条数不一致：产物 ${repoRows.length} ≠ 源 ${githubRepos.length}`);
  }
  if (new Set(toolRows.map((r) => r.domain)).size !== tools.length) {
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
    },
  };
  await write("manifest.json", manifest);

  // ---------- 发布客户端数据（浏览器筛选时抓取，构建期不需要）----------
  const PUB = path.join(ROOT, "apps/site/public/data");
  await mkdir(PUB, { recursive: true });
  await copyFile(path.join(OUT, "tools/index.json"), path.join(PUB, "tools.json"));
  await copyFile(path.join(OUT, "github/index.json"), path.join(PUB, "github.json"));
  await copyFile(path.join(OUT, "trends/index.json"), path.join(PUB, "trends.json"));

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
  console.log(`  home    聚合板块 ${home.byCategory.length} 个分类 / 热度 ${home.toolsHot.length} / 新星 ${home.toolsNewest.length}`);
  console.log(`  version ${manifest.version}   耗时 ${(ms / 1000).toFixed(2)}s`);
  console.log(`  输出    content/dist/\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});