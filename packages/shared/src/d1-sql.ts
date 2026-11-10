/**
 * D1 写入语句生成 —— Worker 与 GitHub Actions 共用同一份。
 *
 * 为什么不共享「执行」只共享「生成」：
 *   Worker 里是 `db.prepare(sql).bind(...).run()`（binding 直连），
 *   Actions 里是 `POST /accounts/{id}/d1/database/{db}/query`（HTTP + JSON params）。
 *   执行方式差得很远，但只要 SQL 文本与分块策略一致，两边行为就是同一个。
 *
 * 分块为什么是双阈值：
 *   github 榜单条详情中位 24KB、P99 123KB、最大 421KB。只按行数分块，
 *   100 行可能是 2.4MB 也可能是 42MB —— 极端情况会把请求体顶爆。
 *   所以行数与字节同时设限，取先到者。
 *
 * 分块为什么还要看列数（这条最容易漏）：
 *   D1 硬限制是**每条查询最多 100 个绑定参数**，不是 100 行。
 *   10 列的表塞 100 行就是 1000 个参数，D1 直接拒绝，
 *   而本地 sqlite 的参数上限是 32766 —— 本地演练永远发现不了。
 */

/**
 * 单批最多行数。仅作为「没有列信息时」的兜底，
 * 有 spec 的地方一律走 `chunkForSpec()` 按列数算。
 */
export const BATCH_ROWS = 100;

/** D1 每条查询的绑定参数上限（官方硬限制，不要调大） */
export const MAX_BOUND_PARAMS = 100;

/** 单批序列化后的字节上限 */
export const BATCH_BYTES = 2 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * UTF-8 真实字节数。
 *
 * `JSON.stringify(x).length` 是**字符数**，中文一个字算 1 但实际占 3 字节，
 * 用字符数当字节数会让中文数据的上限判断偏松 3 倍。
 */
export function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? "").length;
}

export function chunkByRows<T>(items: readonly T[], size = BATCH_ROWS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 按「行数 + 字节」双阈值分块。
 * 单行自身超过 maxBytes 时独占一批（不能因此丢掉它）。
 */
export function chunkByBytes<T>(
  items: readonly T[],
  maxRows = BATCH_ROWS,
  maxBytes = BATCH_BYTES,
): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;

  for (const item of items) {
    const size = byteLength(item);

    if (cur.length >= maxRows || (cur.length > 0 && bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }

    cur.push(item);
    bytes += size;
  }

  if (cur.length > 0) out.push(cur);
  return out;
}

/** 某张表每条语句最多能塞几行 —— 由绑定参数上限和列数决定 */
export function rowsPerStatement(columnCount: number): number {
  return Math.max(1, Math.floor(MAX_BOUND_PARAMS / Math.max(1, columnCount)));
}

/**
 * 批量写入的标准分块：参数上限与字节上限同时满足。
 *
 * 凡是 `buildUpsert()` 的调用方都应该走这里，不要自己 `chunkByRows()` ——
 * 行数和参数数不是一回事。
 */
export function chunkForSpec<T>(
  spec: { columns: readonly string[] },
  items: readonly T[],
  maxBytes = BATCH_BYTES,
): T[][] {
  const maxRows = rowsPerStatement(spec.columns.length);
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;

  for (const item of items) {
    const size = byteLength(item);

    if (cur.length >= maxRows || (cur.length > 0 && bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }

    cur.push(item);
    bytes += size;
  }

  if (cur.length > 0) out.push(cur);
  return out;
}

export interface UpsertSpec {
  /** 目标表，只接受代码内常量 */
  table: string;
  /** 列名，顺序与每行的值一一对应 */
  columns: readonly string[];
  /**
   * 冲突判定列，必须是真实的 PRIMARY KEY 或 UNIQUE 约束。
   * 留空表示纯 INSERT —— 用于 board_changes 这种只有自增主键的流水表。
   */
  conflict?: readonly string[];
}

export interface UpsertStatement {
  sql: string;
  params: unknown[];
}

/**
 * 生成多值 UPSERT。
 *
 *   INSERT INTO t (a,b) VALUES (?,?),(?,?)
 *   ON CONFLICT (k) DO UPDATE SET a = excluded.a
 *
 * 冲突列不参与 SET —— 把主键更新成自身没有意义，还会让 `changes` 虚高。
 *
 * 注意 conflict 必须真的存在于表上，否则 SQLite 直接报
 * 「ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint」。
 */
export function buildUpsert(
  spec: UpsertSpec,
  rows: readonly (readonly unknown[])[],
): UpsertStatement {
  if (rows.length === 0) return { sql: "", params: [] };

  const { table, columns, conflict } = spec;
  const tuple = `(${columns.map(() => "?").join(", ")})`;

  let suffix = "";
  if (conflict && conflict.length > 0) {
    const updatable = columns.filter((c) => !conflict.includes(c));
    suffix =
      updatable.length > 0
        ? `ON CONFLICT (${conflict.join(", ")}) DO UPDATE SET ${updatable
            .map((c) => `${c} = excluded.${c}`)
            .join(", ")}`
        : `ON CONFLICT (${conflict.join(", ")}) DO NOTHING`;
  }

  const sql =
    (`INSERT INTO ${table} (${columns.join(", ")}) VALUES ` +
      rows.map(() => tuple).join(", ") +
      ` ${suffix}`).trim();

  const params: unknown[] = [];
  for (const row of rows) {
    params.push(...row);
  }

  /*
   * 在这里拦住超限，而不是等 D1 返回错。
   * D1 的参数超限报错只写「too many SQL variables」，不说是哪张表哪一批，
   * 而我们的调用点有四五处 —— 与其线上猜，不如本地就断。
   */
  if (params.length > MAX_BOUND_PARAMS) {
    throw new Error(
      `${table} 这批有 ${params.length} 个绑定参数，超过 D1 上限 ${MAX_BOUND_PARAMS}。` +
        `请用 chunkForSpec() 按列数分块（当前 ${columns.length} 列，每批最多 ${rowsPerStatement(columns.length)} 行），` +
        `不要只按行数分。`,
    );
  }

  return { sql, params };
}