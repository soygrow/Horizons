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
  return { candidates, report, boardRank, trimmed: dropped.length, stats, quality: summarizeQuality(ready) };
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
    const { candidates, report, stats, quality } = buildView(file);
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
        // 候选池的 board 快照在发布后会被清掉，此时回退到上次发布的在榜数，
        // 再不行才用正式榜统计快照 —— 保证后台不显示 0
        boardRows: file.board?.rows.length ?? file.lastPublish?.boardAfter ?? board?.total ?? 0,
        boardUpdatedAt: file.board?.updatedAt ?? file.lastPublish?.at ?? board?.updatedAt ?? null,
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

  const { candidates, report, stats, quality } = buildView(staging);
  return c.json({
    updatedAt: staging.updatedAt,
    runAt: staging.runAt,
    lastRun: staging.lastRun ?? null,
    lastPublish: staging.lastPublish ?? null,
    candidates,
    stats,
    quality,
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

  const { candidates, report, trimmed } = buildView(file);
  const active = candidates.filter((x) => !x.rejected);

  return c.json({
    preview: {
      updatedAt: file.updatedAt,
      boardLimit: MAX_BOARD_SIZE,
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

  const jobId = await insertJob(c.env, "publish", { incoming: pending.length }, null, null);
  try {
    const run = await dispatchWorkflow(cfg, PUBLISH_WORKFLOW, {
      incoming: String(pending.length),
      job_id: jobId,
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