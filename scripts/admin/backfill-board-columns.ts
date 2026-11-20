/**
 * 一次性维护脚本：把已有版本的数据搬到 0021 的新结构上。
 *
 * 三件事：
 *   1. 瘦身 —— github 的 detail 去掉 readme（74.8% 的体积，构建侧从来不用），
 *      顺便把每条的字节数写进 board_listed_details.bytes。
 *   2. 回填 —— 把 card 里被反复查询的标量写进 board_listed 的新列，
 *      之后后台列表不再对 1500 行各做 7 次 json_extract。
 *   3. 汇总 —— board_stats.bytes 存整榜体积，取代 SUM(LENGTH(detail)) 全表扫描。
 *
 * 幂等：已瘦身的行不会再改（`json_extract(detail,'$.readme') IS NOT NULL` 过滤），
 * 已回填的列再写一次值也一样。
 *
 * 用法：
 *   pnpm tsx scripts/admin/backfill-board-columns.ts                    # 只处理当前版本的 github
 *   pnpm tsx scripts/admin/backfill-board-columns.ts --board models
 *   pnpm tsx scripts/admin/backfill-board-columns.ts --all              # 所有保留的版本
 *   pnpm tsx scripts/admin/backfill-board-columns.ts --dry
 */
import path from "node:path";
import type { Board } from "@horizons/shared";
import { createD1Client, d1Configured, type D1Client } from "./d1-client";
import { cardColumns, slimDetail } from "./publish-board";
import { currentBoardVersion } from "./snapshot";

const ROOT = path.resolve(import.meta.dirname, "../..");
const PAGE = 50;

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const dry = process.argv.includes("--dry");
const board = (arg("board") ?? "github") as Board;

interface DetailRow {
  item_key: string;
  detail: string;
  bytes: number | null;
}

/** 保留的版本（prune 之后最多三期），从榜单本身取，不依赖版本登记表 */
async function listVersions(client: D1Client): Promise<string[]> {
  const res = await client.query<{ version: string }>(
    "SELECT DISTINCT version FROM board_listed WHERE board = ? ORDER BY version DESC LIMIT 3",
    [board],
  );
  return res.results.map((r) => r.version);
}

/** 1) 瘦身 + 写 bytes */
async function slimDetails(client: D1Client, version: string): Promise<{ rows: number; before: number; after: number }> {
  let cursor = "";
  let rows = 0;
  let before = 0;
  let after = 0;

  for (;;) {
    const page = await client.query<DetailRow>(
      `SELECT item_key, detail, bytes FROM board_listed_details
        WHERE version = ? AND board = ? AND item_key > ?
        ORDER BY item_key LIMIT ?`,
      [version, board, cursor, PAGE],
    );
    if (page.results.length === 0) break;

    const stmts = [];
    for (const row of page.results) {
      cursor = row.item_key;
      const parsed = JSON.parse(row.detail) as Record<string, unknown>;
      const slim = JSON.stringify(slimDetail(board, parsed));
      const bytes = Buffer.byteLength(slim);
      before += Buffer.byteLength(row.detail);
      after += bytes;
      rows += 1;
      const needSlim = slim !== row.detail;
      /* 没东西可瘦的榜（models/tools/trends…）只补 bytes；已经补过就不再写 */
      if (!needSlim && row.bytes === bytes) continue;
      stmts.push(
        needSlim
          ? {
              sql: "UPDATE board_listed_details SET detail = ?, bytes = ? WHERE version = ? AND board = ? AND item_key = ?",
              params: [slim, bytes, version, board, row.item_key],
            }
          : {
              sql: "UPDATE board_listed_details SET bytes = ? WHERE version = ? AND board = ? AND item_key = ?",
              params: [bytes, version, board, row.item_key],
            },
      );
    }

    if (stmts.length > 0 && !dry) await client.batch(stmts);
    if (page.results.length < PAGE) break;
  }

  return { rows, before, after };
}

/** 2) 回填 board_listed 的标量列 */
async function fillColumns(client: D1Client, version: string): Promise<number> {
  let cursor = "";
  let rows = 0;

  for (;;) {
    const page = await client.query<{ item_key: string; card: string | null }>(
      `SELECT item_key, card FROM board_listed
        WHERE version = ? AND board = ? AND item_key > ?
        ORDER BY item_key LIMIT ?`,
      [version, board, cursor, PAGE],
    );
    if (page.results.length === 0) break;

    const stmts = [];
    for (const row of page.results) {
      cursor = row.item_key;
      let card: unknown = {};
      try {
        card = JSON.parse(row.card ?? "{}");
      } catch {
        card = {};
      }
      rows += 1;
      stmts.push({
        sql: `UPDATE board_listed
                 SET stars = ?, forks = ?, language = ?, description = ?,
                     pushed_at = ?, last_crawled_at = ?, grade = ?
               WHERE version = ? AND board = ? AND item_key = ?`,
        params: [
          ...cardColumns(board, card),
          version,
          board,
          row.item_key,
        ],
      });
    }

    if (stmts.length > 0 && !dry) await client.batch(stmts);
    if (page.results.length < PAGE) break;
  }

  return rows;
}

/**
 * 4) data_day：行级采集日（0022）。
 *
 * 一条 UPDATE 扫完一万行：SQL 文本很短、没有绑定参数，不用像上面那样分页往返。
 * 只填 NULL 的行，重跑不会再写。
 */
async function fillDataDays(client: D1Client): Promise<number> {
  const pending = await client.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_listed WHERE data_day IS NULL",
  );
  const n = pending.results[0]?.n ?? 0;
  if (n === 0 || dry) return n;
  await client.query(
    `UPDATE board_listed
        SET data_day = substr(COALESCE(
              last_crawled_at,
              json_extract(card, '$.lastCrawledAt'),
              json_extract(card, '$.dataAt'),
              json_extract(card, '$.updatedAt'),
              json_extract(card, '$.lastSeenAt')), 1, 10)
      WHERE data_day IS NULL`,
  );
  return n;
}

/**
 * 5) board_version_index：后台版本下拉的数据源（0022）。
 *
 * 整表重建而不是增量对账：行数 = 榜数 × 版本数（十几行），
 * 重建两条语句就完事，对账反而容易漏。
 */
async function rebuildVersionIndex(client: D1Client): Promise<number> {
  if (dry) return 0;
  await client.run([
    { sql: "DELETE FROM board_version_index", params: [] },
    {
      sql: `INSERT INTO board_version_index (board, version, total, data_at, created_at)
            SELECT board, version, COUNT(*), MAX(data_day), ?
              FROM board_listed
             GROUP BY board, version`,
      params: [Date.now()],
    },
  ]);
  const res = await client.query<{ n: number }>("SELECT COUNT(*) AS n FROM board_version_index");
  return res.results[0]?.n ?? 0;
}

/** 3) board_stats.bytes：整榜体积，读的是每行的整数，不再碰 detail 正文 */
async function fillStats(client: D1Client, version: string): Promise<number> {
  const res = await client.query<{ n: number | null }>(
    "SELECT SUM(bytes) AS n FROM board_listed_details WHERE version = ? AND board = ?",
    [version, board],
  );
  const bytes = res.results[0]?.n ?? 0;
  if (!dry) {
    await client.query(
      `UPDATE board_stats SET bytes = ? WHERE board = ?`,
      [bytes, board],
    );
  }
  return bytes;
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

async function main(): Promise<void> {
  if (!d1Configured()) {
    throw new Error("需要 D1 通道：配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或 wrangler login");
  }
  const client = createD1Client();

  /* 0022 的两样：全库各来一遍，和 --board / --version 无关 */
  const days = await fillDataDays(client);
  const indexed = await rebuildVersionIndex(client);
  console.log(
    `[backfill] data_day 回填 ${days} 行｜版本索引 ${indexed} 行${dry ? "（dry-run）" : ""}`,
  );

  const all = process.argv.includes("--all");
  const current = await currentBoardVersion();
  const versions = all
    ? await listVersions(client)
    : [arg("version") ?? current].filter((v): v is string => Boolean(v));

  if (versions.length === 0) throw new Error("找不到要处理的版本");

  for (const version of versions) {
    const slim = await slimDetails(client, version);
    /* 0021 那 7 列只有 github 有值（其余榜的 card 没有这些标量），别白写 1000 多行 NULL */
    const filled = board === "github" ? await fillColumns(client, version) : 0;
    /* board_stats 只记当前版本的体积：--all 会把三期都过一遍，写旧版会把线上数字改小 */
    const bytes =
      version === current
        ? await fillStats(client, version)
        : await client.query<{ n: number | null }>(
            "SELECT SUM(bytes) AS n FROM board_listed_details WHERE version = ? AND board = ?",
            [version, board],
          ).then((r) => r.results[0]?.n ?? 0);
    console.log(
      `[backfill] ${board} @ ${version}｜瘦身 ${slim.rows} 条 ${mb(slim.before)} → ${mb(slim.after)}` +
        `｜回填列 ${filled} 行｜体积 ${mb(bytes)}${version === current ? "（已写入 board_stats）" : "（非当前版本，仅统计）"}${
          dry ? "（dry-run）" : ""
        }`,
    );
  }
  console.log(`[backfill] 完成${dry ? "（dry-run，未写库）" : ""}｜cwd ${path.relative(ROOT, process.cwd()) || "."}`);
}

main().catch((e: unknown) => {
  console.error("[backfill] 失败：", e);
  process.exitCode = 1;
});