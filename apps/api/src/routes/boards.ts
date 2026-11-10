/**
 * 榜单公开接口：按需查询某一期的条目。
 *
 * 存在的理由有两个：
 *
 * 1. **体积**。`content/dist/github/index.json` 有 7.2MB，列表页只显示 20 条，
 *    其余全是白传。走接口后首屏只拿当前页。
 * 2. **付费墙**。详情页要按条目鉴权，必须有「按 key 取一条」的服务端入口 —— 
 *    静态 JSON 做不到。
 *
 * 与后台 `/api/admin/boards` 的区别：这里只读、只返回当前生效版本，
 * 不暴露历史版本、不暴露变更记录、不接受写入。
 *
 * 数据源开关（`data_source.<board>`）没切到 `d1` 时，接口返回 409 并带
 * `source: "file"` —— 前端据此回退到静态 JSON，切流过程中两条路径并存。
 */
import { Hono } from "hono";
import { isBoard } from "@horizons/shared";
import type { Env } from "../env";
import { currentVersion, resolveSource } from "../lib/versions";

const boards = new Hono<{ Bindings: Env }>();

/** 单页条数上限。列表页每页 20，留出筛选组件一次取多的余地 */
const MAX_PAGE_SIZE = 100;

const DEFAULT_PAGE_SIZE = 20;

/** 排序只开放三种，全部是固定 SQL 片段，不接受任何拼接 */
const ORDER_BY: Record<string, string> = {
  rank: "rank ASC",
  score: "score DESC, rank ASC",
  name: "name ASC",
};

type ListedRow = {
  item_key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string;
  cats: string | null;
  card: string | null;
};

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** 坏 JSON 一律降级为 null / []，绝不让一条脏数据把整页打成 500 */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/* -------------------------------- 元信息 -------------------------------- */

boards.get("/:board", async (c) => {
  const board = c.req.param("board");
  if (!isBoard(board)) return c.json({ error: "unknown_board" }, 400);

  const source = await resolveSource(c.env.DB, board);
  const version = await currentVersion(c.env.DB);

  let total = 0;
  if (version) {
    const row = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
    )
      .bind(version, board)
      .first<{ n: number }>();
    total = row?.n ?? 0;
  }

  // 短缓存：切流或发布之后最多 30 秒就能看到新数据，不值得为它做失效逻辑
  c.header("Cache-Control", "public, max-age=30");
  return c.json({ board, source, version, total });
});

/* --------------------------------- 条目 --------------------------------- */

boards.get("/:board/items", async (c) => {
  const board = c.req.param("board");
  if (!isBoard(board)) return c.json({ error: "unknown_board" }, 400);

  const source = await resolveSource(c.env.DB, board);
  const version = await currentVersion(c.env.DB);

  /*
   * 没切流 / 库里没这一期：明确告诉调用方「去读 JSON」，
   * 而不是返回一个空数组 —— 空数组在前端等价于「这个榜是空的」，
   * 会把一次配置缺失渲染成线上空榜。
   */
  if (source !== "d1" || !version) {
    return c.json({ board, source, error: "source_is_file" }, 409);
  }

  const q = (c.req.query("q") ?? "").trim().slice(0, 64);
  const cat = (c.req.query("cat") ?? "").trim().slice(0, 64);
  const tier = (c.req.query("tier") ?? "").trim();
  const sort = ORDER_BY[c.req.query("sort") ?? "rank"] ?? ORDER_BY.rank;
  const page = clampInt(c.req.query("page"), 1, 1, 10_000);
  const size = clampInt(c.req.query("size"), DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  const where: string[] = ["version = ?", "board = ?"];
  const params: unknown[] = [version, board];

  if (q) {
    // 只搜有索引的两列；描述在 card JSON 里，全表 json_extract 代价太高
    where.push("(name LIKE ? OR url LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (cat) {
    // cats 存的是 JSON 数组字符串，用带引号的片段匹配避免 "Video" 命中 "Video Gen"
    where.push("cats LIKE ?");
    params.push(`%"${cat}"%`);
  }
  if (tier === "core" || tier === "watch") {
    where.push("tier = ?");
    params.push(tier);
  }

  const clause = where.join(" AND ");

  const [countRow, listed] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM board_listed WHERE ${clause}`)
      .bind(...params)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT item_key, rank, score, tier, name, url, cats, card
         FROM board_listed WHERE ${clause} ORDER BY ${sort} LIMIT ? OFFSET ?`,
    )
      .bind(...params, size, (page - 1) * size)
      .all<ListedRow>(),
  ]);

  const total = countRow?.n ?? 0;

  c.header("Cache-Control", "public, max-age=30");
  return c.json({
    board,
    source,
    version,
    total,
    page,
    size,
    pages: Math.max(1, Math.ceil(total / size)),
    items: (listed.results ?? []).map((r) => ({
      key: r.item_key,
      rank: r.rank,
      score: r.score,
      tier: r.tier,
      name: r.name,
      url: r.url,
      cats: parseJson<string[]>(r.cats, []),
      // card 已经是「列表可见字段」的快照，前端直接拿去渲染，不再二次拼装
      card: parseJson<Record<string, unknown> | null>(r.card, null),
    })),
  });
});

export { boards as publicBoards };