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
import { listWorkspace, setItemStatus } from "../lib/board-items";
import { dispatchWorkflow, ghConfig, latestRun, mapStatus, missingSecrets } from "../lib/github";
import { currentVersion, listDataDays, resolveListedVersion } from "../lib/versions";

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
  /**
   * 需要统计「正在做」人数时给出计入的状态（机会榜用）。
   *
   * 口径按产品定义：点过「我在做」且没放弃的都算，所以是 doing + shipped；
   * paused 是停了一阵、dropped 是放弃，都不该出现在榜单上的热度里。
   */
  doingStatuses?: string[];
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

  /**
   * 当前版本的榜单明细，分页。
   *
   * 机会榜多两个筛选维度：批次（card.batch）与名称。放在服务端过滤而不是
   * 前端全量筛，是因为批次是按周累积的 —— 一年就是 260 条，每条 card 都是
   * 整份机会详情，全量拉下来太重。
   */
  routes.get("/items", async (c) => {
    const version = await currentVersion(c.env.DB);
    const page = clampInt(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
    const size = clampInt(c.req.query("size"), 50, 1, MAX_PAGE_SIZE);

    const filterable = Boolean(def.doingStatuses);
    const batch = filterable ? (c.req.query("batch") ?? "").trim() : "";
    const q = filterable ? (c.req.query("q") ?? "").trim().slice(0, 60) : "";

    if (!version) {
      return c.json({ version: null, page, size, total: 0, pages: 1, items: [] });
    }

    const where = ["version = ?", "board = ?"];
    const binds: unknown[] = [version, def.board];
    if (filterable && batch) {
      /* 0024：走 batch 列，别为了筛 5 条把每行的卡片都解析一次 */
      where.push("batch = ?");
      binds.push(batch);
    }
    if (filterable && q) {
      where.push("name LIKE ?");
      binds.push(`%${q}%`);
    }
    const scope = where.join(" AND ");

    const [countRow, rows, doingRows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS n FROM board_listed WHERE ${scope}`)
        .bind(...binds)
        .first<{ n: number }>(),
      c.env.DB.prepare(
        `SELECT item_key, rank, score, tier, name, url, cats, card
           FROM board_listed
          WHERE ${scope}
                   ORDER BY rank, item_key
                   LIMIT ? OFFSET ?`,
      )
        .bind(...binds, size, (page - 1) * size)
        .all<{
          item_key: string;
          rank: number;
          score: number;
          tier: string;
          name: string;
          url: string | null;
          cats: string | null;
          card: string | null;
        }>(),
      def.doingStatuses?.length
        ? c.env.DB.prepare(
            /* 必须用子查询把范围收回到本页：doers 表只增不减，全表聚合
               是「请求只要 50 个数字，却读了整表」——翻一页扫一遍，用户多了就是上万行。
               子查询走 idx_listed_rank 只取本页 key，外层再按 slug 点查。 */
            `SELECT opportunity_slug AS slug, COUNT(*) AS n
               FROM opportunity_doers
              WHERE status IN (${def.doingStatuses.map(() => "?").join(",")})
                AND opportunity_slug IN (
                  SELECT item_key FROM board_listed
                   WHERE ${scope}
                   /* 与主查询同序同 tie-breaker：两个分页必须选出完全相同的行，
                      否则 doing 数字会对到相邻的条目上（机会榜各批次 rank 会重复） */
                   ORDER BY rank, item_key LIMIT ? OFFSET ?
                )
              GROUP BY opportunity_slug`,
          )
            .bind(...def.doingStatuses, ...binds, size, (page - 1) * size)
            .all<{ slug: string; n: number }>()
        : Promise.resolve({ results: [] as Array<{ slug: string; n: number }> }),
    ]);

    const doing = new Map<string, number>();
    for (const r of doingRows.results ?? []) doing.set(r.slug, r.n);

    const total = countRow?.n ?? 0;
    return c.json({
      version,
      page,
      size,
      total,
      pages: Math.max(1, Math.ceil(total / size)),
      batch: batch || null,
      q: q || null,
      items: (rows.results ?? []).map((r) => ({
        key: r.item_key,
        rank: r.rank,
        score: r.score,
        tier: r.tier,
        name: r.name,
        url: r.url,
        cats: parseCats(r.cats),
        card: parseJson(r.card),
        ...(def.doingStatuses ? { doing: doing.get(r.item_key) ?? 0 } : {}),
      })),
    });
  });

  /**
   * 机会榜的批次清单，供筛选下拉。
   *
   * 读 board_listed.batch 列（0024），不碰 card：分组直接沿
   * idx_listed_batch (version, board, batch) 有序扫，不回表也不排序。
   * 以前每行都 json_extract 一次几 KB 的卡片 —— 机会榜 5 行无感，
   * 但这个路由是六个榜共用的，模型榜 366 行、GitHub 榜 1500 行
   * 一旦调它就是上万次解析。
   */
  routes.get("/batches", async (c) => {
    const version = await currentVersion(c.env.DB);
    if (!version) return c.json({ version: null, batches: [] });

    const { results } = await c.env.DB.prepare(
      `SELECT batch, COUNT(*) AS n
         FROM board_listed
        WHERE version = ? AND board = ? AND batch IS NOT NULL
        GROUP BY batch
        ORDER BY batch DESC`,
    )
      .bind(version, def.board)
      .all<{ batch: string | null; n: number }>();

    return c.json({
      version,
      batches: (results ?? [])
        .filter((r): r is { batch: string; n: number } => Boolean(r.batch))
        .map((r) => ({ batch: r.batch, count: r.n })),
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

/**
 * 机会榜：按周批次生成 + 人工预览确认，发布靠 publish-opps-batch.yml。
 *
 * 生成走 generate-opps.yml：只写候选池（board_items），线上文件一个字不动。
 * 所以「生成 — 预览 — 发布」三步里，前两步出任何问题都不会影响前台。
 */
export const opps = makeRoutes({
  board: "opps",
  workflow: "publish-opps.yml",
  kindPrefix: "opps",
  /* 这一列读 opportunity_doers：doing 在做 + shipped 已上线，paused/dropped 不算 */
  doingStatuses: ["doing", "shipped"],
});

/* ==================== 机会榜：批次生成 / 预览 / 拒绝补位 ==================== */

const OPP_BATCH_RE = /^\d{4}-W\d{2}$/;
/** 线上每批固定 5 条 */
const OPP_BATCH_SIZE = 5;
const OPP_MODEL = "deepseek-flash";

/**
 * 某批次的可发布条数、已拒绝条数、已废弃条数。
 *
 * 一条语句出三个数：以前是两条 COUNT，每条都得把该批次的候选读一遍
 * （`status<>'rejected'` 是不等式，索引也帮不上），一个 /staging 请求
 * 就扫两遍。0023 之后走 idx_items_batch，只碰这 5 行。
 * kept 只算「活着可发布」的：拒绝与整批废弃都不算。
 */
async function batchCounts(
  db: D1Database,
  batch: string,
): Promise<{ kept: number; rejected: number; discarded: number }> {
  const row = await db
    .prepare(
      `SELECT SUM(CASE WHEN status NOT IN ('rejected','discarded') THEN 1 ELSE 0 END) AS kept,
              SUM(CASE WHEN status  = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN status  = 'discarded' THEN 1 ELSE 0 END) AS discarded
         FROM board_items
        WHERE board = 'opps' AND batch = ?`,
    )
    .bind(batch)
    .first<{ kept: number | null; rejected: number | null; discarded: number | null }>();
  return {
    kept: row?.kept ?? 0,
    rejected: row?.rejected ?? 0,
    discarded: row?.discarded ?? 0,
  };
}

/** 该批次的候选（预览页用），已拒绝的单独返回，方便页面灰显 */
opps.get("/staging", async (c) => {
  const batch = (c.req.query("batch") ?? "").trim();
  if (!OPP_BATCH_RE.test(batch)) {
    return c.json({ error: "bad_batch", detail: "批次号形如 2026-W47" }, 400);
  }

  /* batch 下推到 SQL（0023）：以前是读整个候选池再在 JS 里 filter，
     20 秒轮询一次就是一次全池读，历史批次与被拒绝行的卡片全白读。 */
  const ws = await listWorkspace<Record<string, unknown> & { batch?: string }>(
    c.env.DB,
    "opps",
    batch,
  );
  const items = ws.items;
  const counts = await batchCounts(c.env.DB, batch);

  return c.json({
    batch,
    size: OPP_BATCH_SIZE,
    ...counts,
    ready: counts.kept === OPP_BATCH_SIZE,
    items,
  });
});

/**
 * 废弃整批：把该批次所有「还活着」的候选（连同已拒绝的）标记为 discarded。
 * discarded 不参与发布、不进预览，也不计 kept —— /generate 判断 kept>0 就拦，
 * 所以废弃后同批次可以重新生成。
 * 已 published 的行不动：它们是发布后的历史记录，不在候选池语义内。
 */
opps.post("/discard", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { batch?: string };
  const batch = (body?.batch ?? "").trim();
  if (!OPP_BATCH_RE.test(batch)) {
    return c.json({ error: "bad_batch", detail: `批次号形如 2026-W47，收到「${batch}」` }, 400);
  }

  const res = await c.env.DB.prepare(
    "UPDATE board_items SET status='discarded', updated_at=? " +
      "WHERE board='opps' AND batch=? AND status NOT IN ('published','discarded')",
  )
    .bind(Date.now(), batch)
    .run();
  const changed = res.meta?.changes ?? 0;

  const counts = await batchCounts(c.env.DB, batch);
  return c.json({ ok: true, batch, changed, ...counts });
});

/** 生成（或补位）：派发生成流水线，产物进候选池等预览 */
opps.post("/generate", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  const batch = (body?.batch ?? "").trim();
  if (!OPP_BATCH_RE.test(batch)) {
    return c.json({ error: "bad_batch", detail: "批次号形如 2026-W47" }, 400);
  }

  const counts = await batchCounts(c.env.DB, batch);
  if (counts.kept > 0) {
    return c.json(
      {
        error: "batch_exists",
        detail: `批次 ${batch} 已有 ${counts.kept} 条候选，直接在其中拒绝/发布即可`,
        kept: counts.kept,
      },
      409,
    );
  }

  /* 废弃/已拒批次重新生成：先清掉旧行，避免新旧候选混在同一批次里 */
  if (counts.discarded > 0 || counts.rejected > 0) {
    await c.env.DB.prepare(
      "DELETE FROM board_items WHERE board='opps' AND batch=? AND status IN ('rejected','discarded')",
    )
      .bind(batch)
      .run();
  }

  try {
    const run = await dispatchWorkflow(cfg, "generate-opps.yml", {
      batch,
      fill: "false",
      reason: "",
      exclude: "",
      count: String(OPP_BATCH_SIZE),
      model: OPP_MODEL,
    });
    await insertJob(c.env, "opps-generate", { batch }, run, null).catch(() => {});
    return c.json({ ok: true, batch, count: OPP_BATCH_SIZE, run: run ? { id: run.id, url: run.html_url } : null });
  } catch (e) {
    return c.json({ error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/**
 * 拒绝一条：先标记，再按缺口自动补生成。
 *
 * 补位与生成走同一条流水线，靠 count 控制补几条 —— 连拒 2 条就补 2 条，
 * 保证预览区始终朝 5 条收敛。
 */
opps.post("/reject", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    batch?: string;
    slug?: string;
    reason?: string;
  } | null;
  const batch = (body?.batch ?? "").trim();
  const slug = (body?.slug ?? "").trim();
  if (!OPP_BATCH_RE.test(batch) || !slug) {
    return c.json({ error: "bad_request", detail: "需要 batch 与 slug" }, 400);
  }

  const hit = await setItemStatus(c.env.DB, "opps", slug, "rejected");
  if (!hit) return c.json({ error: "not_found", detail: `候选池里没有 ${slug}` }, 404);

  const counts = await batchCounts(c.env.DB, batch);
  const missing = Math.max(0, OPP_BATCH_SIZE - counts.kept);

  let run: { id: number; url: string } | null = null;
  const cfg = ghConfig(c.env);
  if (missing > 0 && cfg) {
    try {
      const dispatched = await dispatchWorkflow(cfg, "generate-opps.yml", {
        batch,
        fill: "true",
        /* 拒绝原因回传给模型，避免补上来的还是同一个毛病 */
        reason: (body?.reason ?? "").slice(0, 300),
        exclude: slug,
        count: String(missing),
        model: OPP_MODEL,
      });
      await insertJob(c.env, "opps-refill", { batch, missing, reason: body?.reason ?? "" }, dispatched, null).catch(
        () => {},
      );
      run = dispatched ? { id: dispatched.id, url: dispatched.html_url } : null;
    } catch (e) {
      return c.json(
        { ok: true, kept: counts.kept, missing, refillError: e instanceof Error ? e.message : String(e) },
        200,
      );
    }
  }

  return c.json({ ok: true, kept: counts.kept, rejected: counts.rejected, missing, run });
});

/** 发布：候选正好 5 条才允许，门槛与发布脚本一致 */
opps.post("/publish-batch", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

  const body = (await c.req.json().catch(() => null)) as { batch?: string } | null;
  const batch = (body?.batch ?? "").trim();
  if (!OPP_BATCH_RE.test(batch)) {
    return c.json({ error: "bad_batch", detail: "批次号形如 2026-W47" }, 400);
  }

  const counts = await batchCounts(c.env.DB, batch);
  if (counts.kept !== OPP_BATCH_SIZE) {
    return c.json(
      {
        error: "not_ready",
        detail: `当前 ${counts.kept} 条，需要正好 ${OPP_BATCH_SIZE} 条${
          counts.rejected ? `（已拒绝 ${counts.rejected} 条，等补位完成）` : ""
        }`,
        kept: counts.kept,
      },
      409,
    );
  }

  try {
    const run = await dispatchWorkflow(cfg, "publish-opps-batch.yml", { batch });
    await insertJob(c.env, "opps-publish-batch", { batch }, run, null).catch(() => {});
    return c.json({ ok: true, batch, run: run ? { id: run.id, url: run.html_url } : null });
  } catch (e) {
    return c.json({ error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
  }
});