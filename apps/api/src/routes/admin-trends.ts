/**
 * 后台「趋势榜」API：采集、审核、发布。
 *
 * 与工具榜的分工一致——Worker 跑不了采集脚本，这里只做编排：
 *   1. 点「拉取」→ 触发 fetch-trends.yml，采集结果写进仓库的候选池；
 *   2. 读候选池，逐词查看数据、决定收还是拒；
 *   3. 点「发布」前先算一遍位次变化，让人知道会挤掉谁、谁要往下掉。
 *
 * 数据全部来自 D1：候选池读 board_items，位次快照读 board_reports:trends-meta。
 * 鉴权与 CSRF 由 admin.ts 的 `admin.use("*")` 统一兜住。
 */
import { Hono, type Context } from "hono";
import type { AITrend, TrendRankRow } from "@horizons/shared";
import {
  MAX_BOARD_SIZE,
  auditTrendFields,
  diffRankRows,
  hasEnoughTrendData,
  summarizeQuality,
  type FieldIssue,
  opportunityScore,
  overallScore,
  rankRows,
  toRankRow,
  trendScore,
  trimBoard,
} from "@horizons/shared";
import type { Env } from "../env";
import {
  dispatchWorkflow,
  fetchRun,
  ghConfig,
  mapStatus,
  missingSecrets,
  type WorkflowRun,
} from "../lib/github";
import { readBoardStats, type BoardStats } from "../lib/board-stats";
import { listWorkspace, setItemsStatus } from "../lib/board-items";
import { readReport } from "../lib/reports";
import { currentVersion } from "../lib/versions";

const trends = new Hono<{ Bindings: Env }>();
type Ctx = Context<{ Bindings: Env }>;

/** 采集期快照（当前榜位次 + 上次采集/发布摘要）在 board_reports 里的 key */
const META_KEY = "trends-meta";
const FETCH_WORKFLOW = "fetch-trends.yml";
const ENRICH_WORKFLOW = "enrich-trends.yml";
const REVERT_WORKFLOW = "revert-trends.yml";
const PUBLISH_WORKFLOW = "publish-trends.yml";

interface StagingFile {
  updatedAt: string;
  runAt: string;
  items: AITrend[];
  rejected: string[];
  board?: { updatedAt: string; rows: TrendRankRow[] };
  lastRun?: { ok: number; failed: number; total: number; budget: number; geo: string };
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
    trimmed?: number;
    /** 上一次真正发布时「谁进榜 / 谁掉了名次」，供发布后回看 */
    top: { keyword: string; slug: string; from: number | null; to: number | null; delta: number }[];
  };
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  params: string;
  gh_run_id: number | null;
  run_url: string | null;
  summary: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/* -------------------------------- 任务记录 -------------------------------- */

async function refreshJob(env: Env, cfg: ReturnType<typeof ghConfig>, row: JobRow): Promise<JobRow> {
  if (!cfg || !row.gh_run_id) return row;
  if (["success", "failure", "cancelled"].includes(row.status)) return row;

  const run = await fetchRun(cfg, row.gh_run_id);
  if (!run) return row;
  const status = mapStatus(run, row.status);
  if (status === row.status) return row;

  const now = Date.now();
  await env.DB.prepare("UPDATE trend_jobs SET status = ?, run_url = ?, updated_at = ? WHERE id = ?")
    .bind(status, run.html_url ?? row.run_url, now, row.id)
    .run();
  return { ...row, status, run_url: run.html_url ?? row.run_url, updated_at: now };
}

async function listJobs(env: Env, limit: number): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM trend_jobs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<JobRow>();
  const rows = results ?? [];
  const cfg = ghConfig(env);
  return Promise.all(rows.map((r) => refreshJob(env, cfg, r).catch(() => r)));
}

/**
 * 正在跑（queued/running）的同类任务。
 *
 * 只回看最近 5 条：再往前的要么已结束，要么是幽灵记录（workflow 被手动删掉），
 * 拿它拦派发会让后台永久卡住。状态一律用 refreshJob 现查 GitHub，不看库里的旧值。
 */
async function findRunningJob(env: Env, kind: string): Promise<JobRow | null> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM trend_jobs WHERE kind = ? ORDER BY created_at DESC LIMIT 5",
    )
      .bind(kind)
      .all<JobRow>();
    const cfg = ghConfig(env);
    for (const row of results ?? []) {
      const fresh = await refreshJob(env, cfg, row).catch(() => row);
      if (fresh.status === "queued" || fresh.status === "running") return fresh;
    }
  } catch (e) {
    // 表缺失（忘跑 0009）不该把所有派发都拦死，只是失去防重能力
    console.warn("[trends] 查询运行中任务失败", e);
  }
  return null;
}

/** 任务参数里记录的 slugs，用来算「哪些词正在被处理」 */
function jobSlugs(row: JobRow): string[] {
  try {
    const parsed = JSON.parse(row.params) as { slugs?: unknown };
    return Array.isArray(parsed.slugs)
      ? parsed.slugs.filter((s): s is string => typeof s === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * 先落一条任务记录再 dispatch，这样 workflow 里的 job_id 能和后台对上。
 * 表缺失（忘跑 0009 迁移）不该挡住 dispatch，写库失败只记日志。
 */
async function insertJob(
  env: Env,
  kind: string,
  params: Record<string, unknown>,
  run: WorkflowRun | null,
  error: string | null,
  id: string = crypto.randomUUID(),
): Promise<string> {
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO trend_jobs (id, kind, status, params, gh_run_id, run_url, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        kind,
        error ? "failure" : mapStatus(run, "queued"),
        JSON.stringify(params),
        run?.id ?? null,
        run?.html_url ?? null,
        error,
        now,
        now,
      )
      .run();
  } catch (e) {
    console.warn("[trends] 写任务表失败（0009 迁移是否已应用？）", e);
  }
  return id;
}

/** dispatch 后回写 run id；偶发拿不到 run（GitHub 侧延迟）就保持排队状态 */
async function updateJobRun(env: Env, id: string, run: WorkflowRun | null): Promise<void> {
  try {
    await env.DB.prepare(
      "UPDATE trend_jobs SET status = ?, gh_run_id = ?, run_url = ?, updated_at = ? WHERE id = ?",
    )
      .bind(mapStatus(run, "queued"), run?.id ?? null, run?.html_url ?? null, Date.now(), id)
      .run();
  } catch (e) {
    console.warn("[trends] 更新任务记录失败", e);
  }
}

async function failJob(env: Env, id: string, error: string): Promise<void> {
  try {
    await env.DB.prepare("UPDATE trend_jobs SET status = 'failure', error = ?, updated_at = ? WHERE id = ?")
      .bind(error, Date.now(), id)
      .run();
  } catch (e) {
    console.warn("[trends] 标记任务失败时写库出错", e);
  }
}

/* --------------------------------- 计算 --------------------------------- */

interface CandidateView {
  slug: string;
  keyword: string;
  /** 趋势分：只由曲线算出，富化前后一致 */
  trend: number;
  /** 机会分来自 LLM，未富化时为 null（不是 0） */
  opportunity: number | null;
  /** 综合分，未富化时为 null */
  overall: number | null;
  peak: number;
  lastValue: number;
  growth7: number | null;
  /** 曲线点数，<14 视为数据不足 */
  dataPoints: number;
  /** pending=等富化；failed=富化失败可重试；null=已富化 */
  enrichStatus: "pending" | "failed" | null;
  /** 能否点富化：未富化且数据点达标 */
  enrichable: boolean;
  /** 当前是否已在榜 */
  inBoard: boolean;
  /**
   * 已富化：合并进榜单后的预计名次（按综合分）。
   * 未富化：在待富化池内按趋势分的参考名次——不含机会分，和最终名次会差。
   */
  estimatedRank: number | null;
  /** 名次依据，前端据此标注「参考名次」还是「预计名次」 */
  rankBasis: "overall" | "trend";
  /** 内容体检：已富化的词才有意义，未富化返回空数组 */
  issues: FieldIssue[];
  rejected: boolean;
  firstSeenAt: string;
  /**
   * 刷新过的话带上上一版摘要：新版可能比旧版更差（字段变少、机会变空），
   * 列表里先给个概览，完整旧内容在 /staging/:slug 里。
   */
  previous?: {
    at: string;
    why: string;
    opportunities: number;
    actions: number;
    relatedQueries: number;
  };
}

function peakOf(t: AITrend): number {
  return Math.max(...(t.series?.values ?? [0]), 0);
}

/**
 * 近 7 天相对基线的涨幅。
 * 口径与站点 trendMetrics 一致：基线 = 最近 7 点之前的均值，
 * 差值除以基线。候选词可能点数不足，所以全程按可空处理。
 */
function growth7Of(t: AITrend): number | null {
  const values = t.series?.values ?? [];
  if (values.length < 2) return null;
  const cut = Math.max(1, values.length - 7);
  const before = values.slice(0, cut);
  const base = before.reduce((s, v) => s + v, 0) / before.length;
  if (!(base > 0)) return null;
  const recent = values.slice(cut);
  const recentMean = recent.reduce((s, v) => s + v, 0) / recent.length;
  return Math.round(((recentMean - base) / base) * 1000) / 10;
}

/** board_reports:trends-meta 的结构（采集/发布脚本写入） */
type TrendsMeta = {
  updatedAt?: string;
  runAt?: string;
  board?: NonNullable<StagingFile["board"]>;
  lastRun?: NonNullable<StagingFile["lastRun"]>;
  lastPublish?: NonNullable<StagingFile["lastPublish"]>;
};

/**
 * 候选池与发布期快照都来自 D1：
 *   - 候选 / 拒绝名单 → board_items
 *   - 当前榜位次 / 上次采集 / 上次发布 → board_reports:trends-meta
 * 位次快照是采集时用完整 series 算出来的，库里没有可还原的原料，
 * 所以脚本随文件一起存一份，后台只读不改。
 */
async function loadStaging(env: Env): Promise<StagingFile | null> {
  const [ws, meta] = await Promise.all([
    listWorkspace<AITrend>(env.DB, "trends"),
    readReport<TrendsMeta>(env.DB, META_KEY),
  ]);

  if (!meta && ws.items.length === 0 && ws.rejected.length === 0) return null;

  const m = meta?.data;
  return {
    updatedAt: ws.updatedAt ?? m?.updatedAt ?? new Date(0).toISOString(),
    runAt: m?.runAt ?? ws.updatedAt ?? new Date(0).toISOString(),
    items: ws.items,
    rejected: ws.rejected,
    ...(m?.board ? { board: m.board } : {}),
    ...(m?.lastRun ? { lastRun: m.lastRun } : {}),
    ...(m?.lastPublish ? { lastPublish: m.lastPublish } : {}),
  };
}

function buildView(file: StagingFile): {
  candidates: CandidateView[];
  report: ReturnType<typeof diffRankRows>;
  boardRank: Map<string, number>;
  /** 合并后会因超上限被淘汰的词数（含别名），和发布脚本同一套规则 */
  trimmed: number;
  /** 三段计数：已富化可发布 / 等富化 / 数据不足被挡 */
  stats: { ready: number; pending: number; blocked: number };
  /** 已富化候选的内容体检汇总 */
  quality: ReturnType<typeof summarizeQuality>;
  /**
   * 候选池里有没有可用的榜单基线。
   *
   * 基线为空时「新进榜 / 掉名次 / 在榜刷新」全算不出来——会把 20 个其实在榜的词
   * 全说成「新进榜」。这种情况不能拿数字糊弄人，调用方要显式降级。
   */
  baseline: boolean;
} {
  const rejected = new Set(file.rejected.map((k) => k.toLowerCase()));
  const boardRows = file.board?.rows ?? [];
  const boardRank = rankRows(boardRows);

  const kept = boardRows.filter((r) => !rejected.has(r.keyword.toLowerCase()));
  // 只有已富化的候选才进「发布后会怎样」的计算：
  // 未富化的内容字段是占位，混进去会把名次全算歪
  const ready = file.items.filter((t) => !rejected.has(t.keyword.toLowerCase()) && !t.enrichStatus);
  const afterFull = [...kept, ...ready.map(toRankRow)];
  const { kept: afterRows, dropped } = trimBoard(afterFull, (r) => r);
  const afterRank = rankRows(afterRows);
  const report = diffRankRows(boardRows, afterRows);

  const boardBySlug = new Map(boardRows.map((r) => [r.slug, r]));
  const boardByKeyword = new Map(boardRows.map((r) => [r.keyword.toLowerCase(), r]));

  // 未富化池内按趋势分排个参考名次——机会分还没有，不能拿综合分排
  const pendingRank = new Map<string, number>();
  [...file.items]
    .filter((t) => Boolean(t.enrichStatus))
    .sort((a, b) => trendScore(b) - trendScore(a) || a.slug.localeCompare(b.slug))
    .forEach((t, i) => pendingRank.set(t.slug, i + 1));

  const candidates: CandidateView[] = file.items.map((t) => {
    const kw = t.keyword.toLowerCase();
    const existing = boardBySlug.get(t.slug) ?? boardByKeyword.get(kw);
    const enriched = !t.enrichStatus;
    return {
      slug: t.slug,
      keyword: t.keyword,
      trend: trendScore(t),
      opportunity: enriched ? opportunityScore(t) : null,
      overall: enriched ? overallScore(t) : null,
      peak: peakOf(t),
      lastValue: t.series?.values?.[t.series.values.length - 1] ?? 0,
      growth7: growth7Of(t),
      dataPoints: t.series?.values?.length ?? 0,
      enrichStatus: t.enrichStatus ?? null,
      // 在榜词勾选=刷新内容，所以已富化的词只要还在榜也允许勾
      enrichable: !rejected.has(kw) && hasEnoughTrendData(t) && (!enriched || Boolean(existing)),
      inBoard: Boolean(existing),
      // afterRows 里已包含榜单原有词，所以直接查合并后的名次表即可
      estimatedRank: rejected.has(kw)
        ? null
        : enriched
          ? (afterRank.get(t.slug) ?? null)
          : (pendingRank.get(t.slug) ?? null),
      rankBasis: enriched ? "overall" : "trend",
      issues: enriched ? auditTrendFields(t) : [],
      rejected: rejected.has(kw),
      firstSeenAt: t.firstSeenAt,
      ...(t.previousSnapshot
        ? {
            previous: {
              at: t.previousSnapshot.at,
              why: t.previousSnapshot.why,
              opportunities: t.previousSnapshot.opportunities.length,
              actions: t.previousSnapshot.actions.length,
              relatedQueries: t.previousSnapshot.relatedQueries?.length ?? 0,
            },
          }
        : {}),
    };
  });

  const stats = {
    ready: candidates.filter((c) => c.enrichStatus === null && !c.rejected).length,
    pending: candidates.filter((c) => c.enrichStatus !== null && c.enrichable && !c.rejected).length,
    blocked: candidates.filter((c) => c.enrichStatus !== null && !c.enrichable && !c.rejected).length,
  };

  // 体检只算能发布的词：未富化的字段是占位，算进去等于自欺
  return {
    candidates,
    report,
    boardRank,
    trimmed: dropped.length,
    stats,
    quality: summarizeQuality(ready),
    baseline: boardRows.length > 0,
  };
}

/* ---------------------------------- 路由 ---------------------------------- */

/** 概览：候选数、上次采集/发布结果、最近任务 */
trends.get("/overview", async (c) => {
  // configured 只表示「能派发流水线」，数据本身不需要 GitHub 凭据
  const configured = Boolean(ghConfig(c.env));
  const missing = missingSecrets(c.env);
  const jobs = await listJobs(c.env, 5);

  try {
    const [file, boardStats] = await Promise.all([
      loadStaging(c.env),
      // 在榜数字查库；失败只影响这一个数字，不能拖垮整页
      readBoardStats(c.env.DB).catch(() => ({}) as BoardStats),
    ]);
    const board = boardStats.trends ?? null;
    if (!file) {
      return c.json({ configured, missing, staging: null, jobs, empty: true, board });
    }
    const { candidates, report, stats, quality, baseline } = buildView(file);
    /*
     * 基线缺失时按顺序回退：候选池快照 → 上次发布 → board_stats。
     * 三者都空（recordBoardStat 失败只告警，可能真没写进去）就直接数 board_listed，
     * 「线上榜单」这个数字宁可多查一次库，也不能显示成 0。
     */
    let boardRows = file.board?.rows.length || file.lastPublish?.boardAfter || board?.total || 0;
    if (boardRows === 0) {
      const version = await currentVersion(c.env.DB);
      const counted = version
        ? await c.env.DB.prepare(
            "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = 'trends'",
          )
            .bind(version)
            .first<{ n: number }>()
        : null;
      boardRows = counted?.n ?? 0;
    }
    return c.json({
      configured,
      missing,
      jobs,
      board,
      boardLimit: MAX_BOARD_SIZE,
      staging: {
        updatedAt: file.updatedAt,
        runAt: file.runAt,
        candidates: candidates.length,
        // 三段：可发布 / 等富化 / 数据不足被挡
        ready: stats.ready,
        pending: stats.pending,
        blocked: stats.blocked,
        quality,
        rejected: file.rejected.length,
        /*
         * boardRows 见上面：按「有内容才算」，0 会一路回退到 board_listed 实表。
         * 时间跟着数量走 —— 数字来自正式榜统计时，就别再说这是「计分快照时间」。
         */
        boardRows,
        boardUpdatedAt: file.board?.rows.length
          ? file.board.updatedAt
          : (file.lastPublish?.at ?? board?.updatedAt ?? null),
        baseline,
        lastRun: file.lastRun ?? null,
        lastPublish: file.lastPublish ?? null,
        // 概览只给数字，明细走 /staging
        entered: report.entered.length,
        significant: report.significant.length,
      },
    });
  } catch (e) {
    return c.json({
      configured,
      missing,
      staging: null,
      jobs,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/** 候选池明细：每词分数、是否在榜、预计名次 */
trends.get("/staging", async (c) => {
  const staging = await loadStaging(c.env);
  if (!staging) {
    // 库里没有数据就是没采集过，直接给空态，不再要求 GitHub 凭据
    return c.json({ empty: true, candidates: [], report: null });
  }

  const { candidates, report, stats, quality, baseline } = buildView(staging);
  return c.json({
    updatedAt: staging.updatedAt,
    runAt: staging.runAt,
    lastRun: staging.lastRun ?? null,
    lastPublish: staging.lastPublish ?? null,
    candidates,
    stats,
    quality,
    baseline,
    report: {
      boardBefore: report.boardBefore,
      boardAfter: report.boardAfter,
      entered: report.entered.length,
      exited: report.exited.length,
      up: report.ups.length,
      down: report.downs.length,
      significant: report.significant.length,
      shifted: report.shifted,
    },
  });
});

/** 单个候选词的全部数据 */
trends.get("/staging/:slug", async (c) => {
  const slug = c.req.param("slug");
  const staging = await loadStaging(c.env);
  if (!staging) return c.json({ error: "staging_empty" }, 404);

  const item = staging.items.find((t) => t.slug === slug);
  if (!item) return c.json({ error: "not_found" }, 404);

  const { candidates } = buildView(staging);
  const view = candidates.find((x) => x.slug === slug) ?? null;
  const boardRow = staging.board?.rows.find((r) => r.slug === slug) ?? null;

  return c.json({ item, view, boardRow });
});

/** 收录 / 拒绝：只改 board_items.status，采集脚本读库里的黑名单 */
trends.post("/staging/:slug/reject", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<{ rejected?: boolean }>().catch(() => ({}) as { rejected?: boolean });
  const wantReject = body.rejected !== false;

  // 库里的主键是 keyword（黑名单口径），路由参数是 slug，先换回来
  const ws = await listWorkspace<AITrend>(c.env.DB, "trends");
  const key = (ws.items.find((t) => t.slug === slug)?.keyword ?? slug).toLowerCase();
  const ok = await setItemsStatus(c.env.DB, "trends", [key], wantReject ? "rejected" : "candidate");
  if (!ok) return c.json({ error: "not_found" }, 404);

  return c.json({ ok: true, slug, rejected: wantReject });
});

/** 发布预览：谁进榜、谁掉名次。所有变动都按「显著 / 仅顺延」分好组 */
trends.get("/publish/preview", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured" }, 400);

  const file = await loadStaging(c.env);
  if (!file) return c.json({ empty: true, preview: null });

  const { candidates, report, trimmed, baseline } = buildView(file);
  const active = candidates.filter((x) => !x.rejected);

  return c.json({
    preview: {
      updatedAt: file.updatedAt,
      boardLimit: MAX_BOARD_SIZE,
      // 基线缺失时「新进榜 / 在榜刷新 / 掉名次」都不可信，前端要显式提示
      baseline,
      trimmed,
      incoming: active.length,
      inBoardRefresh: active.filter((x) => x.inBoard).length,
      boardBefore: report.boardBefore,
      boardAfter: report.boardAfter,
      entered: report.entered.length,
      exited: report.exited.length,
      up: report.ups.length,
      down: report.downs.length,
      significant: report.significant.length,
      shifted: report.shifted,
      /** 前 50 名的变动，发布前最需要看的就是这个 */
      top: report.top.slice(0, 40),
      named: report.significant.slice(0, 60),
      candidates: active,
      /** 发布后候选池会被清空，这里带上一次发布的记录，方便回答「刚才动了谁」 */
      lastPublish: file.lastPublish ?? null,
    },
  });
});

/* -------------------------------- 线上榜单 -------------------------------- */

interface ListedTrendRow {
  item_key: string;
  rank: number;
  name: string;
  variant_of: string | null;
  slug: string | null;
  category: string | null;
  confidence: string | null;
  trend_parts: string | null;
  opp_parts: string | null;
  first_seen: string | null;
  last_seen: string | null;
  updated_at: string | null;
}

/**
 * card 里只剩 trendParts / oppParts（发布脚本把 series 剥掉了），
 * 而评分函数恰好只用这两块，所以不用把曲线拉过来也能算分。
 */
function scoresFromParts(trendParts: string | null, oppParts: string | null): {
  trend: number;
  opportunity: number;
  overall: number;
} {
  const parseParts = (raw: string | null): Record<string, number> => {
    if (!raw) return {};
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  };
  const fake = {
    trendParts: parseParts(trendParts),
    oppParts: parseParts(oppParts),
  } as unknown as AITrend;
  return {
    trend: trendScore(fake),
    opportunity: opportunityScore(fake),
    overall: overallScore(fake),
  };
}

/**
 * 线上趋势词（当前版本），给「手动更新」挑词用。
 *
 * 与工具榜 /listed 同一思路：只取列表要显示的字段，不拉整张卡片。
 * 别名行也一并返回（variant_of 非空、rank 继承代表词），
 * 因为它们各自有独立页面，内容同样需要更新。
 */
trends.get("/listed", async (c) => {
  const version = await currentVersion(c.env.DB);
  if (!version) {
    return c.json({ version: "", total: 0, items: [], refreshPending: 0, detail: "库里还没有发布过趋势榜" });
  }

  const [{ results }, ws] = await Promise.all([
    c.env.DB.prepare(
      `SELECT item_key, rank, name, variant_of,
              json_extract(card,'$.slug') AS slug,
              json_extract(card,'$.category') AS category,
              json_extract(card,'$.confidence') AS confidence,
              json_extract(card,'$.trendParts') AS trend_parts,
              json_extract(card,'$.oppParts') AS opp_parts,
              json_extract(card,'$.firstSeenAt') AS first_seen,
              json_extract(card,'$.lastSeenAt') AS last_seen,
              json_extract(card,'$.updatedAt') AS updated_at
       FROM board_listed
       WHERE version = ? AND board = 'trends'
       ORDER BY rank ASC, variant_of IS NOT NULL, name ASC`,
    )
      .bind(version)
      .all<ListedTrendRow>(),
    listWorkspace<AITrend>(c.env.DB, "trends"),
  ]);

  // 候选池状态：同一个词已经在队列里（更新中/待发布）就标出来，避免重复提交
  const staging = new Map<string, string>();
  for (const t of ws.items) {
    const stage = (t as unknown as { stage?: string }).stage;
    if (stage) staging.set(t.slug, stage);
  }
  const items = (results ?? []).map((r) => {
    const slug = r.slug ?? r.item_key;
    return {
      slug,
      keyword: r.name,
      rank: r.rank,
      category: r.category,
      confidence: r.confidence,
      /** 非空表示这是别名，rank 继承代表词，不占名次 */
      variantOf: r.variant_of,
      firstSeenAt: r.first_seen,
      /** 上次真正采到数据的日期：判断「该不该更新」就看它 */
      lastSeenAt: r.last_seen ?? r.updated_at,
      staging: staging.get(slug) ?? null,
      scores: scoresFromParts(r.trend_parts, r.opp_parts),
    };
  });

  /*
   * 「候选池里待发布的线上词」按「榜上有 + 已富化」数：
   * 候选池不记 kind（AITrend 没有 origin 字段），拿 kind==='refresh' 数会永远是 0，
   * 而这个词是不是线上词，用榜上 slug 判断反而更准。
   */
  const onBoard = new Set(items.map((i) => i.slug));
  const refreshPending = ws.items.filter((t) => {
    const stage = (t as unknown as { stage?: string }).stage;
    return onBoard.has(t.slug) && (stage === "enriched" || stage === "publish_failed");
  }).length;

  return c.json({ version, total: items.length, refreshPending, items });
});

/* -------------------------------- 触发流水线 -------------------------------- */

/** 拉取新词：采集结果只进候选池，线上榜单不动 */
trends.post("/fetch", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ budget?: number; geo?: string }>()
    .catch(() => ({}) as { budget?: number; geo?: string });
  const budget = Math.min(Math.max(Number(body.budget ?? 80) || 80, 10), 200);
  // Google Trends 的 geo 只认两位国家码，传空字符串才是「全球」
  const rawGeo = String(body.geo ?? "US").trim();
  const geo = /^[a-z]{2}$/i.test(rawGeo) ? rawGeo.toUpperCase() : "US";

  const jobId = await insertJob(c.env, "fetch", { budget, geo }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, FETCH_WORKFLOW, {
      budget: String(budget),
      geo,
      job_id: jobId,
    });
    await updateJobRun(c.env, jobId, run);
    return c.json({ ok: true, run, jobId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(c.env, jobId, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/**
 * 单批重采上限。
 *
 * 定向重采一个词 = 一次 Google Trends 曲线 + 一次 LLM 富化，约 40~60 秒；
 * 40 个词约 40 分钟，fetch workflow 的 240 分钟窗口留足重试余量。
 * 超限必须报错而不是截断——被静默丢掉的那部分永远不会跑，后台却显示已提交。
 */
const MAX_REFRESH_SLUGS = 40;

/**
 * 更新线上词：只重采选中的这几个词，曲线和内容一起刷新。
 *
 * 结果照例只进候选池，线上榜单不动——要上线还得去「发布」点一次，
 * 这样更新坏了能拦下来，不会把线上词条换成更差的版本。
 */
trends.post("/refresh", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ slugs?: unknown }>()
    .catch(() => ({}) as { slugs?: unknown });
  const raw = Array.isArray(body.slugs)
    ? body.slugs.filter((s): s is string => typeof s === "string")
    : [];
  // slug 会拼进 workflow input，只允许小写字母数字与连字符
  const slugs = [...new Set(raw.map((s) => s.trim().toLowerCase()))].filter((s) =>
    /^[a-z0-9-]+$/.test(s),
  );

  if (slugs.length === 0) return c.json({ error: "empty_slugs", detail: "没有选中任何词" }, 400);
  if (slugs.length > MAX_REFRESH_SLUGS) {
    return c.json(
      {
        error: "too_many_slugs",
        max: MAX_REFRESH_SLUGS,
        received: slugs.length,
        detail: `单批最多 ${MAX_REFRESH_SLUGS} 个，请分 ${Math.ceil(slugs.length / MAX_REFRESH_SLUGS)} 批提交`,
      },
      400,
    );
  }

  // 只认当前线上榜单里的词：slug 拿错不该白跑一次 Actions
  const version = await currentVersion(c.env.DB);
  if (!version) return c.json({ error: "no_current_version", detail: "线上还没有趋势榜" }, 409);

  const { results } = await c.env.DB.prepare(
    "SELECT json_extract(card,'$.slug') AS slug FROM board_listed WHERE version = ? AND board = 'trends'",
  )
    .bind(version)
    .all<{ slug: string | null }>();
  const onBoard = new Set(
    (results ?? []).map((r) => r.slug).filter((s): s is string => typeof s === "string"),
  );
  const valid = slugs.filter((s) => onBoard.has(s));
  const skipped = slugs.filter((s) => !onBoard.has(s));
  if (valid.length === 0) {
    return c.json({ error: "not_listed", detail: "选中的词都不在当前线上榜单", skipped }, 404);
  }

  // 防重：正在跑的重叠部分不再派发，否则白烧一遍 Trends 配额与 token
  const running = await findRunningJob(c.env, "refresh");
  const busy = new Set(running ? jobSlugs(running) : []);
  const todo = valid.filter((s) => !busy.has(s));
  if (todo.length === 0) {
    return c.json(
      {
        error: "already_refreshing",
        detail: "这些词正在更新中，等这一批跑完再试",
        runUrl: running?.run_url ?? null,
      },
      409,
    );
  }

  const jobId = await insertJob(c.env, "refresh", { slugs: todo, count: todo.length }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, FETCH_WORKFLOW, {
      budget: String(todo.length),
      geo: "US",
      job_id: jobId,
      // 有 slugs 时 workflow 会跳过发现链路，直接重采这几个词并顺带富化
      slugs: todo.join(","),
    });
    await updateJobRun(c.env, jobId, run);
    return c.json({ ok: true, run, jobId, count: todo.length, skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(c.env, jobId, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/**
 * 富化选中：只给人工挑中的候选补内容。
 * 采集阶段已存好曲线与证据，这里只花 LLM 的钱；数据点不足 14 的词一律拒绝。
 */
trends.post("/enrich", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ slugs?: unknown }>()
    .catch(() => ({}) as { slugs?: unknown });

  const file = await loadStaging(c.env);
  if (!file) return c.json({ error: "staging_empty" }, 400);

  const rejected = new Set(file.rejected.map((k) => k.toLowerCase()));
  // 在榜词也要留有富化入口：它进候选池时没有 enrichStatus（未勾选=不刷新内容），
  // 但用户想更新内容时必须能点。是否在榜以采集时写下的 board 快照为准。
  const inBoard = new Set((file.board?.rows ?? []).map((r) => r.keyword.toLowerCase()));
  const eligible = new Map(
    file.items
      .filter((t) => {
        if (rejected.has(t.keyword.toLowerCase()) || !hasEnoughTrendData(t)) return false;
        return Boolean(t.enrichStatus) || inBoard.has(t.keyword.toLowerCase());
      })
      .map((t) => [t.slug, t]),
  );
  // 不传 slugs（脚本直跑）时只补未富化的词：在榜刷新必须显式勾选，
  // 否则一次「全部富化」就把整个榜单重刷一遍
  const pendingOnly = new Set(file.items.filter((t) => t.enrichStatus).map((t) => t.slug));

  const requested = Array.isArray(body.slugs)
    ? body.slugs.filter((s): s is string => typeof s === "string")
    : null;
  // slug 只允许小写字母数字与连字符：它会拼进 workflow input，不能带任何符号
  const slugs = (requested ?? [...pendingOnly]).filter(
    (s) => /^[a-z0-9-]+$/.test(s) && eligible.has(s),
  );

  if (slugs.length === 0) {
    return c.json(
      { error: "nothing_to_enrich", detail: "没有可富化的词（需未富化且数据点 ≥14）" },
      400,
    );
  }
  if (slugs.length > 60) {
    return c.json({ error: "too_many", detail: "单次最多 60 个，分批富化更容易定位失败" }, 400);
  }

  /*
   * 防重：富化按词计费，两个标签页（或手快连点）会重复派发同一批，
   * 白烧一遍 LLM。前端按钮锁只是第一道，后端必须自己拦。
   * 只跳过已被占住的词，剩下的照常派发 —— 补选新词不该被旧任务挡住。
   */
  const running = await findRunningJob(c.env, "enrich");
  const busy = new Set(running ? jobSlugs(running) : []);
  const todo = slugs.filter((s) => !busy.has(s));
  if (todo.length === 0) {
    return c.json(
      {
        error: "all_enriching",
        detail: `这 ${slugs.length} 个词已经在富化中，完成后再试`,
        runUrl: running?.run_url ?? null,
      },
      409,
    );
  }

  const jobId = await insertJob(c.env, "enrich", { count: todo.length, slugs: todo }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, ENRICH_WORKFLOW, {
      slugs: todo.join(","),
      job_id: jobId,
    });
    await updateJobRun(c.env, jobId, run);
    return c.json({ ok: true, run, jobId, count: todo.length, skipped: slugs.length - todo.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(c.env, jobId, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/**
 * 回滚上一版：重刷后的内容更差时退回旧内容。
 * 只覆盖内容字段，曲线与趋势分仍用这一轮的新数据。
 */
trends.post("/revert", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ slugs?: unknown }>()
    .catch(() => ({}) as { slugs?: unknown });
  if (!Array.isArray(body.slugs)) {
    return c.json({ error: "slugs_required", detail: "回滚必须明确指定词，不做整池回滚" }, 400);
  }

  const file = await loadStaging(c.env);
  if (!file) return c.json({ error: "staging_empty" }, 400);

  const withSnapshot = new Set(file.items.filter((t) => t.previousSnapshot).map((t) => t.slug));
  const slugs = body.slugs
    .filter((s): s is string => typeof s === "string")
    // slug 只允许小写字母数字与连字符：它会拼进 workflow input
    .filter((s) => /^[a-z0-9-]+$/.test(s) && withSnapshot.has(s));

  if (slugs.length === 0) {
    return c.json({ error: "nothing_to_revert", detail: "所选词没有上一版快照" }, 400);
  }
  if (slugs.length > 60) {
    return c.json({ error: "too_many", detail: "单次最多 60 个" }, 400);
  }

  const jobId = await insertJob(c.env, "revert", { count: slugs.length }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, REVERT_WORKFLOW, {
      slugs: slugs.join(","),
      job_id: jobId,
    });
    await updateJobRun(c.env, jobId, run);
    return c.json({ ok: true, run, jobId, count: slugs.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(c.env, jobId, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/** 发布：把候选池合并进榜单，随即触发站点重建 */
trends.post("/publish", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured" }, 400);

  const file = await loadStaging(c.env);
  if (!file) return c.json({ error: "staging_empty" }, 400);

  const rejected = new Set(file.rejected.map((k) => k.toLowerCase()));
  // 未富化的词不能发布：内容字段还是占位，发上去就是空详情页
  const pending = file.items.filter(
    (t) => !rejected.has(t.keyword.toLowerCase()) && !t.enrichStatus,
  );
  const skipped = file.items.filter(
    (t) => !rejected.has(t.keyword.toLowerCase()) && Boolean(t.enrichStatus),
  ).length;
  if (pending.length === 0 && file.rejected.length === 0) {
    return c.json(
      { error: "nothing_to_publish", detail: skipped > 0 ? `${skipped} 个候选还没富化` : "" },
      400,
    );
  }

  /*
   * 发布是整榜操作：连点两次会派发两个 workflow，
   * 后一个拿着同一份候选再发一次，白切一个版本号还把 diff 记录搅乱。
   */
  const running = await findRunningJob(c.env, "publish");
  if (running) {
    return c.json(
      {
        error: "already_publishing",
        detail: "上一次发布还在跑，等它结束再发",
        runUrl: running.run_url ?? null,
      },
      409,
    );
  }

  /*
   * 纯更新（候选池里每个待发词都已在榜）走增量发布：
   * 只在当前版本上改变化的行，不新建版本、不继承其余五个榜、不剪枝 ——
   * 免费版每天只有 10 万 rows_written，而一次完整发布要 3.8 万。
   *
   * 只要有一个新词就必须完整发布：新版本才会进版本历史，才回滚得回去。
   */
  let patch = "0";
  const cur = await currentVersion(c.env.DB).catch(() => null);
  if (cur && pending.length > 0) {
    const listed = await c.env.DB.prepare(
      "SELECT item_key FROM board_listed WHERE version = ? AND board = 'trends'",
    )
      .bind(cur)
      .all<{ item_key: string }>()
      .catch(() => ({ results: [] as { item_key: string }[] }));
    const keys = new Set((listed.results ?? []).map((r) => r.item_key));
    if (pending.every((t) => keys.has(t.slug))) patch = "1";
  }

  const jobId = await insertJob(c.env, "publish", { incoming: pending.length }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, PUBLISH_WORKFLOW, {
      incoming: String(pending.length),
      job_id: jobId,
      patch,
    });
    await updateJobRun(c.env, jobId, run);
    return c.json({ ok: true, run, incoming: pending.length, skipped, jobId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(c.env, jobId, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/** 任务列表 */
trends.get("/jobs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
  return c.json({ jobs: await listJobs(c.env, limit) });
});

export { trends };