/**
 * 报告快照读取 —— Worker 侧。
 *
 * 报告由流水线脚本生成（tools-stats / field-report / audit / 各榜位次快照），
 * 脚本写文件的同时 upsert 进 board_reports，后台只读库。
 *
 * 大对象在写入时会被切成 `key#0…key#n-1` 加一条 `key#meta`（D1 单语句 100KB），
 * 这里按 meta 拼回来；单行版本优先，兼容历史上一次性写入的小报告。
 */

export interface ReportRow<T> {
  data: T;
  updatedAt: string | null;
  source: string | null;
}

interface RawRow {
  payload: string;
  updated_at: number;
  source: string | null;
}

const META_SUFFIX = "#meta";

function toResult<T>(payload: string, row: RawRow): ReportRow<T> {
  return {
    data: JSON.parse(payload) as T,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    source: row.source ?? null,
  };
}

/** 读一份报告；没有或坏数据时返回 null */
export async function readReport<T = Record<string, unknown>>(
  db: D1Database,
  key: string,
): Promise<ReportRow<T> | null> {
  try {
    const row = await db
      .prepare("SELECT payload, updated_at, source FROM board_reports WHERE key=?")
      .bind(key)
      .first<RawRow>();
    if (row) return toResult<T>(row.payload, row);

    // 没有单行版本，看看是不是分片存的
    const metaRow = await db
      .prepare("SELECT payload FROM board_reports WHERE key=?")
      .bind(`${key}${META_SUFFIX}`)
      .first<{ payload: string }>();
    if (!metaRow) return null;

    const chunks = Number((JSON.parse(metaRow.payload) as { chunks?: number }).chunks ?? 0);
    if (chunks <= 0) return null;

    const keys = Array.from({ length: chunks }, (_, i) => `${key}#${i}`);
    const placeholders = keys.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT key, payload, updated_at, source FROM board_reports WHERE key IN (${placeholders})`,
      )
      .bind(...keys)
      .all<RawRow & { key: string }>();

    const byKey = new Map(res.results.map((r) => [r.key, r]));
    let text = "";
    for (const k of keys) {
      const part = byKey.get(k);
      // 缺片说明写入中断或正在被替换，宁可当没有，也不返回半截 JSON
      if (!part) return null;
      text += part.payload;
    }

    const first = byKey.get(keys[0]);
    return toResult<T>(text, first ?? { payload: text, updated_at: 0, source: null });
  } catch {
    return null;
  }
}