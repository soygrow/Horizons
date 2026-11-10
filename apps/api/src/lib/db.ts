/**
 * D1 读写封装（Worker 侧）。
 *
 * 语句生成与分块策略放在 `@horizons/shared` 的 d1-sql 里，与 GitHub Actions 的
 * 发布脚本共用：那边走 HTTP API，这边走 binding，执行方式差得远，但 SQL 必须一模一样，
 * 否则「本地演练通过、线上发布乱套」。
 *
 * D1 的四条约束决定了这里的形状：
 *
 * 1. **没有交互式事务**，只有 `db.batch()` 是原子的
 * 2. **每条查询最多 100 个绑定参数**，所以按列数算行数，不能按固定行数分批
 * 3. **单次 batch 有语句数上限**，3000 行一次性写入会失败
 * 4. **单行 2 MB 上限**，超出必须外置或截断（实测 github 榜最大单条 421KB）
 *
 * 表名与列名只来自代码里的常量，不接受任何用户输入，因此可以直接拼进 SQL；
 * 值一律通过 bind 传参。
 */

import { BATCH_ROWS, buildUpsert, chunkByRows, chunkForSpec, type UpsertSpec } from "@horizons/shared";

export const BATCH_SIZE = BATCH_ROWS;
export const chunk = chunkByRows;
export type { UpsertSpec };

// ── 配置 ─────────────────────────────────────────────────────────

/** 读单条配置。键不存在或读失败都返回 null，调用方自行决定回落方向 */
export async function readConfig(db: D1Database, key: string): Promise<string | null> {
  try {
    const row = await db
      .prepare("SELECT val FROM app_config WHERE key = ?")
      .bind(key)
      .first<{ val: string }>();
    return row?.val ?? null;
  } catch {
    return null;
  }
}

/** 批量读配置，一次查询。缺失的键不会出现在结果里 */
export async function readConfigs(
  db: D1Database,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (keys.length === 0) return out;

  const placeholders = keys.map(() => "?").join(", ");
  try {
    const { results } = await db
      .prepare(`SELECT key, val FROM app_config WHERE key IN (${placeholders})`)
      .bind(...keys)
      .all<{ key: string; val: string }>();
    for (const r of results ?? []) out.set(r.key, r.val);
  } catch {
    /* 读失败返回空 Map，由调用方走 fallback */
  }
  return out;
}

/** UPSERT 单条配置 */
export async function writeConfig(
  db: D1Database,
  key: string,
  val: string,
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO app_config (key, val, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET val = excluded.val, updated_at = excluded.updated_at`,
    )
    .bind(key, val, now)
    .run();
}

// ── 批量写入 ──────────────────────────────────────────────────────

/**
 * 分块批量 UPSERT，返回写入行数。
 *
 * 注意：这里**不承诺原子**。多批之间若中途失败，前面的批已经落库。
 * 数据一致性不靠事务，靠「版本指针最后切换」—— 半成品写在旧版本之后，
 * 没人读得到，重跑会 UPSERT 覆盖。
 */
export async function bulkUpsert(
  db: D1Database,
  spec: UpsertSpec,
  rows: readonly (readonly unknown[])[],
): Promise<number> {
  if (rows.length === 0) return 0;

  let written = 0;
  // 按列数算每批行数：D1 限的是 100 个绑定参数，不是 100 行
  for (const part of chunkForSpec(spec, rows)) {
    const { sql, params } = buildUpsert(spec, part);
    await db
      .prepare(sql)
      .bind(...params)
      .run();
    written += part.length;
  }
  return written;
}

// ── 工具 ─────────────────────────────────────────────────────────

/** 安全解析 JSON 列。列本身存的就是 JSON 字符串，但历史数据可能残缺 */
export function jsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** 写入前把对象序列化成列值，null 保持 null 而不是字符串 "null" */
export function toJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}