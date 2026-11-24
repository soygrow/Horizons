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
 * 条目状态：
 *   candidate     待审
 *   approved      已确认收录，等富化
 *   enriching     富化中（派发时写入，期间不可重复选择、不参与发布）
 *   enriched      富化成功
 *   enrich_failed 富化失败（脚本报错，或超过 ENRICH_TIMEOUT_MS 没回）
 *   publishing    发布中（派发发布任务时写入，脚本仍认它，跑完覆盖成 published）
 *   publish_failed 发布失败（流水线挂了，条目退回可发榜，能再次选中重发）
 *   published     发布成功，等人工点「处理完成」才从队列移除
 *   rejected      已拒绝
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
  | "rejected"
  | "discarded";

/**
 * 富化超时：超过 10 分钟还停在 enriching 就判失败。
 *
 * 必须与 scripts/admin/board-items.ts 的 ENRICH_TIMEOUT_MS 保持一致 ——
 * 两边都在判（脚本跑之前、后台读之前），口径不同就会出现
 * 「后台显示失败、脚本还在跑」这种自相矛盾的状态。
 */
export const ENRICH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 把卡住的「富化中」标记为失败，返回改动行数。
 *
 * 只按 updated_at 判断：进入 enriching 时写的就是它，富化成功会立刻
 * 覆盖成 enriched，所以正常完成的条目不会被误判。
 */
export async function expireStaleEnriching(db: D1Database, board: string): Promise<number> {
  const now = Date.now();
  const res = await db
    .prepare(
      "UPDATE board_items SET status='enrich_failed', updated_at=? " +
        "WHERE board=? AND status='enriching' AND updated_at < ?",
    )
    .bind(now, board, now - ENRICH_TIMEOUT_MS)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * 把待富化的条目标成 enriching（派发富化任务时调用）。
 *
 * domains 为空表示「队列里所有 approved」，用子查询取前 limit 条 ——
 * SQLite 的 UPDATE 不支持 LIMIT，只能这么写。
 * 已被别的任务占住的 enriching 不会被重复命中（WHERE 限定了 approved）。
 */
/**
 * 发布超时：超过 60 分钟还停在 publishing 就判失败。
 *
 * 与富化超时同理 —— 发布流水线卡住（dispatch 失败、run 被取消、worker 挂掉）时
 * 条目会永远停在「发布中」，既不能重发也不会消失，只能人工改库。
 * 60 分钟对齐 publish workflow 本身的上限。
 */
export const PUBLISH_TIMEOUT_MS = 60 * 60 * 1000;

/** 把卡住的「发布中」标记为失败，返回改动行数 */
export async function expireStalePublishing(db: D1Database, board: string): Promise<number> {
  const now = Date.now();
  const res = await db
    .prepare(
      "UPDATE board_items SET status='publish_failed', updated_at=? " +
        "WHERE board=? AND status='publishing' AND updated_at < ?",
    )
    .bind(now, board, now - PUBLISH_TIMEOUT_MS)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * 派发发布任务时占住条目：enriched / publish_failed → publishing。
 *
 * 先写库再 dispatch，后台立刻就能看到「发布中」，刷新页面也不会丢。
 * 脚本读队列时同样认 publishing，所以这一步不影响真正发出去的内容。
 * domains 为空表示「队列里所有可发榜的」。
 */
export async function markPublishing(
  db: D1Database,
  board: string,
  domains: readonly string[],
  /** 限定来源：在「线上榜单」点发布不能把「数据抓取」的待发新条目一起占住 */
  kind?: "new" | "refresh",
): Promise<number> {
  const now = Date.now();
  const kindSql = kind ? " AND kind=?" : "";
  const kindArgs: string[] = kind ? [kind] : [];
  if (domains.length === 0) {
    const res = await db
      .prepare(
        "UPDATE board_items SET status='publishing', updated_at=? " +
          `WHERE board=? AND status IN ('enriched','publish_failed')${kindSql}`,
      )
      .bind(now, board, ...kindArgs)
      .run();
    return res.meta?.changes ?? 0;
  }
  const stmt = db.prepare(
    "UPDATE board_items SET status='publishing', updated_at=? " +
      `WHERE board=? AND item_key=? AND status IN ('enriched','publish_failed')${kindSql}`,
  );
  const results = await db.batch(domains.map((d) => stmt.bind(now, board, d, ...kindArgs)));
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/**
 * 发布失败：publishing / published → publish_failed，让人能重新选中再发一次。
 *
 * 为什么连 published 也退：脚本是先写 aitools.json、标 published，最后才由 workflow
 * 提交推送。推送那一步挂了，条目在后台看着是「发布成功」，线上其实没有 —— 只有退回
 * 才看得出来。误退的代价很小：重发时脚本按域名去重，已进榜的会跳过。
 * domains 为空表示该榜所有「发布中/已发榜」的都退回（任务没记 domains 时的兜底）。
 */
export async function releasePublishing(
  db: D1Database,
  board: string,
  domains: readonly string[],
): Promise<number> {
  const now = Date.now();
  if (domains.length === 0) {
    const res = await db
      .prepare(
        "UPDATE board_items SET status='publish_failed', updated_at=? " +
          "WHERE board=? AND status IN ('publishing','published')",
      )
      .bind(now, board)
      .run();
    return res.meta?.changes ?? 0;
  }
  const stmt = db.prepare(
    "UPDATE board_items SET status='publish_failed', updated_at=? " +
      "WHERE board=? AND item_key=? AND status IN ('publishing','published')",
  );
  const results = await db.batch(domains.map((d) => stmt.bind(now, board, d)));
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

/**
 * 「处理完成」：把已发布成功的条目从队列删掉，后台不再显示。
 *
 * 只删 published 的行 —— 前端传错域名也不会误删还在队列里的条目。
 */
export async function deletePublished(
  db: D1Database,
  board: string,
  domains: readonly string[],
): Promise<number> {
  if (domains.length === 0) return 0;
  const stmt = db.prepare(
    "DELETE FROM board_items WHERE board=? AND item_key=? AND status='published'",
  );
  const results = await db.batch(domains.map((d) => stmt.bind(board, d)));
  return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
}

export async function markEnriching(
  db: D1Database,
  board: string,
  domains: readonly string[],
  limit: number,
): Promise<number> {
  const now = Date.now();
  if (domains.length > 0) {
    // 必须跟脚本的 --limit 对齐：脚本只跑前 limit 条，
    // 多标出来的条目没人跑，只能等 10 分钟超时被判失败
    const picked = domains.slice(0, limit);
    const stmt = db.prepare(
      "UPDATE board_items SET status='enriching', updated_at=? " +
        "WHERE board=? AND item_key=? AND status IN ('approved','enrich_failed')",
    );
    const results = await db.batch(picked.map((d) => stmt.bind(now, board, d)));
    return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }

  const res = await db
    .prepare(
      "UPDATE board_items SET status='enriching', updated_at=? " +
        "WHERE board=? AND item_key IN (" +
        "  SELECT item_key FROM board_items WHERE board=? AND status IN ('approved','enrich_failed')" +
        "  ORDER BY updated_at DESC LIMIT ?)",
    )
    .bind(now, board, board, limit)
    .run();
  return res.meta?.changes ?? 0;
}

/**
 * 这些条目当前是否已被富化任务占住（status='enriching'）。
 *
 * 用来挡「重复提交同一批」：后台允许在一批跑着的时候再提交另一批（队列里的
 * 待富化条目不该被一个正在跑的任务全局堵住），代价是必须逐条比对，
 * 否则重叠的那部分会被脚本按域名无脑重跑一遍（脚本 --domains 不看状态）。
 */
export async function listEnrichingItems(
  db: D1Database,
  board: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  // D1 单条 SQL 的绑定参数上限是 100
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const { results } = await db
      .prepare(
        "SELECT item_key FROM board_items WHERE board = ? AND status = 'enriching' AND item_key IN (" +
          chunk.map(() => "?").join(",") +
          ")",
      )
      .bind(board, ...chunk)
      .all<{ item_key: string }>();
    for (const r of results ?? []) out.add(r.item_key);
  }
  return out;
}

interface BoardItemRow {
  item_key: string;
  status: string;
  /** new / refresh；老数据为 NULL，按 new 处理 */
  kind: string | null;
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
  /**
   * 只读某一批（机会榜用）。
   *
   * 不带这个参数就是整榜，调用方拿到后自己筛 —— 机会榜以前就是这么干的，
   * 结果每 20 秒轮询都把整个候选池（含历史批次与被拒绝行、每行几 KB 卡片）
   * 读出来只为取 5 条。0023 加了 batch 列，这里下推到 SQL，
   * 走 idx_items_batch (board, batch, updated_at DESC)，5 行且无需排序。
   */
  batch?: string,
): Promise<BoardWorkspace<T>> {
  const sql =
    "SELECT item_key, status, kind, name, url, cats, judge, card, updated_at FROM board_items WHERE board=?" +
    (batch ? " AND batch=?" : "") +
    " ORDER BY updated_at DESC";
  const stmt = db.prepare(sql);
  const { results } = await (batch ? stmt.bind(board, batch) : stmt.bind(board)).all<BoardItemRow>();

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
    // 整批废弃的候选：既非可发布、也非「已拒绝单条」，从候选池视角直接隐藏
    if (row.status === "discarded") continue;
    const card = parse<T>(row.card);
    if (card && typeof card === "object") {
      // status 列才是唯一真相：卡片里的 stage 是采集时的旧值，必须覆盖掉，
      // 否则后台点了「确认收录」再刷新还是待审
      (card as Record<string, unknown>).stage = row.status;
      // kind 同理以列为准：卡片里的值可能来自上一次富化
      (card as Record<string, unknown>).kind = row.kind === "refresh" ? "refresh" : "new";
      items.push(card);
    } else {
      // 没有卡片时至少保留可用的最小结构，避免后台整行消失
      items.push({
        itemKey: row.item_key,
        name: row.name,
        url: row.url,
        stage: row.status,
        kind: row.kind ?? "new",
      } as T);
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