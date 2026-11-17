/**
 * 发布一个榜到 D1 —— 六个榜共用的一条流水线。
 *
 * 原子性从哪来（重要，别被"没有事务"吓到）：
 *   数据分三批写（卡片 / 详情 / 名单），中途失败会留下半成品。
 *   但半成品的 `version` 是新版本号，而 `app_config.config.current_version`
 *   仍然指着旧版本 —— 线上读者根本看不到它。最后一步切指针是单条 UPDATE，
 *   本身即原子。所以「要么全成要么全不成」由版本机制保证，不需要 DB 事务。
 *
 * 重跑安全性：
 *   所有写入都是 UPSERT；开写前先清掉该版本的残留行（防上次中途失败留下的
 *   多余条目）。因此同一版本号可以反复重跑直到成功。
 *
 * 不允许重发当前生效版本：
 *   那会先删空、再逐批写回，中间有几十秒读者看到空榜。要用新版本号。
 */

import {
  KEEP_VERSIONS,
  buildUpsert,
  byteLength,
  chunkForSpec,
  type Board,
  type UpsertSpec,
} from "@horizons/shared";
import type { D1Client } from "./d1-client";

/** D1 单行上限 1 MB，留 10% 余量给编码开销 */
const MAX_ROW_BYTES = 900 * 1024;

export interface PublishRow {
  /** 榜单内唯一键，如域名 / owner/repo */
  key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string | null;
  cats: string[] | null;
  /** 卡片 JSON：锁定态可见的全部内容 */
  card: unknown;
  /** 详情 JSON：付费墙后的完整内容 */
  detail: unknown;
  /**
   * 别名指向的代表词 key（只有趋势词榜用）。
   *
   * 别名要上线（/trends/<slug> 得能打开），但**不占名次**：
   * rank 继承代表词，不进 board_release_items，也不算进/出榜。
   * 其余五个榜没有这个概念，恒为空。
   */
  variantOf?: string | null;
}

export interface PublishInput {
  board: Board;
  version: string;
  rows: readonly PublishRow[];
  /** 谁触发的，进审计 */
  actor: string;
  /** 这期的免费名单快照 */
  allowlist?: readonly string[];
  /** 上期名次，用于生成 board_changes；不传则跳过审计 */
  previous?: readonly { key: string; rank: number }[];
}

export interface PublishResult {
  version: string;
  board: Board;
  /** 上榜条数 */
  listed: number;
  entered: number;
  exited: number;
  up: number;
  down: number;
  /** 同版本已生效，本次直接跳过（内容没变，不算失败） */
  skipped?: boolean;
}

const LISTED_SPEC: UpsertSpec = {
  table: "board_listed",
  columns: ["version", "board", "item_key", "rank", "score", "tier", "name", "url", "cats", "card", "variant_of"],
  conflict: ["version", "board", "item_key"],
};

const DETAIL_SPEC: UpsertSpec = {
  table: "board_listed_details",
  columns: ["version", "board", "item_key", "detail"],
  conflict: ["version", "board", "item_key"],
};

const ITEMS_SPEC: UpsertSpec = {
  table: "board_release_items",
  columns: ["version", "board", "item_key", "rank", "tier", "name"],
  conflict: ["version", "board", "item_key"],
};

/**
 * board_changes 只有自增 id 主键，没有业务唯一键 —— 不能 UPSERT，只能纯 INSERT。
 * 重复发布靠开头的 DELETE 清理，而不是 ON CONFLICT。
 */
const CHANGES_SPEC: UpsertSpec = {
  table: "board_changes",
  columns: ["version", "board", "item_key", "action", "diff", "applied", "actor", "created_at"],
};

/**
 * 写库前的体积检查，两道闸。
 *
 * 1. **D1 单行上限**（绝对）：超了任何通道都写不进去，必须缩短长文本。
 * 2. **通道的语句上限**（相对）：REST 的参数是绑定的，SQL 文本只有
 *    `VALUES (?,?),…`，值多大都不影响语句长度；CLI 通道要把值内联进 SQL，
 *    立刻撞上 D1 的 100KB/语句限制 —— github 的 detail 单行最大 427KB，
 *    在这种通道下根本写不了。
 *
 * 按 UTF-8 字节算：中文一个字符占 3 字节，用 `.length` 会低估到三分之一。
 */
function assertRowsFit(
  board: Board,
  rows: readonly PublishRow[],
  statementLimit: number,
): void {
  for (const r of rows) {
    for (const [label, value] of [
      ["card", r.card],
      ["detail", r.detail],
    ] as const) {
      const size = byteLength(value);

      if (size > MAX_ROW_BYTES) {
        throw new Error(
          `[${board}] ${r.key} 的 ${label} 有 ${(size / 1024).toFixed(0)}KB，超过 D1 单行 1MB 限制。` +
            `请缩短它的长文本字段（readme 等）后再发布。`,
        );
      }

      if (statementLimit > 0 && size > statementLimit) {
        throw new Error(
          `[${board}] ${r.key} 的 ${label} 有 ${Math.round(size / 1024)}KB，` +
            `超过当前 D1 通道的单语句上限 ${Math.round(statementLimit / 1024)}KB。\n` +
            `本地 wrangler 通道要把值内联进 SQL，而 D1 限 100KB/语句；` +
            `配置 CLOUDFLARE_API_TOKEN 走 REST 通道即可（参数绑定不计入语句长度），` +
            `或把该榜详情外置到 R2。`,
        );
      }
    }
  }
}

interface ChangeRow extends ReadonlyArray<unknown> {}

/** 对比上期，算出 add / drop / update 三类变更 */
function diffRanks(
  input: PublishInput,
  now: number,
): { rows: ChangeRow[]; entered: number; exited: number; up: number; down: number } {
  const prev = new Map((input.previous ?? []).map((p) => [p.key, p.rank]));
  /*
   * 别名不占名次，必须排除在增减统计之外：
   * 它们的 rank 是继承代表词的，混进来会每个别名都记一条 add/update，
   * 后台「新进榜 120 个」——而实际上榜的还是那 367 个词。
   */
  const next = new Map(input.rows.filter((r) => !r.variantOf).map((r) => [r.key, r]));
  const rows: ChangeRow[] = [];

  let entered = 0;
  let exited = 0;
  let up = 0;
  let down = 0;

  for (const [key, row] of next) {
    const from = prev.get(key);
    if (from === undefined) {
      entered++;
      rows.push([input.version, input.board, key, "add", null, 0, input.actor, now]);
      continue;
    }
    if (from !== row.rank) {
      if (row.rank < from) up++;
      else down++;
      rows.push([
        input.version,
        input.board,
        key,
        "update",
        JSON.stringify({ rank: { from, to: row.rank } }),
        0,
        input.actor,
        now,
      ]);
    }
  }

  for (const key of prev.keys()) {
    if (next.has(key)) continue;
    exited++;
    rows.push([input.version, input.board, key, "drop", null, 0, input.actor, now]);
  }

  return { rows, entered, exited, up, down };
}

export async function publishBoard(
  client: D1Client,
  input: PublishInput,
): Promise<PublishResult> {
  const { board, version, rows } = input;
  const now = Date.now();

  if (rows.length === 0) throw new Error("没有可发布的行，拒绝写入空榜");

  // 放在最前面：后面的 DELETE / 建版本已经开始写库，到那时再失败会留下中间状态
  assertRowsFit(board, rows, client.statementByteLimit);

  /* 0) 当前生效版本不能重发：会先删空再写回，中间读者看到空榜 */
  const current = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
  );
  const currentVersion = current.results[0]?.val ?? null;
  if (currentVersion === version) {
    /*
     * 同一版本号重发会先把本期数据删空再造 —— 中间那段读者是看得见的空榜。
     * 但**不能只看版本号**：版本是全局快照，同一时刻另一个榜可能刚发布了
     * 这个版本号，此时本榜在这个版本里一行都没有。直接跳过就等于把这次的
     * 数据丢了，而且不报错。
     *
     * 所以先确认「本榜在这个版本里确实已有数据」，才认定是重发。
     */
    const existing = await client.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
      [version, board],
    );
    const alreadyListed = existing.results[0]?.n ?? 0;

    if (alreadyListed > 0) {
      /*
       * 返回结果对象而不是抛错：内容没变是**正常情况**
       * （采集跑完数据没更新、定时任务同一天跑两次），抛错会让上游
       * 每次都记一条失败告警，真实的故障反而被淹没。
       */
      return {
        version,
        board,
        listed: rows.length,
        entered: 0,
        exited: 0,
        up: 0,
        down: 0,
        skipped: true,
      };
    }

    // 版本号撞车但本榜是空的：指针已经指向这个版本，只能往里补数据
    console.log(`[publish] 版本 ${version} 已被其他榜占用，本榜数据补写进同一版本`);
  }

  /* 1) 登记版本（applied=0，此时读者不可见） */
  await client.query(
    `INSERT INTO board_releases (version, board_scope, stats, allowlist, actor, applied, created_at)
     VALUES (?, ?, '{}', ?, ?, 0, ?)
     ON CONFLICT (version) DO UPDATE SET
       board_scope = excluded.board_scope,
       allowlist   = excluded.allowlist,
       actor       = excluded.actor`,
    [
      version,
      JSON.stringify([board]),
      JSON.stringify(input.allowlist ?? []),
      input.actor,
      now,
    ],
  );

  /* 2) 清掉该版本残留（上次中途失败留下的），保证重跑结果收敛 */
  await client.run([
    {
      sql: "DELETE FROM board_listed_details WHERE version = ? AND board = ?",
      params: [version, board],
    },
    {
      sql: "DELETE FROM board_listed WHERE version = ? AND board = ?",
      params: [version, board],
    },
    {
      sql: "DELETE FROM board_changes WHERE version = ? AND board = ?",
      params: [version, board],
    },
  ]);

  /**
   * 2.5) 继承上期其余榜。
   *
   * `version` 是**全局快照**：读取时永远是
   * `WHERE version = (SELECT config.current_version) AND board = ?`。
   * 而六个榜的更新节奏完全不同（github 每天、models 每周、opps 每周）。
   *
   * 如果本次只写 github 就切指针，其他五个榜在新版本里一行都没有 ——
   * 读者刷新一下，五个榜全空。所以新版本必须自带其余榜的完整数据。
   *
   * 用 INSERT ... SELECT 在库内搬，不走网络：1500 行也是毫秒级，
   * 且 SQL 文本本身很短，不触 D1 的单语句大小限制。
   */
  if (currentVersion && currentVersion !== version) {
    await client.run([
      {
        sql: `INSERT INTO board_listed
                (version, board, item_key, rank, score, tier, name, url, cats, card, variant_of)
              SELECT ?, board, item_key, rank, score, tier, name, url, cats, card, variant_of
              FROM board_listed WHERE version = ? AND board != ?
              ON CONFLICT (version, board, item_key) DO NOTHING`,
        params: [version, currentVersion, board],
      },
      {
        sql: `INSERT INTO board_listed_details (version, board, item_key, detail)
              SELECT ?, board, item_key, detail
              FROM board_listed_details WHERE version = ? AND board != ?
              ON CONFLICT (version, board, item_key) DO NOTHING`,
        params: [version, currentVersion, board],
      },
      {
        sql: `INSERT INTO board_release_items (version, board, item_key, rank, tier, name)
              SELECT ?, board, item_key, rank, tier, name
              FROM board_release_items WHERE version = ? AND board != ?
              ON CONFLICT (version, board, item_key) DO NOTHING`,
        params: [version, currentVersion, board],
      },
    ]);
  }

  /* 3) 卡片：查询永远只碰这张表，必须小 */
  const cardRows = rows.map((r) => [
    version,
    board,
    r.key,
    r.rank,
    r.score,
    r.tier,
    r.name,
    r.url,
    r.cats && r.cats.length > 0 ? JSON.stringify(r.cats) : null,
    JSON.stringify(r.card),
    r.variantOf ?? null,
  ]);
  await client.batch(
    chunkForSpec(LISTED_SPEC, cardRows, client.statementByteLimit).map((part) => buildUpsert(LISTED_SPEC, part)),
  );

  /* 4) 详情：体积差异极大（24KB 中位、421KB 最大），按字节分块 */
  const detailRows = rows.map((r) => [
    version,
    board,
    r.key,
    JSON.stringify(r.detail),
  ]);
  await client.batch(
    chunkForSpec(DETAIL_SPEC, detailRows, client.statementByteLimit).map((part) => buildUpsert(DETAIL_SPEC, part)),
  );

  /* 5) 永久名单：只存 key+rank+name，回答「上期第 37 名是谁」。
   * 别名不进：名单是名次表，下次发布要用它算进出榜基准。 */
  const itemRows = rows.filter((r) => !r.variantOf).map((r) => [version, board, r.key, r.rank, r.tier, r.name]);
  await client.batch(
    chunkForSpec(ITEMS_SPEC, itemRows, client.statementByteLimit).map((part) => buildUpsert(ITEMS_SPEC, part)),
  );

  /* 6) 变更审计 */
  const changes = diffRanks(input, now);
  await client.batch(
    chunkForSpec(CHANGES_SPEC, changes.rows, client.statementByteLimit).map((part) => buildUpsert(CHANGES_SPEC, part)),
  );

  /* 7) 回填统计并标记生效（数据已全，但指针还没动） */
  // stats / board_scope 都按本版本实际含有的榜来写，继承来的榜也要算进去，
  // 否则后台会以为这个版本只有 github 一个榜
  const counts = await client.query<{ board: string; n: number }>(
    "SELECT board, COUNT(*) AS n FROM board_listed WHERE version = ? GROUP BY board",
    [version],
  );
  const stats = Object.fromEntries(counts.results.map((r) => [r.board, r.n]));
  const scope = counts.results.map((r) => r.board);

  await client.query(
    "UPDATE board_releases SET stats = ?, board_scope = ?, applied = 1 WHERE version = ?",
    [JSON.stringify(stats), JSON.stringify(scope), version],
  );
  await client.query("UPDATE board_changes SET applied = 1 WHERE version = ? AND board = ?", [
    version,
    board,
  ]);

  /* 8) 切指针 —— 唯一真正原子的一步，也是唯一对外可见的瞬间 */
  await client.query(
    `INSERT INTO app_config (key, val, updated_at) VALUES ('config.current_version', ?, ?)
     ON CONFLICT (key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    [version, now],
  );

  return {
    version,
    board,
    listed: rows.length,
    entered: changes.entered,
    exited: changes.exited,
    up: changes.up,
    down: changes.down,
  };
}

/**
 * 取上一次已生效发布的名次表，用于生成本期 board_changes。
 *
 * 从 D1 读而不是从 JSON 读：JSON 里的顺序不一定是上次发布时的顺序
 * （人工调过、或中间失败过），而 D1 里的是真正对读者生效过的那一版。
 * 首次发布时返回空数组，全部记为 add。
 */
export async function lastReleaseRanks(
  client: D1Client,
  board: Board,
): Promise<{ key: string; rank: number }[]> {
  /*
   * 基准必须是**当前生效版本**，不是「最新的已生效版本」。
   *
   * 回滚之后这两者会分叉：v3 是最新的 applied=1，但指针指向 v2。
   * 此时拿 v3 的名次去比，算出来的进出名单和读者实际看到的对不上，
   * 变更记录也就成了假的。
   */
  const cur = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
  );
  const version = cur.results[0]?.val;
  if (!version) return [];

  const res = await client.query<{ item_key: string; rank: number }>(
    "SELECT item_key, rank FROM board_release_items WHERE board = ? AND version = ?",
    [board, version],
  );
  return res.results.map((r) => ({ key: r.item_key, rank: r.rank }));
}

/**
 * 清理旧版本：只保留最近 keep 期**已生效**的版本。
 *
 * 草稿（applied=0）不占名额也不被删 —— 运营准备好的下期数据不能因为
 * 一次无关发布就被清空。
 */
export async function pruneVersions(client: D1Client, keep = KEEP_VERSIONS): Promise<string[]> {
  const alive = await client.query<{ version: string }>(
    `SELECT version FROM board_releases
     WHERE applied = 1 ORDER BY created_at DESC LIMIT ?`,
    [keep],
  );
  const keepList = alive.results.map((r) => r.version);
  if (keepList.length < keep) return [];

  /*
   * 当前生效版本无论如何都不删。
   *
   * 正常流程里 prune 只在指针切到新版本之后调用，current 必然在 keepList 内；
   * 但回滚之后 current 可能是个更老的版本 —— 只要有人把 prune 挪到别的位置
   * （或者将来做「只清理不回滚」的任务），就会把线上正在读的那一版删掉，
   * 表现为全站榜单瞬间变空。这里显式保护一次，成本是一次查询。
   */
  const cur = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
  );
  const currentVersion = cur.results[0]?.val;
  if (currentVersion && !keepList.includes(currentVersion)) keepList.push(currentVersion);

  const ph = keepList.map(() => "?").join(", ");
  const doomed = await client.query<{ version: string }>(
    `SELECT version FROM board_releases
     WHERE applied = 1 AND version NOT IN (${ph})`,
    keepList,
  );

  const list = doomed.results.map((r) => r.version);
  if (list.length === 0) return [];

  const marks = list.map(() => "?").join(", ");
  await client.run([
    { sql: `DELETE FROM board_listed_details WHERE version IN (${marks})`, params: list },
    { sql: `DELETE FROM board_listed WHERE version IN (${marks})`, params: list },
  ]);

  return list;
}