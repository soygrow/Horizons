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
 *
 * `$.lastCrawledAt` 是 GitHub 列还没写时的兜底：卡片里本来就带着这个字段，
 * 一旦哪次发布把 last_crawled_at 写丢了（例如搬其余榜的行时漏列），
 * 这里仍然能算出真实的数据截止日，而不是让版本号顶替成发布日。
 */
const DATA_AT_EXPR =
  "MAX(COALESCE(last_crawled_at, json_extract(card, '$.lastCrawledAt'), json_extract(card, '$.dataAt'), json_extract(card, '$.updatedAt'), json_extract(card, '$.lastSeenAt')))";

/** 同一套回落顺序，但不带 MAX —— 按行分组时每一行要算自己的日期 */
const DATA_AT_ROW_EXPR =
  "COALESCE(last_crawled_at, json_extract(card, '$.lastCrawledAt'), json_extract(card, '$.dataAt'), json_extract(card, '$.updatedAt'), json_extract(card, '$.lastSeenAt'))";

/**
 * 该榜库里还留着哪些版本（倒序）。
 *
 * 后台的版本切换器就靠它 —— 只列真的还有数据的版本：
 * pruneVersions 只留最近 KEEP_VERSIONS 期，更早的行已经删了，
 * 列出来点进去只会是一张空表。
 */
export async function listBoardVersions(db: D1Database, board: Board): Promise<VersionOption[]> {
  /*
   * 先读物化表（0022）：发布时就把「这版多少条、数据截止到哪天」写进去了。
   *
   * 不读 board_listed 的原因：`WHERE board = ?` 撞不上任何索引（主键和
   * idx_listed_rank 都以 version 打头），每条语句都是全表扫 + 每行
   * json_extract(card)。后台每打开一次榜单就扫一遍 10k 行，一天几十万。
   */
  const { results } = await db
    .prepare(
      `SELECT version, total AS n, data_at
       FROM board_version_index
       WHERE board = ?
       ORDER BY version DESC`,
    )
    .bind(board)
    .all<{ version: string; n: number; data_at: string | null }>();
  if (results && results.length > 0) {
    /*
     * 物化表和「当前生效版本」对不上，说明这张表不是最新一次发布写的
     * （发布脚本还是旧版、或发布中途失败）。这时候宁可慢一点扫全表，
     * 也不能让版本下拉缺掉正在看的那一版。
     */
    const cur = await currentVersion(db);
    if (!cur || results.some((r) => r.version === cur)) {
      return results.map((r) => ({ version: r.version, count: r.n, dataAt: r.data_at ?? null }));
    }
  }

  /* 物化表还没回填（迁移后第一次、或新建库）：回落扫一遍，宁可慢也不能让下拉空着 */
  const fallback = await db
    .prepare(
      `SELECT version, COUNT(*) AS n, ${DATA_AT_EXPR} AS data_at
       FROM board_listed
       WHERE board = ?
       GROUP BY version
       ORDER BY version DESC`,
    )
    .bind(board)
    .all<{ version: string; n: number; data_at: string | null }>();
  return (fallback.results ?? []).map((r) => ({
    version: r.version,
    count: r.n,
    dataAt: r.data_at ?? null,
  }));
}

/** 「某一天采了多少条」 */
export interface DataDayOption {
  /** YYYY-MM-DD */
  day: string;
  count: number;
}

/**
 * 当前版本内部，按**行级数据日**分组各有多少条。
 *
 * 版本号筛选不能按 `version` 分组：那是「哪次发布」，同一个快照会被
 * 搬进下一版，于是三个版本各显示 370 条、加起来 1106 —— 比总数还多。
 * 按行分组才对得上：每个模型只属于一个日期，各天条数之和恒等于总数，
 * 而且行内「更新时间」显示的也是这个日期，选哪天就全是哪天。
 */
export async function listDataDays(
  db: D1Database,
  board: Board,
  version: string,
): Promise<DataDayOption[]> {
  /*
   * 读真列 data_day（0022 加的）：idx_listed_day (version, board, data_day)
   * 是覆盖索引，分组只扫索引不回表 —— 1500 行从「索引+回表 3000 行」降到 1500。
   * 原来是逐行 json_extract(card)，每行都要把 1–3KB 的卡片读出来。
   */
  const { results } = await db
    .prepare(
      `SELECT data_day AS day, COUNT(*) AS n
       FROM board_listed
       WHERE version = ? AND board = ? AND data_day IS NOT NULL
       GROUP BY data_day
       ORDER BY data_day DESC`,
    )
    .bind(version, board)
    .all<{ day: string | null; n: number }>();
  const rows = (results ?? []).filter(
    (r): r is { day: string; n: number } => typeof r.day === "string" && r.day.length >= 10,
  );
  if (rows.length > 0) return rows.map((r) => ({ day: r.day, count: r.n }));

  /* data_day 还没回填：回落逐行算，保证下拉有数 */
  const fallback = await db
    .prepare(
      `SELECT substr(${DATA_AT_ROW_EXPR}, 1, 10) AS day, COUNT(*) AS n
       FROM board_listed
       WHERE version = ? AND board = ?
       GROUP BY day
       ORDER BY day DESC`,
    )
    .bind(version, board)
    .all<{ day: string | null; n: number }>();
  return (fallback.results ?? [])
    .filter((r): r is { day: string; n: number } => typeof r.day === "string" && r.day.length >= 10)
    .map((r) => ({ day: r.day, count: r.n }));
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

/**
 * 旧版本清理：只保留最近 keep 期**已生效**的版本 + 清掉废弃草稿，返回被删的版本号。
 *
 * 草稿（applied=0）原来不清理，理由是「运营准备好的下期数据不能被无关发布清空」。
 * 但没有任何地方真的去丢草稿：11-10 那四个发布中途失败留下的草稿，
 * 到 11-20 还躺在 board_listed 里占 2,358 行（全库 23%），
 * 每次全表扫、每次版本下拉都带着它们。所以加一条 24 小时超时：
 * 开着超过一天还没生效的，就是废弃的，连发布记录一起删。
 */
export async function pruneVersions(
  db: D1Database,
  keep = KEEP_VERSIONS,
  now = Date.now(),
): Promise<string[]> {
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

  /* 超出保留名额的已生效版本：只删数据行，board_release_items（永久名单）保留 */
  const doomed = await db
    .prepare(
      `SELECT version FROM board_releases
       WHERE applied = 1 AND version NOT IN (${placeholders})`,
    )
    .bind(...keepList)
    .all<{ version: string }>();

  const expiredList = (doomed.results ?? []).map((r) => r.version);

  /* 废弃草稿：开版超过 24h 仍未生效。正常发布几分钟就切指针，留一天足够宽 */
  const stale = await db
    .prepare(
      `SELECT version FROM board_releases
       WHERE applied = 0 AND created_at < ?`,
    )
    .bind(now - 24 * 60 * 60 * 1000)
    .all<{ version: string }>();

  const draftList = (stale.results ?? []).map((r) => r.version);

  const doomedList = [...expiredList, ...draftList];
  if (doomedList.length === 0) return [];

  const ph = doomedList.map(() => "?").join(", ");
  const stmts = [
    db.prepare(`DELETE FROM board_listed_details WHERE version IN (${ph})`).bind(...doomedList),
    db.prepare(`DELETE FROM board_listed WHERE version IN (${ph})`).bind(...doomedList),
    db.prepare(`DELETE FROM board_version_index WHERE version IN (${ph})`).bind(...doomedList),
  ];

  /* 草稿从未上线：发布记录、审计、名单都是半截数据，一并清掉 */
  if (draftList.length > 0) {
    const dph = draftList.map(() => "?").join(", ");
    stmts.push(
      db.prepare(`DELETE FROM board_changes WHERE version IN (${dph})`).bind(...draftList),
      db.prepare(`DELETE FROM board_release_items WHERE version IN (${dph})`).bind(...draftList),
      db.prepare(`DELETE FROM board_releases WHERE version IN (${dph})`).bind(...draftList),
    );
  }

  await db.batch(stmts);

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