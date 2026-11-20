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
  columns: [
    "version",
    "board",
    "item_key",
    "rank",
    "score",
    "tier",
    "name",
    "url",
    "cats",
    "card",
    "variant_of",
    /* 0021：被后台/列表反复查询的标量，从 card JSON 里提成列，查询不再解析大字段 */
    "stars",
    "forks",
    "language",
    "description",
    "pushed_at",
    "last_crawled_at",
    "grade",
  ],
  conflict: ["version", "board", "item_key"],
};

const DETAIL_SPEC: UpsertSpec = {
  table: "board_listed_details",
  columns: ["version", "board", "item_key", "detail", "bytes"],
  conflict: ["version", "board", "item_key"],
};

/**
 * 发布时可以丢掉的详情字段。
 *
 * readme 占 github detail 的 74.8%（33.5MB / 59MB），而它只在采集期生成中文情报
 * 时用（产物是 insight），构建侧 `web-data.mjs` 一进来就把它删掉。
 * 留在发布快照里等于每次构建都从 D1 搬 33MB 无用数据。
 *
 * 原文不会丢：工作区 board_item_details（和 R2 的 raw 快照）是采集侧的完整数据。
 * 需要全文时从那里取，不要指望发布快照。
 */
const SLIM_FIELDS: Partial<Record<Board, readonly string[]>> = {
  github: ["readme"],
};

export function slimDetail(board: Board, detail: unknown): unknown {
  const drop = SLIM_FIELDS[board];
  if (!drop || !detail || typeof detail !== "object") return detail;
  const copy = { ...(detail as Record<string, unknown>) };
  for (const k of drop) delete copy[k];
  return copy;
}

/** 某个榜要从 card 里提成列的标量；没有就是 7 个 null（顺序同 LISTED_SPEC 尾部） */
export function cardColumns(board: Board, card: unknown): Array<string | number | null> {
  if (board !== "github") return [null, null, null, null, null, null, null];
  const c = (card ?? {}) as Record<string, unknown>;
  const num = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  const score = (c.productScore ?? {}) as Record<string, unknown>;
  return [
    num(c.stars),
    num(c.forks),
    str(c.language),
    str(c.description),
    str(c.pushedAt),
    str(c.lastCrawledAt),
    str(score.grade),
  ];
}

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
      /* 按真正写下去的体积检查：瘦身后的 detail 才是占空间的 */
      ["detail", slimDetail(board, r.detail)],
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
   *
   * 列必须写全：漏一列就是「新版本里其余榜全变 NULL」。0021 的七个标量
   * 尤其致命 —— last_crawled_at 一丢，后台算不出该版数据的截止日，
   * 版本号回落到发布日，和列表里的「更新时间」直接对不上；stars 一丢，
   * 第 1 名可能显示 0 星。details 的 bytes 同理（体积汇总靠它）。
   * 以后给 LISTED_SPEC / DETAIL_SPEC 加列，这里同步加。
   */
  if (currentVersion && currentVersion !== version) {
    await client.run([
      {
        sql: `INSERT INTO board_listed
                (version, board, item_key, rank, score, tier, name, url, cats, card, variant_of,
                 stars, forks, language, description, pushed_at, last_crawled_at, grade)
              SELECT ?, board, item_key, rank, score, tier, name, url, cats, card, variant_of,
                 stars, forks, language, description, pushed_at, last_crawled_at, grade
              FROM board_listed WHERE version = ? AND board != ?
              ON CONFLICT (version, board, item_key) DO NOTHING`,
        params: [version, currentVersion, board],
      },
      {
        sql: `INSERT INTO board_listed_details (version, board, item_key, detail, bytes)
              SELECT ?, board, item_key, detail, bytes
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
    ...cardColumns(board, r.card),
  ]);
  await client.batch(
    chunkForSpec(LISTED_SPEC, cardRows, client.statementByteLimit).map((part) => buildUpsert(LISTED_SPEC, part)),
  );

  /* 4) 详情：先瘦身（github 去掉 readme），再写 —— 体积直接决定构建要搬多少字节 */
  const detailRows = rows.map((r) => {
    const detail = JSON.stringify(slimDetail(board, r.detail));
    return [version, board, r.key, detail, byteLength(detail)];
  });
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

/* -------------------------- 增量发布（原地 patch） -------------------------- */

/**
 * 增量发布：在**当前生效版本**上原地改掉真正变了的行。
 *
 * 为什么需要它：
 *   完整发布（publishBoard）是「新建全局版本 + 继承其余五个榜 + 本榜全量写」，
 *   一次 github 级别的发布约 2.3 万 rows_written，再加剪枝 1.5 万，
 *   而免费版每天只有 10 万。运营批量刷新 30 条数据也要付这份全量代价。
 *
 * 这里只做三件事：插入新增行、更新变化行、删除下榜行。
 * 同一批 30 条的刷新降到几百次写（差多少写多少）。
 *
 * 代价（用之前必须知道）：
 *   1. **不产生新版本**：指针原地不动，后台「版本列表/回滚」回不到这次之前。
 *      需要留快照的重大改版（新增大量条目、换口径）仍应走完整发布。
 *   2. **不是全有或全无**：写入分批提交，中途失败会留下部分更新的线上数据。
 *      所有语句都是 UPSERT / 按 key DELETE，重跑一次即收敛。
 *   3. `board_releases.stats` 仍是这个版本创建时的条数，`board_stats` 会更新。
 *
 * 触发方式：**默认就是它**（scripts/admin/board-sync.ts 读 argv，或 SyncOptions.patch）。
 * 需要完整发布时显式加 `--full`。
 */
export interface PatchInput {
  board: Board;
  /** 整榜行（脚本传的本来就是全量），只写与库里不同的那部分 */
  rows: readonly PublishRow[];
  actor: string;
  /**
   * 允许条数明显下降。
   *
   * 默认拒绝：如果调用方误传了一个局部列表（比如只传 30 条），
   * 增量逻辑会把其余 170 条当成下榜全部删掉，线上瞬间少一大半。
   */
  allowShrink?: boolean;
}

export interface PatchResult {
  version: string;
  board: Board;
  /** 更新后在榜条数 */
  listed: number;
  inserted: number;
  updated: number;
  dropped: number;
  /** 与库里逐字段一致、一行没写的条数 */
  unchanged: number;
}

interface ListedSnapshot {
  item_key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string | null;
  cats: string | null;
  card: string | null;
  variant_of: string | null;
}

/** 条数安全阀：新数据比库里少这么多就拒绝（与 hydrate-tools 的 MIN_RATIO 同口径） */
const PATCH_MIN_RATIO = 0.9;

/** 删除语句里一次带多少个 key（避免 SQL 过长、参数过多） */
const DELETE_KEYS_PER_STATEMENT = 200;

function chunkKeys<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function patchBoard(client: D1Client, input: PatchInput): Promise<PatchResult> {
  const { board, rows, actor } = input;
  const now = Date.now();

  if (rows.length === 0) throw new Error("没有可发布的行，拒绝写入空榜");

  const cur = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
  );
  const version = cur.results[0]?.val;
  if (!version) {
    throw new Error("库里还没有任何生效版本，无法增量发布。先跑一次完整发布（--full）。");
  }

  /*
   * 只读「卡片 + 详情字节数」，不读详情正文。
   *
   * 卡片是详情的裁剪版，卡片变了必然要写；卡片没变但正文改了的情况，
   * 由 0021 的 `bytes` 列兜住（写库时算好，比对时只读这个整数）——
   * 长文本改动几乎不可能长度分毫不差。
   */
  const listed = await client.query<ListedSnapshot>(
    `SELECT item_key, rank, score, tier, name, url, cats, card, variant_of
     FROM board_listed WHERE version = ? AND board = ?`,
    [version, board],
  );
  const sizes = await client.query<{ item_key: string; n: number | null }>(
    `SELECT item_key, bytes AS n
     FROM board_listed_details WHERE version = ? AND board = ?`,
    [version, board],
  );

  const prevRows = new Map(listed.results.map((r) => [r.item_key, r]));
  const prevSize = new Map(sizes.results.map((r) => [r.item_key, r.n]));

  if (!input.allowShrink && prevRows.size > 0 && rows.length < prevRows.size * PATCH_MIN_RATIO) {
    throw new Error(
      `[${board}] 本次只有 ${rows.length} 条，当前版本在榜 ${prevRows.size} 条，` +
        `按增量发布会把其余 ${prevRows.size - rows.length} 条当作下榜删掉。\n` +
        `确实要缩减请加 --allow-shrink；只是发了局部数据请传整榜。`,
    );
  }

  const nextKeys = new Set(rows.map((r) => r.key));
  const toWrite: PublishRow[] = [];
  const dropped: string[] = [];
  let unchanged = 0;

  for (const r of rows) {
    const old = prevRows.get(r.key);
    if (!old) {
      toWrite.push(r);
      continue;
    }

    const cats = r.cats && r.cats.length > 0 ? JSON.stringify(r.cats) : null;
    /* 老行的 bytes 为空（0021 之前写的），视为「变了」重写一次，顺手补上 */
    const nextBytes = byteLength(JSON.stringify(slimDetail(board, r.detail)));
    const same =
      old.rank === r.rank &&
      Math.abs(old.score - r.score) < 1e-9 &&
      old.tier === r.tier &&
      old.name === r.name &&
      (old.url ?? null) === (r.url ?? null) &&
      (old.cats ?? null) === cats &&
      (old.variant_of ?? null) === (r.variantOf ?? null) &&
      old.card === JSON.stringify(r.card) &&
      prevSize.get(r.key) === nextBytes;

    if (same) unchanged++;
    else toWrite.push(r);
  }

  for (const key of prevRows.keys()) {
    if (!nextKeys.has(key)) dropped.push(key);
  }

  const inserted = toWrite.filter((r) => !prevRows.has(r.key)).length;
  const updated = toWrite.length - inserted;

  // 体积检查只针对真正要写下去的行
  assertRowsFit(board, toWrite, client.statementByteLimit);

  /* 1) 新增 + 变化行：UPSERT 三张表，写法与完整发布完全一致 */
  if (toWrite.length > 0) {
    const cardRows = toWrite.map((r) => [
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
      ...cardColumns(board, r.card),
    ]);
    await client.batch(
      chunkForSpec(LISTED_SPEC, cardRows, client.statementByteLimit).map((part) =>
        buildUpsert(LISTED_SPEC, part),
      ),
    );

    const detailRows = toWrite.map((r) => {
      const detail = JSON.stringify(slimDetail(board, r.detail));
      return [version, board, r.key, detail, byteLength(detail)];
    });
    await client.batch(
      chunkForSpec(DETAIL_SPEC, detailRows, client.statementByteLimit).map((part) =>
        buildUpsert(DETAIL_SPEC, part),
      ),
    );

    const itemRows = toWrite
      .filter((r) => !r.variantOf)
      .map((r) => [version, board, r.key, r.rank, r.tier, r.name]);
    await client.batch(
      chunkForSpec(ITEMS_SPEC, itemRows, client.statementByteLimit).map((part) =>
        buildUpsert(ITEMS_SPEC, part),
      ),
    );
  }

  /* 2) 下榜：按 key 删三张表（board_release_items 也要删，否则下期名次基准还是它） */
  for (const part of chunkKeys(dropped, DELETE_KEYS_PER_STATEMENT)) {
    const marks = part.map(() => "?").join(", ");
    const params = [version, board, ...part];
    await client.batch([
      {
        sql: `DELETE FROM board_listed_details WHERE version = ? AND board = ? AND item_key IN (${marks})`,
        params,
      },
      {
        sql: `DELETE FROM board_listed WHERE version = ? AND board = ? AND item_key IN (${marks})`,
        params,
      },
      {
        sql: `DELETE FROM board_release_items WHERE version = ? AND board = ? AND item_key IN (${marks})`,
        params,
      },
    ]);
  }

  /* 3) 变更审计：applied 直接记 1（没有「切指针」这一步，写下去即生效） */
  const changeRows: unknown[][] = [];
  for (const r of toWrite) {
    const old = prevRows.get(r.key);
    if (!old) {
      changeRows.push([version, board, r.key, "add", null, 1, actor, now]);
      continue;
    }
    const diff: Record<string, unknown> = {};
    if (old.rank !== r.rank) diff.rank = { from: old.rank, to: r.rank };
    if (old.name !== r.name) diff.name = { from: old.name, to: r.name };
    if (old.tier !== r.tier) diff.tier = { from: old.tier, to: r.tier };
    changeRows.push([
      version,
      board,
      r.key,
      "update",
      Object.keys(diff).length > 0 ? JSON.stringify(diff) : null,
      1,
      actor,
      now,
    ]);
  }
  for (const key of dropped) {
    changeRows.push([version, board, key, "drop", null, 1, actor, now]);
  }
  if (changeRows.length > 0) {
    await client.batch(
      chunkForSpec(CHANGES_SPEC, changeRows, client.statementByteLimit).map((part) =>
        buildUpsert(CHANGES_SPEC, part),
      ),
    );
  }

  return {
    version,
    board,
    listed: rows.length,
    inserted,
    updated,
    dropped: dropped.length,
    unchanged,
  };
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