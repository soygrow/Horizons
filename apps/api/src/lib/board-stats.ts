/**
 * 后台概览的榜单统计读取。
 *
 * 数据来自 board_stats 表，发布时由 syncBoardToD1 写入。
 *
 * 为什么不在后台读仓库里的榜文件：
 *   - github.json 59MB、trends.json 5MB，都超过 Contents API 单文件上限（1MB）；
 *   - 即便能读，也要多一次网络往返 + 5 分钟缓存，而后台只要 5 个数字；
 *   - 后台本来就绑着 D1（鉴权就要查 admin_sessions），查库零额外依赖。
 *
 * 表是派生数据：可由 board_listed 当前版本重建，不参与渲染路径。
 */

export interface BoardStat {
  /** 当前生效版本的在榜条数 */
  total: number;
  /** 该期版本号（ISO 时间），未知时为 null */
  updatedAt: string | null;
  /** 写入来源：publish / backfill */
  source: string;
}

export type BoardStats = Record<string, BoardStat>;

/**
 * 一次取全部榜的统计（最多 6 行）。
 *
 * 表不存在或还没写过时返回空对象，调用方按「暂无数据」处理 ——
 * 概览页不应该因为统计缺失而整体报错。
 */
export async function readBoardStats(db: D1Database): Promise<BoardStats> {
  const { results } = await db
    .prepare("SELECT board, total, updated_at, source FROM board_stats")
    .all<{ board: string; total: number; updated_at: string | null; source: string }>();

  const out: BoardStats = {};
  for (const row of results ?? []) {
    out[row.board] = {
      total: row.total,
      updatedAt: row.updated_at,
      source: row.source,
    };
  }
  return out;
}