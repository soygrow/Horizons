/**
 * 单个榜的 D1 同步入口 —— models / opps / digest 共用。
 *
 * 与 tools / github / trends 里各自的 syncToD1 是同一套流程，区别只在于
 * 那三个要把同步挂在既有发布脚本里、还要处理各自的 dry-run 分支，
 * 这三个是独立脚本，所以把重复的部分收在这里。
 *
 * 灰度期 JSON 仍是线上数据源（data_source.* = file），D1 是冷备：
 * 写失败默认只告警，不阻塞文件发布。
 *
 * 一旦某个榜切流到 D1，写失败就必须硬失败 —— 见 d1IsLive 的说明。
 */
import type { Board } from "@horizons/shared";
import { createD1Client, d1Configured, type D1Client } from "./d1-client";
import {
  lastReleaseRanks,
  patchBoard,
  pruneVersions,
  publishBoard,
  slimDetail,
  type PublishRow,
} from "./publish-board";

export interface SyncOptions {
  board: Board;
  rows: readonly PublishRow[];
  /** 谁触发的，进审计；CI 里传 GITHUB_ACTOR */
  actor: string;
  /**
   * 版本号，默认取当前 UTC 秒级 `YYYY-MM-DDTHH:mm:ss`。
   * 按日发布的榜（digest）传期号，补成 `YYYY-MM-DDT00:00:00` 保持格式统一。
   */
  version?: string;
  /**
   * 增量发布：在当前生效版本上原地改差异行，不建新版本、不继承其它榜、不剪枝。
   *
   * **默认开启**。需要新建一个可回滚的完整版本时，命令行加 `--full`
   * （或显式传 `patch: false`）。`--patch` 仍被接受，但已无实际作用。
   */
  patch?: boolean;
  /**
   * 榜单元数据（数据来源统计、文案说明、评分规则版本……）。
   *
   * 只写库的榜（models / github）构建时要从库里还原文件，而元数据不是条目字段，
   * 塞进 board_listed 只会污染榜单行。落 board_stats.meta，hydrate 时原样带回。
   */
  meta?: unknown;
}

export interface SyncResult {
  ok: boolean;
  version?: string;
  listed?: number;
  entered?: number;
  exited?: number;
  pruned?: string[];
  error?: string;
  /** 增量模式的明细；完整发布时为空 */
  patch?: {
    inserted: number;
    updated: number;
    dropped: number;
    unchanged: number;
  };
}

/**
 * 默认版本号：UTC 秒级 `YYYY-MM-DDTHH:mm:ss`。
 *
 * 分钟级不够用：采集落盘后经常同一分钟内连着发 models 和 digest，
 * 两个榜会拿到同一个版本号 —— 后一个被当成「重发」跳过，数据静默丢失。
 * 秒级把撞车概率压到很低，`publishBoard` 里还有一层兜底。
 */
export function versionOf(date = new Date()): string {
  return date.toISOString().slice(0, 19);
}

/**
 * 当前生效版本里这个榜有多少行。
 *
 * 增量的前提是「已经有基线」：patchBoard 拿它跟新数据逐行比对，
 * 才知道哪些是新增、哪些变了、哪些下榜。没有基线时它只能把整榜当新增写，
 * 于是既没有 board_releases 记录，也回滚不了 —— 所以先探一下。
 *
 * 返回 0 表示「没有当前版本，或这个榜在当前版本里一行都没有」。
 */
async function currentListedCount(client: D1Client, board: Board): Promise<number> {
  const cur = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
  );
  const version = cur.results[0]?.val;
  if (!version) return 0;

  const res = await client.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
    [version, board],
  );
  return res.results[0]?.n ?? 0;
}

/**
 * 当前生效版本里这个榜的数据截止日（卡片里的 `dataAt`）。
 *
 * 模型榜的 `dataAt` 是「采集日」，而增量发布**不推进版本号**。跨天之后若
 * 还在原地 patch，11-19 的版本槽里就会装进 11-20 的数据 —— 后台标题于是
 * 出现「数据截止 11-20，发布于 11-19 09:20」这种自相矛盾的组合，那一天
 * 的原始快照也被覆盖掉，回滚不回去。
 *
 * 所以发布前先拿它比一次：数据日变了就走完整发布，让新一天的数据落在
 * 自己的版本号里。
 *
 * 返回值三态：
 * - `string`   当前版本的数据日
 * - `null`     当前版本没有 dataAt（早于这个字段落库）——同样要新建版本，
 *              否则新写入的 dataAt 会挂在旧发布日下面，矛盾照旧
 * - `undefined` 读不到（没凭据 / 网络错）——调用方跳过检查，按增量继续
 */
export async function currentBoardDataAt(board: Board): Promise<string | null | undefined> {
  if (!d1Configured()) return undefined;
  try {
    const client = createD1Client();
    const cur = await client.query<{ val: string }>(
      "SELECT val FROM app_config WHERE key = 'config.current_version'",
    );
    const version = cur.results[0]?.val;
    if (!version) return null;

    const res = await client.query<{ d: string | null }>(
      `SELECT MAX(json_extract(card, '$.dataAt')) AS d
         FROM board_listed
        WHERE version = ? AND board = ?`,
      [version, board],
    );
    return res.results[0]?.d ?? null;
  } catch (e) {
    console.warn(`[sync] 读取 ${board} 当前版本的数据日失败，按增量继续：`, e);
    return undefined;
  }
}

/**
 * 这个榜的线上数据源是否已切到 D1。
 *
 * 切流之后 D1 就是唯一数据源：写失败若只告警，文件链路会照常发版，
 * 站点却按 `data_source=<board>` = d1 去读一个没写进去的库 —— 线上直接空榜。
 * 所以 strict 不能靠人记得传 --strict-d1，必须由「已切流」这个事实自动推出。
 *
 * 读不到配置时返回 false：灰度期读失败是常态，不该擅自把发布改成硬失败。
 */
async function d1IsLive(client: D1Client, board: Board): Promise<boolean> {
  try {
    /* 列名是 val 不是 value（migrations/0011_boards.sql）——
       写成 value 会一直抛错、被下面的 catch 吞掉，
       结果就是切流后 strict 永远不生效。 */
    const res = await client.query<{ val: string }>(
      "SELECT val FROM app_config WHERE key = ?",
      [`data_source.${board}`],
    );
    return res.results[0]?.val === "d1";
  } catch (e) {
    console.warn(`[sync] 读 data_source.${board} 失败，按未切流处理：`, e);
    return false;
  }
}

/**
 * 记录该榜当前在榜条数，供后台概览查询。
 *
 * 后台读不了正式榜文件（github.json 59MB，超出 Contents API 单文件上限），
 * 而发布链路本来就要写 D1，顺手落一行即可，后台一次 SELECT 全取。
 *
 * 失败只告警：这是展示用副本，缺了顶多概览停在上一期的数字，
 * 不能因为它把一次成功的发布变成失败。
 */
async function recordBoardStat(
  client: D1Client,
  board: Board,
  total: number,
  at: string,
  meta?: unknown,
  bytes?: number,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO board_stats (board, total, updated_at, generated_at, source, meta, bytes)
       VALUES (?, ?, ?, ?, 'publish', ?, ?)
       ON CONFLICT (board) DO UPDATE SET
         total = excluded.total,
         updated_at = excluded.updated_at,
         generated_at = excluded.generated_at,
         source = excluded.source,
         meta = COALESCE(excluded.meta, board_stats.meta),
         bytes = COALESCE(excluded.bytes, board_stats.bytes)`,
      [
        board,
        total,
        at,
        Date.now(),
        // 不传 meta 的榜（tools/trends/opps/digest 走各自发布脚本）保持旧值不动
        meta === undefined ? null : JSON.stringify(meta),
        bytes ?? null,
      ],
    );
  } catch (e) {
    console.warn("[stats] 写入 board_stats 失败（不影响发布）：", e);
  }
}

/**
 * 整榜详情字节数（瘦身后）。
 *
 * 存在 board_stats 里，取代 `SELECT SUM(LENGTH(detail)) ... GROUP BY board` ——
 * 那条语句返回 6 行却要把整版 60MB 的详情读出来，纯为算一个数字。
 * 发布时详情本来就在内存里，顺手加一遍即可。
 */
function totalDetailBytes(board: Board, rows: readonly PublishRow[]): number {
  let sum = 0;
  for (const r of rows) sum += Buffer.byteLength(JSON.stringify(slimDetail(board, r.detail)));
  return sum;
}

export async function syncBoardToD1(opts: SyncOptions): Promise<SyncResult> {
  const { board, rows, actor } = opts;

  if (process.argv.includes("--no-d1")) {
    console.log("[sync] --no-d1：跳过 D1 写入");
    return { ok: true };
  }

  /** 显式参数只是兜底，主力是下面的「已切流」判定 */
  let strict = process.argv.includes("--strict-d1");

  if (!d1Configured()) {
    const msg =
      "没有可用的 D1 通道（既无 CLOUDFLARE_API_TOKEN / ACCOUNT_ID，本机也未 wrangler login）";
    if (strict) throw new Error(`--strict-d1 但${msg}`);
    console.warn(
      `[sync] ${msg}，跳过 D1 写入（JSON 链路不受影响）。` +
        `注意：若 ${board} 已切流到 D1，本次发布会让线上读到空库。`,
    );
    return { ok: false, error: "missing-credentials" };
  }

  const client = createD1Client();

  if (await d1IsLive(client, board)) {
    strict = true;
    console.log(`[sync] ${board} 已切流到 D1，本次写入失败将中止发布`);
  }

  const version = opts.version ?? versionOf();

  /*
   * 默认增量：在当前生效版本上原地改差异行。
   *
   * 完整发布要新建全局版本、把其余五个榜整份继承过来、最后再剪掉一个旧版本，
   * 一次约 2.3 万 rows_written（免费版每天才 10 万）。日常「刷新已有条目的数据」
   * 根本不需要这些动作 —— 逐行比对后只写变了的那些，几十条就是几百次写。
   *
   * 要完整发布就显式加 `--full`（或传 patch: false）：新增大量条目、换口径、
   * 需要留一个可回滚的快照时用它。代价见 publish-board.ts 的 PatchInput 注释。
   */
  let usePatch = opts.patch ?? !process.argv.includes("--full");

  if (usePatch) {
    try {
      if ((await currentListedCount(client, board)) === 0) {
        usePatch = false;
        console.log(
          `[sync] ${board} 在当前版本还没有数据（新库 / 新榜 / 刚切流），本次改为完整发布`,
        );
      }
    } catch (e) {
      /*
       * 读不到基线时不要贸然改走完整发布：那要写两三万行，一次误判就吃掉
       * 五分之一日额度。交给 patchBoard 自己抛错更诚实（strict 会中止发布）。
       */
      console.warn("[sync] 读取当前版本基线失败，仍按增量尝试：", e);
    }
  }

  if (usePatch) {
    try {
      const res = await patchBoard(client, {
        board,
        rows,
        actor,
        allowShrink: process.argv.includes("--allow-shrink"),
      });

      /*
       * 增量不推进版本号，`board_stats.updated_at` 不能继续写版本时间 ——
       * 否则数据天天在改，后台和站点上的「更新于」却永远停在首版那一天。
       * 真的写进去行了才刷时间；一行没变（全 unchanged）就保持原样。
       */
      const touched = res.inserted + res.updated + res.dropped > 0;
      await recordBoardStat(
        client,
        board,
        res.listed,
        touched ? versionOf() : res.version,
        opts.meta,
      );

      console.log(
        `[sync] ${board} 增量更新版本 ${res.version}：${res.listed} 条` +
          `（新增 ${res.inserted} / 更新 ${res.updated} / 下榜 ${res.dropped}` +
          ` / 未变 ${res.unchanged}，实际写入 ${res.inserted + res.updated + res.dropped} 行）`,
      );

      return {
        ok: true,
        version: res.version,
        listed: res.listed,
        entered: res.inserted,
        exited: res.dropped,
        patch: {
          inserted: res.inserted,
          updated: res.updated,
          dropped: res.dropped,
          unchanged: res.unchanged,
        },
      };
    } catch (e) {
      // 增量模式没有「新版本兜底」：写了一半就是线上半更新，必须收干净
      if (strict) throw e;
      console.error(`[sync] ${board} 增量写入失败，JSON 链路继续：`, e);
      return { ok: false, version, error: String(e) };
    }
  }

  try {
    // 上期名次从库里取，不依赖 JSON 的历史顺序
    const previous = await lastReleaseRanks(client, board);

    const res = await publishBoard(client, { board, version, rows, actor, previous });

    // 同版本号重发：内容没变，正常跳过，不是失败
    if (res.skipped) {
      console.log(`[sync] ${board} ${res.version} 已生效且内容未变，跳过`);
      return { ok: true, version: res.version, listed: res.listed };
    }

    const pruned = await pruneVersions(client);

    // 顺带记下在榜条数与整榜字节：后台概览只查 board_stats，不再读仓库里的榜文件，
    // 也不再为了体积去 SUM(LENGTH(detail))
    await recordBoardStat(client, board, res.listed, res.version, opts.meta, totalDetailBytes(board, rows));

    console.log(
      `[sync] ${board} 已写入 ${res.version}：${res.listed} 条` +
        `（进 ${res.entered} / 出 ${res.exited} / 升 ${res.up} / 降 ${res.down}）`,
    );
    if (pruned.length > 0) console.log(`[sync] 已清理旧版本：${pruned.join(", ")}`);

    return {
      ok: true,
      version: res.version,
      listed: res.listed,
      entered: res.entered,
      exited: res.exited,
      pruned,
    };
  } catch (e) {
    if (strict) throw e;
    console.error(`[sync] ${board} 写入失败，JSON 链路继续：`, e);
    return { ok: false, version, error: String(e) };
  }
}