/**
 * 后台「模型榜」「机会榜」。
 *
 * 这两个榜没有候选池，所以后台不需要审核表：
 *   - 模型榜由 `pnpm collect` 采集 `content/models.json` 后整榜发布；
 *   - 机会榜是人工策展文件，改完直接同步。
 *
 * 因此本页签只做三件事：看线上当前是什么、触发一次同步、确认跑完没有。
 * 数据全部读 D1 的 board_listed（当前生效版本），不回落到仓库文件。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { dispatchWorkflow, ghConfig, latestRun, mapStatus, missingSecrets } from "../lib/github";
import { currentVersion, listReleased } from "../lib/versions";

const MAX_PAGE_SIZE = 100;

interface Def {
  board: "models" | "opps";
  /** 触发同步用的 workflow 文件名；null 表示还没有流水线 */
  workflow: string | null;
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

  /** 概览：当前版本、在榜条数、最近一次同步 */
  routes.get("/overview", async (c) => {
    const cfg = ghConfig(c.env);
    const missing = missingSecrets(c.env);
    const [version, stats, run] = await Promise.all([
      currentVersion(c.env.DB),
      c.env.DB.prepare("SELECT total, updated_at FROM board_stats WHERE board = ?")
        .bind(def.board)
        .first<{ total: number; updated_at: string | null }>(),
      // 运行状态读不到只影响这一行，不能让整页失败
      cfg && def.workflow ? latestRun(cfg, def.workflow).catch(() => null) : Promise.resolve(null),
    ]);

    return c.json({
      board: def.board,
      configured: Boolean(cfg),
      missing,
      publishable: Boolean(def.workflow),
      version,
      total: stats?.total ?? 0,
      updatedAt: stats?.updated_at ?? null,
      status: mapStatus(run, "idle"),
      run: run ? { id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion } : null,
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

  /** 触发同步：把仓库里的榜单文件写进 D1 */
  routes.post("/publish", async (c) => {
    if (!def.workflow) {
      return c.json({ error: "no_workflow", detail: "这个榜还没有流水线，只能本地跑脚本" }, 409);
    }

    const cfg = ghConfig(c.env);
    if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 400);

    try {
      const run = await dispatchWorkflow(cfg, def.workflow, {});
      return c.json({ ok: true, run: run ? { id: run.id, url: run.html_url } : null });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return c.json({ error: "dispatch_failed", detail }, 502);
    }
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

/** 模型榜：采集在本地 / CI 跑，发布靠 publish-models.yml */
export const models = makeRoutes({ board: "models", workflow: "publish-models.yml" });

/** 机会榜：人工策展，发布靠 publish-opps.yml */
export const opps = makeRoutes({ board: "opps", workflow: "publish-opps.yml" });