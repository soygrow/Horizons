/**
 * 后台「榜单版本」。
 *
 * 六个榜都发布到 D1 之后，这里是唯二的观察与回滚入口（另一个是 wrangler 命令行）。
 * 灰度期站点仍读 JSON，所以这个页面的作用是**核对**：
 * 每期是不是真的写全了、哪些条目进出了、某个榜是不是漏发了。
 *
 * 设计取舍：
 * - 只读为主，唯一的写操作是「回滚」和「切换数据源」，两个都是出故障时才用的开关。
 * - 回滚只切指针，不重写数据 —— 版本数据是不可变的，改数据会让审计失去意义。
 * - 版本是全局快照，所以「某版本有哪些榜」以 board_scope 为准，不是以本次发布为准。
 */
import { Hono } from "hono";
import { BOARDS, BOARD_LABELS, type Board } from "@horizons/shared";
import type { Env } from "../env";
import { readConfigs, writeConfig } from "../lib/db";
import {
  KEEP_VERSIONS,
  assertVersionUsable,
  currentVersion,
  listReleased,
  newVersion,
  pruneVersions,
  rollbackTo,
} from "../lib/versions";

export const adminBoards = new Hono<{ Bindings: Env }>();

const MAX_PAGE_SIZE = 100;
const MAX_VERSIONS = 50;

interface ReleaseRow {
  version: string;
  board_scope: string | null;
  stats: string | null;
  allowlist: string | null;
  actor: string | null;
  applied: number;
  created_at: number;
}

/** 库里存的是 JSON 文本，坏数据不能让整页 500，统一走这个降级解析 */
function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const val: unknown = JSON.parse(raw);
    return Array.isArray(val) ? val.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const val: unknown = JSON.parse(raw);
    if (!val || typeof val !== "object" || Array.isArray(val)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(val)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 卡片是 JSON 文本，列表页需要的是对象 */
function parseCard(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/* --------------------------------- 版本列表 --------------------------------- */

adminBoards.get("/releases", async (c) => {
  const db = c.env.DB;
  const current = await currentVersion(db);

  const { results } = await db
    .prepare(
      `SELECT version, board_scope, stats, allowlist, actor, applied, created_at
       FROM board_releases
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .bind(MAX_VERSIONS)
    .all<ReleaseRow>();

  return c.json({
    current,
    keep: KEEP_VERSIONS,
    releases: (results ?? []).map((r) => ({
      version: r.version,
      scope: parseJsonArray(r.board_scope),
      stats: parseJsonObject(r.stats),
      allowlistSize: parseJsonArray(r.allowlist).length,
      actor: r.actor,
      applied: Boolean(r.applied),
      createdAt: r.created_at,
      isCurrent: r.version === current,
    })),
  });
});

/* ------------------------------- 某个版本某榜 ------------------------------- */

adminBoards.get("/releases/:version/items", async (c) => {
  const version = c.req.param("version");
  const board = c.req.query("board") ?? "";

  if (!(BOARDS as readonly string[]).includes(board)) {
    return c.json({ error: "unknown_board", boards: BOARDS }, 400);
  }

  const page = clampInt(c.req.query("page"), 1, 1, Number.MAX_SAFE_INTEGER);
  const size = clampInt(c.req.query("size"), 50, 1, MAX_PAGE_SIZE);

  const rows = await listReleased(c.env.DB, board as Board, version, size, (page - 1) * size);

  return c.json({
    version,
    board,
    page,
    size,
    // 卡片里已经剔除了 readme / pageStructure / series 这类大字段，可以直接下发
    items: rows.map((r) => ({
      key: r.item_key,
      rank: r.rank,
      score: r.score,
      tier: r.tier,
      name: r.name,
      url: r.url,
      cats: r.cats ? parseJsonArray(r.cats) : [],
      card: parseCard(r.card),
    })),
  });
});

/* --------------------------------- 变更记录 --------------------------------- */

adminBoards.get("/releases/:version/changes", async (c) => {
  const version = c.req.param("version");
  const board = c.req.query("board") ?? "";
  if (board && !(BOARDS as readonly string[]).includes(board)) {
    return c.json({ error: "unknown_board", boards: BOARDS }, 400);
  }

  const size = clampInt(c.req.query("size"), 200, 1, MAX_PAGE_SIZE * 2);

  const base = "SELECT board, item_key, action, diff, actor FROM board_changes WHERE version = ?";
  const stmt = board
    ? c.env.DB.prepare(`${base} AND board = ? ORDER BY board, item_key LIMIT ?`).bind(
        version,
        board,
        size,
      )
    : c.env.DB.prepare(`${base} ORDER BY board, item_key LIMIT ?`).bind(version, size);

  const { results } = await stmt.all<{
    board: string;
    item_key: string;
    action: string;
    diff: string | null;
    actor: string | null;
  }>();

  return c.json({
    version,
    changes: (results ?? []).map((r) => ({
      board: r.board,
      key: r.item_key,
      action: r.action,
      diff: parseCard(r.diff),
      actor: r.actor,
    })),
  });
});

/* --------------------------------- 数据源开关 -------------------------------- */

/** 六个榜各自读 JSON 还是读 D1。切错了会让线上某榜空白，所以写接口只接受两个值 */
adminBoards.get("/sources", async (c) => {
  const keys = BOARDS.map((b) => `data_source.${b}`);
  const [map, cur] = await Promise.all([
    readConfigs(c.env.DB, keys),
    currentVersion(c.env.DB),
  ]);

  /*
   * 库内真实行数。
   *
   * board_stats 里的 total 是「发布时写进去的统计」，和 board_listed 实际有几行
   * 可能是两回事（回填过统计但没发布过榜单就会出现这种偏差），
   * 而切换校验只看 board_listed —— 把真实行数摆出来，才不会盲点一下才发现切不动。
   */
  const counts = new Map<string, number>();
  if (cur) {
    const { results } = await c.env.DB.prepare(
      "SELECT board, COUNT(*) AS n FROM board_listed WHERE version = ? GROUP BY board",
    )
      .bind(cur)
      .all<{ board: string; n: number }>();
    for (const r of results ?? []) counts.set(r.board, r.n);
  }

  return c.json({
    version: cur,
    sources: BOARDS.map((b) => ({
      board: b,
      label: BOARD_LABELS[b],
      source: map.get(`data_source.${b}`) === "d1" ? "d1" : "file",
      /** 当前版本里这个榜实际有几行；0 表示切到 d1 会让线上变空榜 */
      rows: counts.get(b) ?? 0,
    })),
  });
});

adminBoards.post("/sources", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    board?: unknown;
    source?: unknown;
  } | null;

  const board = typeof body?.board === "string" ? body.board : "";
  const source = typeof body?.source === "string" ? body.source : "";

  if (!(BOARDS as readonly string[]).includes(board)) {
    return c.json({ error: "unknown_board", boards: BOARDS }, 400);
  }
  if (source !== "file" && source !== "d1") {
    return c.json({ error: "unknown_source", allowed: ["file", "d1"] }, 400);
  }

  // 切到 d1 前先确认真的有数据，否则线上会立刻变成空榜
  if (source === "d1") {
    const cur = await currentVersion(c.env.DB);
    if (!cur) return c.json({ error: "no_current_version" }, 409);
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
    )
      .bind(cur, board)
      .first<{ n: number }>();
    if (!row || row.n === 0) {
      return c.json({ error: "no_data_for_board", version: cur, board }, 409);
    }
  }

  await writeConfig(c.env.DB, `data_source.${board}`, source);
  return c.json({ ok: true, board, source });
});

/* -------------------------------- 全量重建版本 -------------------------------- */

/**
 * 把某个版本的整张表复制到新版本号下。
 *
 * 列清单从库里探（`SELECT *` 取一行），不在这里硬编码：`board_listed` 后来陆续
 * 加过 cats / card / variant_of 和几个冗余列，硬编码的话每加一列都得回来改这里，
 * 忘了就是静默丢数据。
 */
async function copyVersionTable(
  db: D1Database,
  table: string,
  from: string,
  to: string,
): Promise<D1PreparedStatement | null> {
  const sample = await db
    .prepare(`SELECT * FROM ${table} WHERE version = ? LIMIT 1`)
    .bind(from)
    .first<Record<string, unknown>>();
  if (!sample) return null;

  const cols = Object.keys(sample).filter((k) => k !== "version");
  if (cols.length === 0) return null;

  const list = cols.map((k) => `"${k}"`).join(", ");
  return db
    .prepare(`INSERT INTO ${table} (version, ${list}) SELECT ?, ${list} FROM ${table} WHERE version = ?`)
    .bind(to, from);
}

/**
 * 全量发布：把当前生效版本里**六个榜的全部数据**原样固化成一个新版本。
 *
 * 为什么不「把六条发布流水线都按 --full 跑一遍」：
 * - 数据已经在库里，重跑只是把同一份内容再写一遍，还得先把六个榜 hydrate 回文件；
 * - 六个脚本各生成一个版本号，会连建六版、互相继承六次，写量放大好几倍；
 * - 一条 `INSERT ... SELECT` 就能把整版搬到新版本号下，几步放在同一个 batch 里，
 *   全成功或全回滚，不会留下「切了指针但数据不全」的版本。
 *
 * 与增量发布的关系：日常的增量只改变化的行、不推进版本号，所以版本列表会停住。
 * 定期在这里拍一次完整快照，等于给全部榜单留一个可回滚的基线，顺便剪掉最老的版本。
 *
 * 写量约等于库里六个榜的总行数（当前约 7.6 千行），D1 免费版每天 10 万行 ——
 * 一天点十几次都撑得住，但没必要，一周一次足够。
 */
adminBoards.post("/rebuild", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;

  /*
   * 防误触：前端要手打确认词才发得出来，这里再挡一次。
   * 一次误点是近八千行写入，而且会把版本号推上去，回滚也回不到这一版之前。
   */
  if (body?.confirm !== "FULL") {
    return c.json({ error: "confirm_required", detail: "全量发布需要显式确认" }, 400);
  }

  const from = await currentVersion(c.env.DB);
  if (!from) {
    return c.json({ error: "no_version", detail: "库里还没有任何版本，先完整发布一次" }, 400);
  }

  const release = await c.env.DB.prepare(
    "SELECT board_scope FROM board_releases WHERE version = ? AND applied = 1",
  )
    .bind(from)
    .first<{ board_scope: string | null }>();
  if (!release) {
    return c.json({ error: "no_release", detail: `当前版本 ${from} 没有发布记录` }, 409);
  }

  const now = Date.now();
  const to = newVersion(now);

  /*
   * 版本号是 UTC 秒精度：连点两次很容易落在同一秒。直接拒绝让操作员等一秒，
   * 比自动加后缀好 —— 版本号是全局排序键，加后缀会把排序和「同一期」的判断搅乱。
   */
  if (to === from) {
    return c.json({ error: "version_collision", detail: "与当前版本同一秒，稍等一秒再试" }, 409);
  }

  const stmts: D1PreparedStatement[] = [];
  /* 名次表、详情、永久名单都要搬；board_changes 不搬 —— 新版本没有发生变更 */
  for (const table of ["board_listed", "board_listed_details", "board_release_items"]) {
    const stmt = await copyVersionTable(c.env.DB, table, from, to);
    if (stmt) stmts.push(stmt);
  }
  if (stmts.length === 0) {
    return c.json({ error: "empty_version", detail: `版本 ${from} 里没有数据` }, 409);
  }

  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO board_releases (version, board_scope, stats, allowlist, actor, applied, created_at)
       SELECT ?, board_scope, stats, allowlist, ?, 1, ? FROM board_releases WHERE version = ?`,
    ).bind(to, "admin-rebuild", now, from),
    /* 与 switchVersion 保持一致：新版本没有变更记录，这句是给同版本遗留 pending 行兜底 */
    c.env.DB.prepare("UPDATE board_changes SET applied = 1 WHERE version = ?").bind(to),
    c.env.DB.prepare(
      `INSERT INTO app_config (key, val, updated_at) VALUES ('config.current_version', ?, ?)
       ON CONFLICT (key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    ).bind(to, now),
  );

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    return c.json(
      { error: "rebuild_failed", detail: e instanceof Error ? e.message : String(e) },
      500,
    );
  }

  const pruned = await pruneVersions(c.env.DB).catch(() => [] as string[]);
  /*
   * pruneVersions 只清数据不清发布记录，版本列表里会留下点进去全空的壳。
   * 历史发布攒下来的空壳尤其碍眼（点开一个空版本像是在看故障），这里一并清掉。
   * 只删「已应用 + 没有名次表数据 + 不是当前版本」的，不碰发布中的记录。
   */
  const swept = await c.env.DB.prepare(
    `DELETE FROM board_releases
      WHERE applied = 1
        AND version <> ?
        AND NOT EXISTS (SELECT 1 FROM board_listed l WHERE l.version = board_releases.version)`,
  )
    .bind(to)
    .run()
    .then((r) => r.meta.changes)
    .catch(() => 0);

  return c.json({ ok: true, from, to, pruned, swept });
});

/* ----------------------------------- 回滚 ----------------------------------- */

adminBoards.post("/rollback", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
  const version = typeof body?.version === "string" ? body.version.trim() : "";
  if (!version) return c.json({ error: "version_required" }, 400);

  try {
    await assertVersionUsable(c.env.DB, version);
  } catch (e) {
    // 数据已被清理的历史版本不能回滚 —— 指针指过去就是全站空白
    return c.json({ error: "version_not_available", version, detail: String(e) }, 409);
  }

  const before = await currentVersion(c.env.DB);
  await rollbackTo(c.env.DB, version);

  return c.json({ ok: true, from: before, to: version });
});