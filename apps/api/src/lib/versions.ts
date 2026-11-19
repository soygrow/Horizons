/**
 * 版本管理：已发布数据的唯一入口。
 *
 * 三个概念必须分清楚：
 *
 * | 层 | 表 | 保留 | 用途 |
 * |---|---|---|---|
 * | 数据 | board_listed / board_listed_details | 最近 3 期 | 回滚后能打开完整页面 |
 * | 名单 | board_release_items | 永久 | 查「上期第 37 名叫什么」 |
 * | 审计 | board_changes | 永久 | 谁在哪一期改了什么 |
 *
 * 所有读取都必须经过 `currentVersion()` 拿到指针，不允许直接查 board_listed 不带版本。
 */

import { BOARDS, KEEP_VERSIONS, type Board } from "@horizons/shared";
import { readConfig, writeConfig } from "./db";

export type { Board };
export { BOARDS, KEEP_VERSIONS };

// ── 读 ───────────────────────────────────────────────────────────

/** 当前生效版本。从未发布过返回 null */
export async function currentVersion(db: D1Database): Promise<string | null> {
  const val = await readConfig(db, "config.current_version");
  return val && val.length > 0 ? val : null;
}

/** 库里的一个历史版本 + 该版本这个榜有多少条 */
export interface VersionOption {
  version: string;
  count: number;
  /**
   * 该版数据里最新的一条是什么时候更新的（日期或 ISO 时间），拿不到是 null。
   *
   * 版本号本身是**发布时间**，两者经常对不上：GitHub 采集停在 10-30，
   * 之后每天照常发版，版本号一路 11-18、11-19，点进去每行都写着 10-30。
   * 后台的版本号按这个字段的日期显示，才和列表里的「更新时间」是一回事。
   */
  dataAt: string | null;
}

/**
 * 「这版数据截止到哪天」取哪个字段。按来源各取各的：
 *
 * - GitHub：整列 last_crawled_at
 * - 趋势榜：卡片里的 updatedAt / lastSeenAt
 * - 模型榜：卡片里的 dataAt（发布时从 models.json 的采集日写进去，
 *   卡片没有逐条时间，一版共用一个）
 *
 * 都取不到才是 null，后台就回落到发布日。
 */
const DATA_AT_EXPR =
  "MAX(COALESCE(last_crawled_at, json_extract(card, '$.dataAt'), json_extract(card, '$.updatedAt'), json_extract(card, '$.lastSeenAt')))";

/**
 * 该榜库里还留着哪些版本（倒序）。
 *
 * 后台的版本切换器就靠它 —— 只列真的还有数据的版本：
 * pruneVersions 只留最近 KEEP_VERSIONS 期，更早的行已经删了，
 * 列出来点进去只会是一张空表。
 */
export async function listBoardVersions(db: D1Database, board: Board): Promise<VersionOption[]> {
  const { results } = await db
    .prepare(
      `SELECT version, COUNT(*) AS n, ${DATA_AT_EXPR} AS data_at
       FROM board_listed
       WHERE board = ?
       GROUP BY version
       ORDER BY version DESC`,
    )
    .bind(board)
    .all<{ version: string; n: number; data_at: string | null }>();
  return (results ?? []).map((r) => ({ version: r.version, count: r.n, dataAt: r.data_at ?? null }));
}

/**
 * 解析后台传来的「看哪一版」。
 *
 * 只认清单里真实存在的版本：页面开着的时候旧版本可能被清理掉，
 * 或者 URL 里塞了个瞎编的字符串 —— 这两种情况都回落到当前生效版本，
 * 而不是查出一张空表让人以为数据没了。
 */
export async function resolveListedVersion(
  db: D1Database,
  board: Board,
  want?: string | null,
): Promise<{ version: string | null; current: string | null; versions: VersionOption[] }> {
  const [current, versions] = await Promise.all([currentVersion(db), listBoardVersions(db, board)]);
  const picked = want && versions.some((v) => v.version === want) ? want : current;
  return { version: picked, current, versions };
}

/**
 * 该榜现在读哪儿。
 *
 * 迁移期六个榜是逐个切过去的，所以每次读取都要先问这一句。
 * **读失败回落到 file**（有数据总比 500 好）——注意这和 allowlist 的回落方向相反，
 * allowlist 读失败必须回落到「全锁」。
 */
export async function resolveSource(db: D1Database, board: Board): Promise<"d1" | "file"> {
  const val = await readConfig(db, `data_source.${board}`);
  return val === "d1" ? "d1" : "file";
}

export interface ReleasedItem {
  board: string;
  item_key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string | null;
  cats: string | null;
  card: string | null;
}

/** 读某版某榜的卡片列表。不返回 detail —— 列表页永远不碰 30KB 的大字段 */
export async function listReleased(
  db: D1Database,
  board: Board,
  version: string,
  limit: number,
  offset = 0,
): Promise<ReleasedItem[]> {
  const { results } = await db
    .prepare(
      `SELECT board, item_key, rank, score, tier, name, url, cats, card
       FROM board_listed
       WHERE version = ? AND board = ?
       ORDER BY rank
       LIMIT ? OFFSET ?`,
    )
    .bind(version, board, limit, offset)
    .all<ReleasedItem>();
  return results ?? [];
}

/** 读单条详情。只有 FULL 分支可以调它，LOCKED 分支不得触达 */
export async function getReleasedDetail(
  db: D1Database,
  board: Board,
  version: string,
  itemKey: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT detail FROM board_listed_details
       WHERE version = ? AND board = ? AND item_key = ?`,
    )
    .bind(version, board, itemKey)
    .first<{ detail: string }>();
  return row?.detail ?? null;
}

/** 查历史名单：任何一期都查得到，永不删除 */
export async function getReleaseItems(
  db: D1Database,
  board: Board,
  version: string,
): Promise<Array<{ item_key: string; rank: number; tier: string | null; name: string }>> {
  const { results } = await db
    .prepare(
      `SELECT item_key, rank, tier, name FROM board_release_items
       WHERE version = ? AND board = ? ORDER BY rank`,
    )
    .bind(version, board)
    .all<{ item_key: string; rank: number; tier: string | null; name: string }>();
  return results ?? [];
}

// ── 写 ───────────────────────────────────────────────────────────

/**
 * 版本号：UTC 秒精度，形如 2026-11-10T12:00:05。
 *
 * 与脚本侧 `versionOf()` 保持同一格式 —— 两个入口（后台手改、采集脚本）
 * 生成的版本号必须是同一种，否则排序和去重会各说各话。
 */
export function newVersion(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 19);
}

/**
 * 切换版本。三句必须同属一个 batch —— D1 没有交互式事务，
 * 分开写会留下「applied 已置 1 但指针未切」的脏状态，清理逻辑会误把它当有效版本。
 */
export async function switchVersion(db: D1Database, version: string, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare("UPDATE board_releases SET applied = 1 WHERE version = ?").bind(version),
    db.prepare("UPDATE board_changes  SET applied = 1 WHERE version = ?").bind(version),
    // 用 UPSERT 而不是 UPDATE：行被误删时 UPDATE 影响 0 行且不报错，
    // 指针会静默停在旧值，数据写进去了却永远不可见。
    db
      .prepare(
        `INSERT INTO app_config (key, val, updated_at) VALUES ('config.current_version', ?, ?)
         ON CONFLICT (key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
      )
      .bind(version, now),
  ]);
}

/**
 * 回滚前校验：目标版本必须有数据。
 * 指针指向空版本会让整个站点 500，而且此时改回来也救不回已经看到的错误页。
 */
export async function assertVersionUsable(db: D1Database, version: string): Promise<void> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM board_listed WHERE version = ?")
    .bind(version)
    .first<{ n: number }>();
  if (!row || row.n === 0) {
    throw new Error(`version_not_available: ${version} 没有数据，可能是已被清理的历史版本`);
  }
}

/** 旧版本清理：只保留最近 keep 期**已生效**的版本，返回被删的版本号 */
export async function pruneVersions(db: D1Database, keep = KEEP_VERSIONS): Promise<string[]> {
  const alive = await db
    .prepare(
      `SELECT version FROM board_releases
       WHERE applied = 1 ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(keep)
    .all<{ version: string }>();

  const keepList = (alive.results ?? []).map((r) => r.version);
  if (keepList.length === 0) return [];

  const placeholders = keepList.map(() => "?").join(", ");

  // 草稿版本（applied=0）不参与存活名额，也不在这里清理 —— 它们由后台显式丢弃
  const doomed = await db
    .prepare(
      `SELECT version FROM board_releases
       WHERE applied = 1 AND version NOT IN (${placeholders})`,
    )
    .bind(...keepList)
    .all<{ version: string }>();

  const doomedList = (doomed.results ?? []).map((r) => r.version);
  if (doomedList.length === 0) return [];

  const ph = doomedList.map(() => "?").join(", ");
  await db.batch([
    db.prepare(`DELETE FROM board_listed_details WHERE version IN (${ph})`).bind(...doomedList),
    db.prepare(`DELETE FROM board_listed WHERE version IN (${ph})`).bind(...doomedList),
  ]);

  return doomedList;
}

/** 确保 release 记录存在（发布第一步就写，applied 保持 0） */
export async function openRelease(
  db: D1Database,
  version: string,
  boardScope: readonly Board[],
  allowlist: unknown,
  actor: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO board_releases
         (version, board_scope, stats, allowlist, actor, applied, created_at)
       VALUES (?, ?, '{}', ?, ?, 0, ?)
       ON CONFLICT (version) DO NOTHING`,
    )
    .bind(version, JSON.stringify(boardScope), JSON.stringify(allowlist ?? []), actor, now)
    .run();
}

/** 发布完成后回填各榜条数 */
export async function closeReleaseStats(
  db: D1Database,
  version: string,
  stats: Record<string, number>,
): Promise<void> {
  await db
    .prepare("UPDATE board_releases SET stats = ? WHERE version = ?")
    .bind(JSON.stringify(stats), version)
    .run();
}

/** 手动回滚：先校验再切，两步不能省 */
export async function rollbackTo(db: D1Database, version: string, now = Date.now()): Promise<void> {
  await assertVersionUsable(db, version);
  await writeConfig(db, "config.current_version", version, now);
}