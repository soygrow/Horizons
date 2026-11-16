/**
 * 候选池（工作区）的 D1 读写 —— Node 侧，供采集 / 富化 / 发布脚本使用。
 *
 * 这里就是候选池的唯一存储：采集写、后台读、富化改、发布读，全部围绕
 * board_items。不再落 content/tools-staging.json —— 仓库文件既是并发写入的
 * 冲突源，也让「后台看到的」和「文件里的」有机会不一致。
 *
 * 写入失败不静默：调用方（fetch-staging）必须检查返回值，
 * 否则就是「采集成功但后台什么都没有」。
 */
import { createD1Client, d1Configured, type D1Client } from "./d1-client";

/**
 * 与 board_items.status 保持一致。
 *
 *   candidate      待审（采集刚写完）
 *   approved       已确认收录，等富化
 *   enriching      富化中（派发时写入，期间不能重复选、不能被发布带走）
 *   enriched       富化成功，可发榜
 *   enrich_failed  富化失败（脚本报错 / 超过 ENRICH_TIMEOUT_MS 没回）
 *   publishing     发布中（后台派发时写入，脚本照常认它）
 *   publish_failed 发布失败（日志里能看到原因，后台可重新选中再发）
 *   published      已上线，等人工在后台点「处理完成」
 *   rejected       已拒绝
 */
export type ItemStatus =
  | "candidate"
  | "approved"
  | "enriching"
  | "enriched"
  | "enrich_failed"
  | "publishing"
  | "publish_failed"
  | "published"
  | "rejected";

/**
 * 富化超时：单条超过 10 分钟还停在 enriching 就判失败。
 *
 * 富化是逐条起子进程，正常一条几分钟。超过这个时长要么 workflow 被取消、
 * 要么子进程挂死 —— 没有这个出口，条目会永远卡在「富化中」，
 * 既不能被再次选择，也不会进发布队列，只能人工去改库。
 */
export const ENRICH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把卡住的「富化中」标记为失败。
 *
 * 只按 updated_at 判断：进入 enriching 时写入的就是这个时间，
 * 富化成功会立刻覆盖成 enriched，所以不会被误判。
 */
export async function expireStaleEnriching(
  board: string,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<number> {
  const client = openClient();
  if (!client) return 0;
  const now = Date.now();
  try {
    const res = await client.query(
      "UPDATE board_items SET status='enrich_failed', updated_at=? " +
        "WHERE board=? AND status='enriching' AND updated_at < ?",
      [now, board, now - ENRICH_TIMEOUT_MS],
    );
    if (res.changes > 0) {
      log(`[items] ${res.changes} 条富化超时（> ${ENRICH_TIMEOUT_MS / 60000} 分钟），已标记为失败`);
    }
    return res.changes;
  } catch (e) {
    log(
      `::warning::[items] 富化超时判定失败：${
        e instanceof Error ? e.message.slice(0, 160) : String(e)
      }`,
    );
    return 0;
  }
}

export interface BoardItemInput {
  /** domain / owner-repo / slug / model-id */
  itemKey: string;
  name: string;
  url?: string | null;
  cats?: readonly string[] | null;
  status?: ItemStatus;
  /** 采集期判定，约 200B */
  judge?: unknown;
  /** 完整条目，后台读出来原样还原 */
  card?: unknown;
}

/**
 * D1 单条语句最多 100 个绑定参数，board_items 每行 9 个（含 updated_at）
 * → 每批 11 行 = 99 个，正好卡在上限内。
 */
const ROWS_PER_STATEMENT = 11;

function openClient(): D1Client | null {
  if (!d1Configured()) return null;
  return createD1Client();
}

function jsonOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/**
 * 批量写入候选条目（按 (board, item_key) 覆盖）。
 *
 * 采集结束后一次性落库：新增的插入，已有的更新判定与卡片。
 * 返回实际写入的行数；没有可用通道时返回 0 并告警。
 */
export async function syncCandidates(
  board: string,
  items: readonly BoardItemInput[],
): Promise<number> {
  if (items.length === 0) return 0;

  const client = openClient();
  if (!client) {
    console.warn(`::warning::[items] 未配置 D1 通道，跳过 ${board} 候选池落库（后台看不到这批数据）`);
    return 0;
  }

  const now = Date.now();
  let written = 0;

  try {
    for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) {
      const chunk = items.slice(i, i + ROWS_PER_STATEMENT);
      const rows = chunk.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
      const params: unknown[] = [];

      for (const it of chunk) {
        params.push(
          board,
          it.itemKey,
          it.status ?? "candidate",
          it.name,
          it.url ?? null,
          jsonOrNull(it.cats),
          jsonOrNull(it.judge),
          jsonOrNull(it.card),
          now,
        );
      }

      await client.query(
        `INSERT INTO board_items (board, item_key, status, name, url, cats, judge, card, updated_at)
         VALUES ${rows}
         ON CONFLICT (board, item_key) DO UPDATE SET
           status = excluded.status,
           name = excluded.name,
           url = excluded.url,
           cats = excluded.cats,
           judge = excluded.judge,
           card = excluded.card,
           updated_at = excluded.updated_at`,
        params,
      );
      written += chunk.length;
    }
    return written;
  } catch (e) {
    // 后台只读 D1，写失败等于「采集成功但后台什么都没有」。
    // 这里不抛错（仓库文件仍要提交），但必须在 Actions 里留一条错误注解，
    // 否则日志一片绿，人只会以为数据没抓到。
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `::error::[items] 写入 ${board} 候选池失败，后台看不到这批数据：${msg.slice(0, 300)}`,
    );
    return written;
  }
}

/**
 * 只覆盖卡片内容，不动 status。
 *
 * 为什么不用 syncCandidates：那条语句会把 status 一起写成传入值，
 * 后台已经「确认收录」的条目会被打回 candidate，等于把人工审核抹掉。
 * 这里只改 card（描述就存在 card 里），status/name/url 一律不动。
 */
export async function updateCards(
  board: string,
  entries: readonly { itemKey: string; card: unknown }[],
  log: (msg: string) => void = (m) => console.log(m),
): Promise<number> {
  if (entries.length === 0) return 0;
  const client = openClient();
  if (!client) {
    log("::warning::[items] 未配置 D1 通道，卡片更新跳过");
    return 0;
  }

  const now = Date.now();
  let done = 0;
  for (const it of entries) {
    try {
      await client.query(
        "UPDATE board_items SET card = ?, updated_at = ? WHERE board = ? AND item_key = ?",
        [jsonOrNull(it.card), now, board, it.itemKey],
      );
      done++;
    } catch (e) {
      log(
        `::warning::[items] 更新 ${it.itemKey} 卡片失败：${
          e instanceof Error ? e.message.slice(0, 160) : String(e)
        }`,
      );
    }
  }
  return done;
}

/** 把条目标记为已拒绝（后台点「拒绝」后要让采集不再重复抓） */
export async function rejectCandidate(board: string, itemKey: string): Promise<boolean> {
  const client = openClient();
  if (!client) return false;
  try {
    await client.query(
      "UPDATE board_items SET status='rejected', updated_at=? WHERE board=? AND item_key=?",
      [Date.now(), board, itemKey],
    );
    return true;
  } catch (e) {
    console.warn("[items] 标记拒绝失败：", e);
    return false;
  }
}

/** 读取某榜的条目，供发布脚本合并 */
export async function listCandidates<T = unknown>(
  board: string,
  status?: ItemStatus,
): Promise<Array<{ itemKey: string; status: string; name: string; card: T | null }>> {
  const client = openClient();
  if (!client) return [];
  try {
    const sql = status
      ? "SELECT item_key, status, name, card FROM board_items WHERE board=? AND status=? ORDER BY updated_at DESC"
      : "SELECT item_key, status, name, card FROM board_items WHERE board=? ORDER BY updated_at DESC";
    const res = await client.query<{
      item_key: string;
      status: string;
      name: string;
      card: string | null;
    }>(sql, status ? [board, status] : [board]);

    return (res.results ?? []).map((r) => ({
      itemKey: r.item_key,
      status: r.status,
      name: r.name,
      card: r.card ? (JSON.parse(r.card) as T) : null,
    }));
  } catch (e) {
    console.warn("[items] 读取候选池失败：", e);
    return [];
  }
}

/**
 * 按「队列形态」读回：status 列是真相（后台的确认/拒绝都写这里），
 * 卡片里存的是采集当时的旧 stage，所以用 status 覆盖后再返回。
 *
 * rejected 单独返回：它不参与发布，只用于采集端跳过已拒的域名。
 * published 直接跳过：已经上线了，留在库里只是为了让人在后台看到「发布成功」，
 * 绝不能再次进入发布队列（否则同一批会被重复合并进榜单）。
 */
export async function readWorkspace<T = Record<string, unknown>>(
  board: string,
): Promise<{ items: Array<T & { stage?: string }>; rejected: string[] }> {
  const rows = await listCandidates<T & { stage?: string }>(board);

  const items: Array<T & { stage?: string }> = [];
  const rejected: string[] = [];
  for (const r of rows) {
    if (r.status === "rejected") {
      rejected.push(r.itemKey);
      continue;
    }
    if (r.status === "published") continue;
    if (r.card) items.push({ ...r.card, stage: r.status });
  }
  return { items, rejected };
}

/**
 * 把本次发布的条目标记为已上线。
 *
 * 必须在清空工作区之前调用：clearCandidates 只删非 published 的行，
 * 这些刚标记的行会留下来，后台才能显示「发布成功」等人工确认。
 */
export async function markPublished(board: string, domains: readonly string[]): Promise<number> {
  if (domains.length === 0) return 0;
  const client = openClient();
  if (!client) return 0;
  let changed = 0;
  const now = Date.now();
  for (let i = 0; i < domains.length; i += 100) {
    const chunk = domains.slice(i, i + 100);
    try {
      const res = await client.query(
        `UPDATE board_items SET status='published', updated_at=? WHERE board=? AND item_key IN (${chunk
          .map(() => "?")
          .join(",")})`,
        [now, board, ...chunk],
      );
      changed += res.changes;
    } catch (e) {
      console.warn("[items] 标记已发布失败：", e);
    }
  }
  return changed;
}

/** 发布完成后清空该榜工作区（与原来清空 staging 文件等价），保留等确认的已发布行 */
export async function clearCandidates(board: string): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    await client.query("DELETE FROM board_items WHERE board=? AND status<>'published'", [board]);
  } catch (e) {
    console.warn("[items] 清空候选池失败：", e);
  }
}

/** 库里是否已有该榜条目 —— 发布时据此决定读库还是读文件 */
export async function hasCandidates(board: string): Promise<boolean> {
  const client = openClient();
  if (!client) return false;
  try {
    const res = await client.query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM board_items WHERE board=?",
      [board],
    );
    return (res.results?.[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}