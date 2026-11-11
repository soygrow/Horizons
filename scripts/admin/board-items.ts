/**
 * 候选池（工作区）的 D1 读写 —— Node 侧，供采集 / 富化 / 发布脚本使用。
 *
 * 背景：后台要求「只读数据库」，但候选池的生产者是采集流水线（原本只写仓库文件）。
 * 过渡期两边都写：
 *   - 仓库文件保留，作为发布脚本的兜底输入，也方便人工看 diff；
 *   - D1 的 board_items 是后台的唯一数据源。
 *
 * 写入失败一律只告警：候选池落库是为了后台能看，不能因为它把一次成功的
 * 采集变成失败任务 —— 文件里还有完整数据可回填。
 */
import { createD1Client, d1Configured, type D1Client } from "./d1-client";

/** 与 board_items.status 保持一致：待审 / 已确认收录 / 已富化 / 已拒绝 */
export type ItemStatus = "candidate" | "approved" | "enriched" | "rejected";

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
    console.warn(`[items] 未配置 D1 通道，跳过 ${board} 候选池落库（文件已写）`);
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
    console.warn(`[items] 写入 ${board} 候选池失败（不影响采集）：`, e);
    return written;
  }
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

/** 发布完成后清空该榜工作区（与原来清空 staging 文件等价） */
export async function clearCandidates(board: string): Promise<void> {
  const client = openClient();
  if (!client) return;
  try {
    await client.query("DELETE FROM board_items WHERE board=?", [board]);
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