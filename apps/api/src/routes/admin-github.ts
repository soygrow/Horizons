/**
 * 后台「GitHub 榜」API：采集、审核、发布。
 *
 * 与工具榜、趋势榜的分工完全一致 —— Worker 跑不动采集（要打 700 多次 GitHub 接口、
 * 还要读写 59MB 的 github.json），这里只做编排：
 *   1. 点「采集」→ 触发 fetch-github.yml，候选只写进 content/github-staging.json；
 *   2. 读候选池，逐个仓库看分数、星标、预计名次，决定收还是拒；
 *   3. 点「发布」前先算一遍位次变化 —— 谁进榜、谁被挤出去、前 50 谁动了；
 *   4. 确认后触发 publish-github.yml，那边才真正写 content/github.json。
 *
 * 候选池里自带一份「榜单计分快照」（staging.board），所以预览不用拉 59MB 的正式榜。
 * 鉴权与 CSRF 由 admin.ts 的 `admin.use("*")` 统一兜住。
 */
import { Hono } from "hono";
import type { RepoRankReport, RepoRankRow, RepoStagingFile, StagingCandidate } from "@horizons/shared";
import { diffRepoRanks, pickTopRepoRows, rankRepos, toRepoRankRow } from "@horizons/shared";
import type { Env } from "../env";
import {
  dispatchWorkflow,
  fetchRun,
  ghConfig,
  mapStatus,
  missingSecrets,
  readRepoJson,
  writeRepoJson,
  type WorkflowRun,
} from "../lib/github";

const github = new Hono<{ Bindings: Env }>();

const STAGING_PATH = "content/github-staging.json";
const FETCH_WORKFLOW = "fetch-github.yml";
const PUBLISH_WORKFLOW = "publish-github.yml";

/** 与实际写文件的脚本保持同一默认值 */
const DEFAULT_TARGET = 2000;

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
  await env.DB.prepare("UPDATE github_jobs SET status = ?, run_url = ?, updated_at = ? WHERE id = ?")
    .bind(status, run.html_url ?? row.run_url, now, row.id)
    .run();
  return { ...row, status, run_url: run.html_url ?? row.run_url, updated_at: now };
}

async function listJobs(env: Env, limit: number): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM github_jobs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<JobRow>();
  const rows = results ?? [];
  const cfg = ghConfig(env);
  return Promise.all(rows.map((r) => refreshJob(env, cfg, r).catch(() => r)));
}

async function insertJob(
  env: Env,
  kind: string,
  params: Record<string, unknown>,
  run: WorkflowRun | null,
  error: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO github_jobs (id, kind, status, params, gh_run_id, run_url, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
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
}

/* --------------------------------- 计算 --------------------------------- */

interface CandidateView {
  fullName: string;
  owner: string;
  description?: string;
  language?: string;
  topics: string[];
  stars: number;
  forks: number;
  score: number;
  grade: string;
  /** 加工空间 0-10 */
  dv: number | null;
  /** 现在是否已在榜 */
  inBoard: boolean;
  /** 在榜时的当前名次 */
  currentRank: number | null;
  /** 发布后的预计名次 */
  estimatedRank: number | null;
  /** 名次变化（正数上升）；不在榜为 null */
  delta: number | null;
  /** 综合分变化 */
  scoreDelta: number;
  rejected: boolean;
  check: { ok: boolean; reason: string };
}

/**
 * 把候选池推演成「发布后会怎样」。
 *
 * 注意和采集脚本的区别：那边是预计值（基于当时的正式榜），
 * 这里是后台实时算的（基于候选池里的 board 快照 + 当前拒绝列表），
 * 所以用户拒掉一个候选后，预览会立刻跟着变。
 */
function buildView(file: RepoStagingFile): {
  candidates: CandidateView[];
  report: RepoRankReport;
  boardRank: Map<string, number>;
  afterRows: RepoRankRow[];
} {
  const rejected = new Set((file.rejected ?? []).map((k) => k.toLowerCase()));
  const boardRows = file.board?.rows ?? [];
  const boardRank = rankRepos(boardRows);
  const boardByKey = new Map(boardRows.map((r) => [r.fullName.toLowerCase(), r]));
  const target = file.target || DEFAULT_TARGET;

  const kept = boardRows.filter((r) => !rejected.has(r.fullName.toLowerCase()));
  const incoming = (file.candidates ?? []).filter(
    (c) => !rejected.has(c.repo.fullName.toLowerCase()),
  );

  /* 容量是硬约束：推演时必须和发布脚本一样截断，
     否则会出现「预览说能进、发布却没进」的错位。 */
  const afterRows = pickTopRepoRows(
    [...kept, ...incoming.map((c) => ({ ...toRepoRankRow(c.repo), score: c.score }))],
    target,
  );
  const afterRank = rankRepos(afterRows);
  const report = diffRepoRanks(boardRows, afterRows);

  const changeByKey = new Map(report.changes.map((c) => [c.fullName, c]));

  const candidates: CandidateView[] = (file.candidates ?? []).map((c: StagingCandidate) => {
    const key = c.repo.fullName.toLowerCase();
    const current = boardByKey.get(key) ?? null;
    const change = changeByKey.get(c.repo.fullName) ?? null;
    return {
      fullName: c.repo.fullName,
      owner: c.repo.owner,
      description: c.repo.description,
      language: c.repo.language,
      topics: c.repo.topics ?? [],
      stars: c.repo.stars,
      forks: c.repo.forks,
      score: c.score,
      grade: c.grade,
      dv: typeof c.repo.derivative?.space === "number" ? c.repo.derivative.space : null,
      inBoard: Boolean(current),
      currentRank: current ? (boardRank.get(current.fullName) ?? null) : null,
      estimatedRank: rejected.has(key) ? null : (afterRank.get(c.repo.fullName) ?? null),
      delta: change ? change.delta : null,
      scoreDelta: change ? change.scoreDelta : 0,
      rejected: rejected.has(key),
      check: c.check ?? { ok: true, reason: "通过收录原则" },
    };
  });

  return { candidates, report, boardRank, afterRows };
}

function reportSummary(report: RepoRankReport): {
  boardBefore: number;
  boardAfter: number;
  entered: number;
  exited: number;
  up: number;
  down: number;
  significant: number;
  shifted: number;
} {
  return {
    boardBefore: report.boardBefore,
    boardAfter: report.boardAfter,
    entered: report.entered.length,
    exited: report.exited.length,
    up: report.ups.length,
    down: report.downs.length,
    significant: report.significant.length,
    shifted: report.shifted,
  };
}

async function loadStaging(env: Env): Promise<{ file: RepoStagingFile | null; sha?: string }> {
  const cfg = ghConfig(env);
  if (!cfg) return { file: null };
  const res = await readRepoJson<RepoStagingFile>(cfg, STAGING_PATH);
  return res ? { file: res.data, sha: res.sha } : { file: null };
}

/* ---------------------------------- 路由 ---------------------------------- */

/** 概览：候选数、容量缺口、上次采集/发布结果、最近任务 */
github.get("/overview", async (c) => {
  const cfg = ghConfig(c.env);
  const missing = missingSecrets(c.env);
  const jobs = await listJobs(c.env, 5);
  if (!cfg) return c.json({ configured: false, missing, staging: null, jobs });

  try {
    const { file } = await loadStaging(c.env);
    if (!file) {
      return c.json({ configured: true, missing, staging: null, jobs, empty: true });
    }
    const { candidates, report, afterRows } = buildView(file);
    const target = file.target || DEFAULT_TARGET;
    return c.json({
      configured: true,
      missing,
      jobs,
      staging: {
        updatedAt: file.updatedAt,
        ruleVersion: file.ruleVersion,
        scoreModel: file.scoreModel,
        target,
        boardRows: file.board?.rows.length ?? 0,
        boardUpdatedAt: file.board?.updatedAt ?? null,
        candidates: candidates.length,
        pending: candidates.filter((x) => !x.rejected).length,
        rejected: file.rejected?.length ?? 0,
        updates: file.updates?.length ?? 0,
        lastRun: file.lastRun ?? null,
        lastPublish: file.lastPublish ?? null,
        /** 发布后预计能凑到多少条；< target 说明候选池不够，得先扩池 */
        projected: afterRows.length,
        shortfall: Math.max(0, target - afterRows.length),
        ...reportSummary(report),
      },
    });
  } catch (e) {
    return c.json({
      configured: true,
      missing,
      staging: null,
      jobs,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/** 候选明细：每个仓库的分数、星标、当前名次与预计名次 */
github.get("/staging", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const { file } = await loadStaging(c.env);
  if (!file) return c.json({ empty: true, candidates: [], report: null });

  const { candidates, report } = buildView(file);
  return c.json({
    updatedAt: file.updatedAt,
    target: file.target || DEFAULT_TARGET,
    lastRun: file.lastRun ?? null,
    lastPublish: file.lastPublish ?? null,
    candidates,
    report: reportSummary(report),
  });
});

/**
 * 收录 / 拒绝。
 *
 * 用 body 传 fullName 而不是路径参数：仓库全名里带 `/`（owner/repo），
 * 放路径里要编码成 %2F，Hono 的 :param 默认不匹配斜杠，容易踩坑。
 */
github.post("/staging/reject", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured" }, 400);

  const body = await c.req
    .json<{ fullName?: string; rejected?: boolean }>()
    .catch(() => ({}) as { fullName?: string; rejected?: boolean });
  const fullName = String(body.fullName ?? "").trim();
  if (!fullName) return c.json({ error: "full_name_required" }, 400);
  const wantReject = body.rejected !== false;

  const { file, sha } = await loadStaging(c.env);
  if (!file || !sha) return c.json({ error: "staging_empty" }, 404);

  const key = fullName.toLowerCase();
  const known =
    (file.candidates ?? []).some((x) => x.repo.fullName.toLowerCase() === key) ||
    (file.board?.rows ?? []).some((r) => r.fullName.toLowerCase() === key);
  if (!known) return c.json({ error: "not_found" }, 404);

  const rejected = new Set((file.rejected ?? []).map((k) => k.toLowerCase()));
  const existing = [...rejected].find((k) => k === key);
  if (wantReject) rejected.add(key);
  else if (existing) rejected.delete(existing);

  const ok = await writeRepoJson(
    cfg,
    STAGING_PATH,
    { ...file, rejected: [...rejected] },
    sha,
    `chore(github): ${wantReject ? "拒绝" : "恢复"}候选 ${fullName}`,
  );
  if (!ok) return c.json({ error: "write_failed" }, 502);

  return c.json({ ok: true, fullName, rejected: wantReject });
});

/** 发布预览：谁进榜、谁被挤出去、前 50 谁动了 */
github.get("/publish/preview", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured" }, 400);

  const { file } = await loadStaging(c.env);
  if (!file) return c.json({ empty: true, preview: null });

  const { candidates, report, afterRows } = buildView(file);
  const target = file.target || DEFAULT_TARGET;
  const active = candidates.filter((x) => !x.rejected);

  return c.json({
    preview: {
      updatedAt: file.updatedAt,
      target,
      incoming: active.length,
      inBoardRefresh: active.filter((x) => x.inBoard).length,
      projected: afterRows.length,
      shortfall: Math.max(0, target - afterRows.length),
      ...reportSummary(report),
      /** 前 50 名的变动，发布前最需要看的就是这个 */
      top: report.top.slice(0, 40),
      /** 显著变动：进榜、出榜、自身分数变化 ≥0.5、涉及前 50 */
      named: report.significant.slice(0, 60),
      /** 发布后候选池会被清空，带上上一次发布的记录，方便回答「刚才动了谁」 */
      lastPublish: file.lastPublish ?? null,
    },
  });
});

/* -------------------------------- 触发流水线 -------------------------------- */

/** 采集：只写候选池，正式榜不动 */
github.post("/fetch", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ target?: number; refreshCache?: boolean }>()
    .catch(() => ({}) as { target?: number; refreshCache?: boolean });

  /* 容量卡在 500-3000：低于 500 不像榜，高于 3000 时 59MB 的正式榜会涨到失控 */
  const target = Math.min(Math.max(Number(body.target ?? DEFAULT_TARGET) || DEFAULT_TARGET, 500), 3000);
  const refreshCache = body.refreshCache === true;

  try {
    const run = await dispatchWorkflow(cfg, FETCH_WORKFLOW, {
      target: String(target),
      refresh_cache: refreshCache ? "1" : "0",
    });
    await insertJob(c.env, "fetch", { target, refreshCache }, run, null);
    return c.json({ ok: true, run, target, refreshCache });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await insertJob(c.env, "fetch", { target, refreshCache }, null, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/** 发布：把候选池合并进正式榜，随后重建站点 */
github.post("/publish", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured" }, 400);

  const { file } = await loadStaging(c.env);
  if (!file) return c.json({ error: "staging_empty" }, 400);

  const rejected = new Set((file.rejected ?? []).map((k) => k.toLowerCase()));
  const pending = (file.candidates ?? []).filter(
    (x) => !rejected.has(x.repo.fullName.toLowerCase()),
  );
  const updates = file.updates ?? [];
  if (pending.length === 0) {
    return c.json({ error: "nothing_to_publish" }, 400);
  }

  const { report } = buildView(file);

  try {
    const run = await dispatchWorkflow(cfg, PUBLISH_WORKFLOW, {
      incoming: String(pending.length),
      /** 这份摘要会回传到 Actions，发布后与真实结果对账 */
      expected_significant: String(report.significant.length),
    });
    await insertJob(
      c.env,
      "publish",
      { incoming: pending.length, updates: updates.length },
      run,
      null,
    );
    return c.json({
      ok: true,
      run,
      incoming: pending.length,
      updates: updates.length,
      /** 发布前的预计变化，方便用户核对 */
      expected: reportSummary(report),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await insertJob(c.env, "publish", { incoming: pending.length }, null, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/** 任务列表 */
github.get("/jobs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
  return c.json({ jobs: await listJobs(c.env, limit) });
});

export { github };