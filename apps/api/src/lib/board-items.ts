/**
 * 候选池（工作区）的 D1 读取 —— Worker 侧，后台专用。
 *
 * 后台不再读 content/*-staging.json：那些文件在 GitHub 仓库里，
 * 每次读要走 Contents API，还要处理 sha 冲突，而 Worker 本来就绑着 D1。
 *
 * 数据由采集流水线通过 scripts/admin/board-items.ts 写入；
 * 过渡期文件仍在写，库里没有数据时调用方可以回落到文件。
 */

/**
 * 条目状态，与后台原来的 stage 取值一致：
 * candidate（待审）/ approved（已确认收录）/ enriched（已富化）/ rejected（已拒绝）
 */
export type ItemStatus = "candidate" | "approved" | "enriched" | "rejected";

interface BoardItemRow {
  item_key: string;
  status: string;
  name: string;
  url: string | null;
  cats: string | null;
  judge: string | null;
  card: string | null;
  updated_at: number;
}

export interface BoardWorkspace<T = Record<string, unknown>> {
  /** 待审 + 已富化的条目（原样还原） */
  items: T[];
  /** 已拒绝的 item_key 列表，与原来的 staging.rejected 同义 */
  rejected: string[];
  /** 最近一次写入时间（ISO），库空时为 null */
  updatedAt: string | null;
  /** 最近一次采集运行的摘要（存在 card 之外，这里不还原） */
  lastRun: unknown;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 读某榜的整个工作区。
 *
 * 返回结构与原来的 staging 文件对齐（items + rejected），
 * 这样后台路由的取数逻辑不用改，只换数据来源。
 */
export async function listWorkspace<T = Record<string, unknown>>(
  db: D1Database,
  board: string,
): Promise<BoardWorkspace<T>> {
  const { results } = await db
    .prepare(
      "SELECT item_key, status, name, url, cats, judge, card, updated_at FROM board_items WHERE board=? ORDER BY updated_at DESC",
    )
    .bind(board)
    .all<BoardItemRow>();

  const rows = results ?? [];
  const items: T[] = [];
  const rejected: string[] = [];
  let latest = 0;

  for (const row of rows) {
    latest = Math.max(latest, row.updated_at ?? 0);
    if (row.status === "rejected") {
      rejected.push(row.item_key);
      continue;
    }
    const card = parse<T>(row.card);
    if (card && typeof card === "object") {
      // status 列才是唯一真相：卡片里的 stage 是采集时的旧值，必须覆盖掉，
      // 否则后台点了「确认收录」再刷新还是待审
      (card as Record<string, unknown>).stage = row.status;
      items.push(card);
    } else {
      // 没有卡片时至少保留可用的最小结构，避免后台整行消失
      items.push({ itemKey: row.item_key, name: row.name, url: row.url, stage: row.status } as T);
    }
  }

  return {
    items,
    rejected,
    updatedAt: latest ? new Date(latest).toISOString() : null,
    lastRun: null,
  };
}

/** 库中该榜是否已有数据 —— 调用方据此决定要不要回落到文件 */
export async function hasWorkspace(db: D1Database, board: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM board_items WHERE board=?")
      .bind(board)
      .first<{ n: number }>();
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 更新单条状态（收录 / 拒绝），返回是否真的命中一行 */
export async function setItemStatus(
  db: D1Database,
  board: string,
  itemKey: string,
  status: ItemStatus,
): Promise<boolean> {
  const res = await db
    .prepare("UPDATE board_items SET status=?, updated_at=? WHERE board=? AND item_key=?")
    .bind(status, Date.now(), board, itemKey)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** 批量更新状态，返回命中行数 */
export async function setItemsStatus(
  db: D1Database,
  board: string,
  itemKeys: readonly string[],
  status: ItemStatus,
): Promise<number> {
  if (itemKeys.length === 0) return 0;
  const stmt = db.prepare(
    "UPDATE board_items SET status=?, updated_at=? WHERE board=? AND item_key=?",
  );
  const now = Date.now();
  const batch = itemKeys.map((k) => stmt.bind(status, now, board, k));
  const results = await db.batch(batch);
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/** 发布后清空工作区 */
export async function clearWorkspace(db: D1Database, board: string): Promise<void> {
  await db.prepare("DELETE FROM board_items WHERE board=?").bind(board).run();
}