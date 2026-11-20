/**
 * 后台「GitHub 榜」API：采集、审核、发布。
 *
 * 与工具榜、趋势榜的分工完全一致 —— Worker 跑不动采集（要打 700 多次 GitHub 接口、
 * 还要读写几十 MB 的榜单数据），这里只做编排：
 *   1. 点「采集」→ 触发 fetch-github.yml，候选只写进候选池；
 *   2. 读候选池，逐个仓库看分数、星标、预计名次，决定收还是拒；
 *   3. 点「发布」前先算一遍位次变化 —— 谁进榜、谁被挤出去、前 50 谁动了；
 *   4. 确认后触发 publish-github.yml，那边才真正写 D1 的当前版本。
 *
 * 数据全部来自 D1：候选池读 board_items，发布期快照读 board_reports:github-meta。
 * 鉴权与 CSRF 由 admin.ts 的 `admin.use("*")` 统一兜住。
 */
import { Hono } from "hono";
import type { RepoRankReport, RepoRankRow, RepoStagingFile, StagingCandidate } from "@horizons/shared";
import { diffRepoRanks, pickTopRepoRows, rankRepos, toRepoRankRow } from "@horizons/shared";
import type { Env } from "../env";
import { insertJob, listJobs } from "../lib/board-jobs";
import { dispatchWorkflow, ghConfig, missingSecrets, type WorkflowRun } from "../lib/github";
import { readBoardStats, type BoardStats } from "../lib/board-stats";
import { listWorkspace, setItemsStatus, setItemStatus } from "../lib/board-items";
import { readReport } from "../lib/reports";
import { listDataDays, resolveListedVersion } from "../lib/versions";

const github = new Hono<{ Bindings: Env }>();

const FETCH_WORKFLOW = "fetch-github.yml";
const PUBLISH_WORKFLOW = "publish-github.yml";
/** 发布期快照（当前榜 1500 行 + 上次采集/发布摘要）在 board_reports 里的 key */
const META_KEY = "github-meta";

/** 与实际写文件的脚本保持同一默认值 */
const DEFAULT_TARGET = 2000;

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

/** board_reports:github-meta 的结构（采集/发布脚本写入） */
type GithubMeta = {
  updatedAt?: string;
  ruleVersion?: string;
  scoreModel?: string;
  target?: number;
  board?: NonNullable<RepoStagingFile["board"]>;
  /** updates 是 repo 元数据刷新队列，476KB 不进库，后台只需要条数 */
  updatesCount?: number;
  lastRun?: NonNullable<RepoStagingFile["lastRun"]>;
  lastPublish?: NonNullable<RepoStagingFile["lastPublish"]>;
};

/**
 * 候选池与发布期快照都来自 D1：
 *   - 候选 / 拒绝名单 → board_items（后台会改，库就是真相）
 *   - 当前榜快照 / 上次采集 / 上次发布 → board_reports:github-meta（脚本只写）
 * 两者都没有才算「还没采集过」，返回 null 让页面显示空态。
 */
async function loadStaging(
  env: Env,
): Promise<{ file: RepoStagingFile | null; updatesCount: number }> {
  const [ws, meta] = await Promise.all([
    listWorkspace<StagingCandidate>(env.DB, "github"),
    readReport<GithubMeta>(env.DB, META_KEY),
  ]);

  if (!meta && ws.items.length === 0 && ws.rejected.length === 0) {
    return { file: null, updatesCount: 0 };
  }

  const m = meta?.data;
  return {
    updatesCount: m?.updatesCount ?? 0,
    file: {
      updatedAt: ws.updatedAt ?? m?.updatedAt ?? new Date(0).toISOString(),
      ruleVersion: m?.ruleVersion ?? "",
      scoreModel: m?.scoreModel ?? "",
      target: m?.target ?? DEFAULT_TARGET,
      board: m?.board ?? { rows: [] },
      candidates: ws.items,
      updates: [],
      rejected: ws.rejected,
      preview: null,
      ...(m?.lastRun ? { lastRun: m.lastRun } : {}),
      ...(m?.lastPublish ? { lastPublish: m.lastPublish } : {}),
    },
  };
}

/* ---------------------------------- 路由 ---------------------------------- */

/** 概览：候选数、容量缺口、上次采集/发布结果、最近任务 */
github.get("/overview", async (c) => {
  // configured 只表示「能派发流水线」，数据本身不需要 GitHub 凭据就能读
  const configured = Boolean(ghConfig(c.env));
  const missing = missingSecrets(c.env);
  const jobs = await listJobs(c.env, 5);

  try {
    const [{ file, updatesCount }, boardStats] = await Promise.all([
      loadStaging(c.env),
      // 在榜数字查库；失败只影响这一个数字，不能拖垮整页
      readBoardStats(c.env.DB).catch(() => ({}) as BoardStats),
    ]);
    const board = boardStats.github ?? null;
    if (!file) {
      return c.json({ configured, missing, staging: null, jobs, empty: true, board });
    }
    const { candidates, report, afterRows } = buildView(file);
    const target = file.target || DEFAULT_TARGET;
    return c.json({
      configured,
      missing,
      jobs,
      board,
      staging: {
        updatedAt: file.updatedAt,
        ruleVersion: file.ruleVersion,
        scoreModel: file.scoreModel,
        target,
        /*
         * 快照可能是「有 updatedAt 但 rows 为空」的壳（发布后清空、CI 没还原榜单文件），
         * 所以按「有内容才算」判断，0 继续回退到上次发布、最后到正式榜统计。
         */
        boardRows: file.board?.rows.length || file.lastPublish?.total || board?.total || 0,
        boardUpdatedAt: file.board?.rows.length
          ? file.board.updatedAt
          : (file.lastPublish?.at ?? board?.updatedAt ?? null),
        candidates: candidates.length,
        pending: candidates.filter((x) => !x.rejected).length,
        rejected: file.rejected?.length ?? 0,
        updates: updatesCount,
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
      configured,
      missing,
      staging: null,
      jobs,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/** 候选明细：每个仓库的分数、星标、当前名次与预计名次 */
github.get("/staging", async (c) => {
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
  const body = await c.req
    .json<{ fullName?: string; rejected?: boolean }>()
    .catch(() => ({}) as { fullName?: string; rejected?: boolean });
  const fullName = String(body.fullName ?? "").trim();
  if (!fullName) return c.json({ error: "full_name_required" }, 400);
  const wantReject = body.rejected !== false;
  const key = fullName.toLowerCase();

  // 只改库：采集脚本读库里的 rejected 名单，下次抓取自动跳过
  const changed = await setItemStatus(
    c.env.DB,
    "github",
    key,
    wantReject ? "rejected" : "candidate",
  );
  if (!changed) return c.json({ error: "not_found" }, 404);

  return c.json({ ok: true, fullName, rejected: wantReject });
});

/* -------------------------------- 线上榜单 -------------------------------- */

/** 线上榜单行：只取列表要显示的字段，不把整张卡片捞出来 */
interface ListedRepoRow {
  item_key: string;
  rank: number;
  score: number;
  name: string;
  url: string | null;
  stars: number | null;
  forks: number | null;
  language: string | null;
  description: string | null;
  pushed_at: string | null;
  last_crawled: string | null;
  grade: string | null;
}

/**
 * 一次最多重采多少个。
 *
 * 定向重采是「一个仓库一次 /repos/{full}」，100 个 ≈ 两分钟，远低于
 * token 限额（5000/h）；真正花钱的是发布那一步，所以上限配合增量写库一起用。
 */
const MAX_REFRESH_REPOS = 100;

/**
 * 线上榜单：名次 + 数值 + 上次采集时间 + 候选池状态。
 *
 * 与趋势榜 /trends/listed 同一思路：更新时间用来判断该不该重采，
 * staging 用来避免「已经在队列里了又提交一遍」。
 */
github.get("/listed", async (c) => {
  const { version, current, versions } = await resolveListedVersion(
    c.env.DB,
    "github",
    c.req.query("version"),
  );
  if (!version) {
    return c.json({
      version: "",
      current,
      versions,
      days: [],
      total: 0,
      items: [],
      refreshPending: 0,
      detail: "库里还没有发布过 GitHub 榜",
    });
  }

  /* 版本下拉列的是这一版内部的数据日分布：1500 行可能横跨几次采集，
     按行分组各天条数之和才等于 total，行内「更新时间」也才和它一致 */
  const days = await listDataDays(c.env.DB, "github", version);

  const [{ results }, ws] = await Promise.all([
    /* 0021 起这些标量是列：不再对 1500 行各做 7 次 json_extract（一次 2–4MB） */
    c.env.DB.prepare(
      `SELECT item_key, rank, score, name, url,
              stars, forks, language, description,
              pushed_at,
              COALESCE(last_crawled_at, json_extract(card, '$.lastCrawledAt')) AS last_crawled,
              grade
       FROM board_listed
       WHERE version = ? AND board = 'github'
       ORDER BY rank ASC, name ASC`,
    )
      .bind(version)
      .all<ListedRepoRow>(),
    listWorkspace<StagingCandidate>(c.env.DB, "github"),
  ]);

  const staging = new Map<string, string>();
  for (const t of ws.items) {
    const stage = (t as unknown as { stage?: string }).stage;
    if (stage) staging.set(t.repo.fullName.toLowerCase(), stage);
  }

  const items = (results ?? []).map((r) => ({
    fullName: r.name,
    owner: r.name.split("/")[0] ?? "",
    rank: r.rank,
    score: r.score,
    stars: r.stars ?? 0,
    forks: r.forks ?? 0,
    language: r.language,
    description: r.description,
    grade: r.grade,
    pushedAt: r.pushed_at,
    /**
     * 上次真正采到数据的日期：判断「该不该更新」就看它。
     *
     * 不再回落到 pushed_at —— 那是仓库最后一次 push 的日期，拿它冒充
     * 「我们什么时候采的」会让列表里出现一堆和采集无关的时间。
     */
    lastCrawledAt: r.last_crawled,
    /* board_listed 的 item_key 是原样的 fullName，工作区用小写，这里要转一道 */
    staging: staging.get(r.name.toLowerCase()) ?? null,
  }));

  /* 队列里有多少是「线上词的重采」——发布时这些走增量，不算新进榜 */
  const onBoard = new Set(items.map((i) => i.fullName.toLowerCase()));
  const refreshPending = ws.items.filter((t) => onBoard.has(t.repo.fullName.toLowerCase())).length;

  return c.json({ version, current, versions, days, total: items.length, refreshPending, items });
});

/**
 * 更新选中：对指定仓库做定向重采。
 *
 * 和「采集」的区别是这条路不打搜索、不重置候选池：N 个仓库就是 N 次请求，
 * 结果按「在榜刷新」写进候选池，发布时只改写这几行（patchBoard）。
 * 以前没有这条路，想刷新十几个仓库只能跑一次全量采集（700+ 请求、近 50 分钟），
 * 发布时还要重写全榜两万三千行 —— 成本完全不成比例。
 */
github.post("/refresh", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = await c.req
    .json<{ repos?: unknown }>()
    .catch(() => ({}) as { repos?: unknown });
  const raw = Array.isArray(body.repos) ? body.repos : [];
  const repos = [
    ...new Set(
      raw
        .map((r) => String(r).trim())
        .filter((r) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r))
        .map((r) => r),
    ),
  ];
  if (repos.length === 0) return c.json({ error: "repos_required" }, 400);
  if (repos.length > MAX_REFRESH_REPOS) {
    return c.json({ error: "too_many_repos", limit: MAX_REFRESH_REPOS }, 400);
  }

  /* 先标「更新中」，避免同一条被连点两次扔进两条流水线 */
  await setItemsStatus(
    c.env.DB,
    "github",
    repos.map((r) => r.toLowerCase()),
    "enriching",
  ).catch(() => 0);

  try {
    const run = await dispatchWorkflow(cfg, FETCH_WORKFLOW, {
      target: String(DEFAULT_TARGET),
      refresh_cache: "0",
      repos: repos.join(","),
    });
    await insertJob(c.env, "refresh", { count: repos.length, repos: repos.slice(0, 5) }, run, null);
    return c.json({ ok: true, run, count: repos.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setItemsStatus(
      c.env.DB,
      "github",
      repos.map((r) => r.toLowerCase()),
      "candidate",
    ).catch(() => 0);
    await insertJob(c.env, "refresh", { count: repos.length }, null, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/** 发布预览：谁进榜、谁被挤出去、前 50 谁动了 */
github.get("/publish/preview", async (c) => {
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

  const { file, updatesCount } = await loadStaging(c.env);
  if (!file) return c.json({ error: "staging_empty" }, 400);

  const rejected = new Set((file.rejected ?? []).map((k) => k.toLowerCase()));
  const pending = (file.candidates ?? []).filter(
    (x) => !rejected.has(x.repo.fullName.toLowerCase()),
  );
  if (pending.length === 0) {
    return c.json({ error: "nothing_to_publish" }, 400);
  }

  const { report } = buildView(file);

  /*
   * 一律增量。
   *
   * 整版发布要建新快照 = 全榜两万三千行 rows_written，只刷新十几个星标
   * 也这么干太亏；patch 只改变动行，新增的仓库同样是插入几行。
   * 需要留一个可回滚的版本时，手动在 Actions 里传 patch=0。
   */
  const patch = true;

  try {
    const run = await dispatchWorkflow(cfg, PUBLISH_WORKFLOW, {
      incoming: String(pending.length),
      /** 这份摘要会回传到 Actions，发布后与真实结果对账 */
      expected_significant: String(report.significant.length),
      patch: patch ? "1" : "0",
    });
    await insertJob(
      c.env,
      "publish",
      { incoming: pending.length, updates: updatesCount, patch },
      run,
      null,
    );
    return c.json({
      ok: true,
      run,
      incoming: pending.length,
      updates: updatesCount,
      patch,
      /** 发布前的预计变化，方便用户核对 */
      expected: reportSummary(report),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await insertJob(c.env, "publish", { incoming: pending.length }, null, msg);
    return c.json({ error: "dispatch_failed", detail: msg }, 502);
  }
});

/**
 * 任务列表：只给最近 5 次。
 *
 * 一天能跑十几轮采集/更新/发布，列表拉长了根本翻不到要看的那条；
 * 页面标题写的也是「最近 5 次」，这里跟着钉死，别让 limit 参数再放大。
 */
github.get("/jobs", async (c) => {
  return c.json({ jobs: await listJobs(c.env, 5) });
});

export { github };