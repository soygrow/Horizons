/**
 * 后台「模型榜」「机会榜」。
 *
 * 这两个榜没有候选池，所以后台不需要审核表：
 *   - 模型榜由 `pnpm collect --models=a,b,c` 定向刷新后直接增量写 D1（不落仓库文件）；
 *   - 机会榜是人工策展文件，改完直接同步。
 *
 * 页面模式与 GitHub 榜一致：能看线上榜单、勾选若干条「更新选中」、增量发布。
 * 区别只在「更新选中」的去处 —— GitHub 榜是写进候选池等人审核，
 * 模型榜没有候选池，采集结果直接合并回文件并更新榜单。
 *
 * 数据全部读 D1 的 board_listed（当前生效版本），不回落到仓库文件。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { insertJob, listJobs } from "../lib/board-jobs";
import { dispatchWorkflow, ghConfig, latestRun, mapStatus, missingSecrets } from "../lib/github";
import { currentVersion, listDataDays, listReleased, resolveListedVersion } from "../lib/versions";

const MAX_PAGE_SIZE = 100;
/**
 * 一次最多刷新多少个：与 fetch-models.yml 的入参校验保持一致。
 *
 * 定向刷新不是逐个请求：采集先把两个源各拉一遍，再按 slug 在本地筛，
 * 所以耗时几乎与条数无关（50 个约 46 秒），200 个也撑不满 15 分钟的 job。
 */
const MAX_REFRESH = 200;

interface Def {
  board: "models" | "opps";
  /** 触发同步用的 workflow 文件名；null 表示还没有流水线 */
  workflow: string | null;
  /** 该 workflow 支持 patch 输入（只写变化行） */
  patchable?: boolean;
  /** 定向刷新的 workflow；没有就是纯整榜同步 */
  refreshWorkflow?: string;
  /** github_jobs 里的 kind 前缀，用来只取本流水线的运行记录 */
  kindPrefix?: string;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 卡片是 JSON 文本，坏数据不能让整页 500 */
function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function parseCats(raw: string | null): string[] {
  const val = parseJson(raw);
  return Array.isArray(val) ? val.filter((x): x is string => typeof x === "string") : [];
}

function makeRoutes(def: Def): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();

  /** 概览：当前版本、在榜条数、最近一次同步、最近几条运行记录 */
  routes.get("/overview", async (c) => {
    const cfg = ghConfig(c.env);
    const missing = missingSecrets(c.env);
    const [version, stats, run, jobs] = await Promise.all([
      currentVersion(c.env.DB),
      c.env.DB.prepare("SELECT total, updated_at FROM board_stats WHERE board = ?")
        .bind(def.board)
        .first<{ total: number; updated_at: string | null }>(),
      // 运行状态读不到只影响这一行，不能让整页失败
      cfg && def.workflow ? latestRun(cfg, def.workflow).catch(() => null) : Promise.resolve(null),
      // 运行记录同理：拿不到就空着
      listJobs(c.env, 5, def.kindPrefix).catch(() => []),
    ]);

    return c.json({
      board: def.board,
      configured: Boolean(cfg),
      missing,
      publishable: Boolean(def.workflow),
      refreshable: Boolean(def.refreshWorkflow),
      patchable: Boolean(def.patchable),
      version,
      total: stats?.total ?? 0,
      updatedAt: stats?.updated_at ?? null,
      status: mapStatus(run, "idle"),
      run: run ? { id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion } : null,
      jobs,
    });
  });

  /** 当前版本的榜单明细，分页 */
  routes.get("/items", async (c) => {
    const version = await currentVersion(c.env.DB);
    const page = clampInt(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const size = clampInt(c.req.query("size"), 50, 1, MAX_PAGE_SIZE);

    if (!version) {
      return c.json({ version: null, page, size, total: 0, pages: 1, items: [] });
    }

    const [countRow, rows] = await Promise.all([
      c.env.DB.prepare("SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?")
        .bind(version, def.board)
        .first<{ n: number }>(),
      listReleased(c.env.DB, def.board, version, size, (page - 1) * size),
    ]);

    const total = countRow?.n ?? 0;
    return c.json({
      version,
      page,
      size,
      total,
      pages: Math.max(1, Math.ceil(total / size)),
      items: rows.map((r) => ({
        key: r.item_key,
        rank: r.rank,
        score: r.score,
        tier: r.tier,
        name: r.name,
        url: r.url,
        cats: parseCats(r.cats),
        card: parseJson(r.card),
      })),
    });
  });

  /**
   * 线上榜单清单，一次全给。
   *
   * 模型榜 366 条、机会榜 5 条，精简字段后只有几十 KB —— 比翻页接口更适合
   * 「搜索 + 厂商筛选 + 全选当前结果」这种交互，也更接近 GitHub 榜那页的用法。
   */
  routes.get("/listed", async (c) => {
    const { version, current, versions } = await resolveListedVersion(
      c.env.DB,
      def.board,
      c.req.query("version"),
    );
    if (!version) {
      return c.json({ version: null, current, versions, days: [], total: 0, items: [] });
    }

    /* 版本下拉列的是这一版内部的数据日分布，不是「发布过几次」 ——
       同一个快照会被搬进下一版，按版本分组会出现 370 / 370 / 366 三家分晋，
       加起来比总数还多。按行分组才恒等于 total。 */
    const days = await listDataDays(c.env.DB, def.board, version);

    const { results } = await c.env.DB.prepare(
      `SELECT item_key, rank, score, name, cats,
              json_extract(card, '$.provider')     AS provider,
              json_extract(card, '$.capability')   AS capability,
              json_extract(card, '$.value')        AS value,
              json_extract(card, '$.context')      AS context,
              json_extract(card, '$.price.input')  AS priceIn,
              json_extract(card, '$.price.output') AS priceOut,
              json_extract(card, '$.tags')         AS tags,
              json_extract(card, '$.dataAt')       AS dataAt,
              /* 下拉分组用的列，行就按它筛，避免两边各算一套 */
              data_day
         FROM board_listed
        WHERE version = ? AND board = ?
        ORDER BY rank ASC`,
    )
      .bind(version, def.board)
      .all<{
        item_key: string;
        rank: number;
        score: number;
        name: string;
        cats: string | null;
        provider: string | null;
        capability: number | null;
        value: number | null;
        context: number | null;
        priceIn: number | null;
        priceOut: number | null;
        tags: string | null;
        dataAt: string | null;
        data_day: string | null;
      }>();

    const rows = results ?? [];
    return c.json({
      version,
      current,
      versions,
      days,
      total: rows.length,
      items: rows.map((r) => ({
        key: r.item_key,
        rank: r.rank,
        score: r.score,
        name: r.name,
        provider: r.provider,
        capability: r.capability,
        value: r.value,
        context: r.context,
        priceIn: r.priceIn,
        priceOut: r.priceOut,
        tags: parseCats(r.cats).length ? parseCats(r.cats) : parseCats(r.tags),
        dataAt: r.dataAt,
        dataDay: r.data_day,
      })),
    });
  });

  /**
   * 定向刷新：重新采集选中条目，合并回榜单文件并增量写库。
   *
   * 采集要打公网、跑完整管线，Worker 干不了，所以照旧派发给 Actions。
   */
  routes.post("/refresh", async (c) => {
    if (!def.refreshWorkflow) {
      return c.json({ error: "no_refresh", detail: "这个榜不支持定向刷新" }, 409);
    }

    const body = (await c.req.json().catch(() => null)) as { keys?: unknown } | null;
    const keys = Array.isArray(body?.keys)
      ? [
          ...new Set(
            body.keys.filter(
              (k): k is string => typeof k === "string" && k.length > 0 && k.length <= 80 && !k.includes(","),
            ),
          ),
        ]
      : [];

    if (keys.length === 0) return c.json({ error: "no_keys", detail: "没有选中任何条目" }, 400);
    if (keys.length > MAX_REFRESH) {
      return c.json({ error: "too_many", detail: `一次最多 ${MAX_REFRESH} 个，当前 ${keys.length} 个` }, 400);
    }

    const cfg = ghConfig(c.env);
    if (!cfg) {
      /* detail 是给人看的：前端直接把这条错误写到提交按钮下面 */
      const missing = missingSecrets(c.env);
      return c.json(
        { error: "github_not_configured", detail: `未配置 GitHub 集成（缺 ${missing.join(" / ")}）`, missing },
        400,
      );
    }

    try {
      const run = await dispatchWorkflow(cfg, def.refreshWorkflow, { models: keys.join(",") });
      await insertJob(c.env, `${def.kindPrefix ?? def.board}-refresh`, { keys }, run, null).catch(() => {});
      return c.json({ ok: true, count: keys.length, run: run ? { id: run.id, url: run.html_url } : null });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return c.json({ error: "dispatch_failed", detail }, 502);
    }
  });

  /** 触发同步：把仓库里的榜单文件写进 D1 */
  routes.post("/publish", async (c) => {
    if (!def.workflow) {
      return c.json({ error: "no_workflow", detail: "这个榜还没有流水线，只能本地跑脚本" }, 409);
    }

    const cfg = ghConfig(c.env);
    if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

    // 支持增量的榜默认走增量：日常刷新只改几条，没必要重写整个版本
    const body = (await c.req.json().catch(() => null)) as { patch?: unknown } | null;
    const patch = def.patchable && body?.patch !== false;

    try {
      const run = await dispatchWorkflow(cfg, def.workflow, patch ? { patch: "true" } : {});
      await insertJob(c.env, `${def.kindPrefix ?? def.board}-publish`, { patch }, run, null).catch(() => {});
      return c.json({ ok: true, patch, run: run ? { id: run.id, url: run.html_url } : null });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return c.json({ error: "dispatch_failed", detail }, 502);
    }
  });

  /** 最近几条运行记录，供页面刷新 */
  routes.get("/jobs", async (c) => {
    const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, 50);
    return c.json({ jobs: await listJobs(c.env, limit, def.kindPrefix) });
  });

  /** 最近一次运行状态，供触发后轮询 */
  routes.get("/run-status", async (c) => {
    const cfg = ghConfig(c.env);
    if (!cfg || !def.workflow) return c.json({ status: "idle", run: null });

    const run = await latestRun(cfg, def.workflow);
    return c.json({
      status: mapStatus(run, "idle"),
      run: run
        ? { id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion }
        : null,
    });
  });

  return routes;
}

/**
 * 模型榜：采集在 CI 跑（fetch-models.yml 定向刷新选中的模型），
 * 发布靠 publish-models.yml，默认走增量。
 */
export const models = makeRoutes({
  board: "models",
  workflow: "publish-models.yml",
  patchable: true,
  refreshWorkflow: "fetch-models.yml",
  kindPrefix: "models",
});

/** 机会榜：人工策展，发布靠 publish-opps.yml */
export const opps = makeRoutes({ board: "opps", workflow: "publish-opps.yml" });