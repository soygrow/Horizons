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
  const map = await readConfigs(c.env.DB, keys);

  return c.json({
    sources: BOARDS.map((b) => ({
      board: b,
      label: BOARD_LABELS[b],
      source: map.get(`data_source.${b}`) === "d1" ? "d1" : "file",
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