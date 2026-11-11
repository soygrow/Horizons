/**
 * 报告落库 —— Node 侧。
 *
 * tools-stats / field-report / audit 这类报告原本只写进仓库文件，后台要看就得
 * 走 GitHub Contents API。现在文件照写（Actions 里能看 diff），同时把同一份
 * JSON upsert 进 board_reports，后台只读库。
 *
 * 大对象自动分片：D1 单条 SQL 上限 100KB，GitHub 榜的位次快照（1500 行 ≈ 123KB）
 * 一次塞不进去。超过阈值就切成 `key#0…key#n-1` 加一条 `key#meta` 记录片数，
 * 读端按 meta 拼回来，调用方无感。
 *
 * 写入失败只告警：报告是辅助信息，不能因为它把一次成功的采集变成失败任务。
 */
import { createD1Client, d1Configured } from "./d1-client";

/** 单片字节数：留足余量给 SQL 模板与引号转义（D1 单语句硬上限 100KB） */
const CHUNK_BYTES = 60 * 1024;

const META_SUFFIX = "#meta";

function upsertSql(key: string): string {
  return `INSERT INTO board_reports (key, payload, updated_at, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       payload = excluded.payload,
       updated_at = excluded.updated_at,
       source = excluded.source`;
}

/** 按 UTF-8 字节切，按码点迭代以免拆开代理对 */
function chunkByBytes(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  let size = 0;

  for (const ch of text) {
    const width = Buffer.byteLength(ch, "utf8");
    if (size + width > limit && cur) {
      chunks.push(cur);
      cur = "";
      size = 0;
    }
    cur += ch;
    size += width;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function readChunkCount(key: string): Promise<number> {
  const res = await createD1Client().query<{ payload: string }>(
    "SELECT payload FROM board_reports WHERE key = ?",
    [`${key}${META_SUFFIX}`],
  );
  const raw = res.results[0]?.payload;
  if (!raw) return 0;
  try {
    return Number((JSON.parse(raw) as { chunks?: number }).chunks ?? 0);
  } catch {
    return 0;
  }
}

export async function saveReport(
  key: string,
  payload: unknown,
  source = "script",
): Promise<boolean> {
  if (!d1Configured()) {
    console.warn(`::warning::[report] 未配置 D1 通道，跳过 ${key} 落库（后台看不到这份快照）`);
    return false;
  }

  const text = JSON.stringify(payload);
  const db = createD1Client();
  const now = Date.now();

  try {
    if (Buffer.byteLength(text, "utf8") <= CHUNK_BYTES) {
      await db.query(upsertSql(key), [key, text, now, source]);
      // 之前是分片存的，清理掉残片，避免读端拿到两版拼在一起
      const stale = await readChunkCount(key);
      for (let i = 0; i < stale; i++) {
        await db.query("DELETE FROM board_reports WHERE key = ?", [`${key}#${i}`]);
      }
      if (stale > 0) {
        await db.query("DELETE FROM board_reports WHERE key = ?", [`${key}${META_SUFFIX}`]);
      }
      return true;
    }

    const chunks = chunkByBytes(text, CHUNK_BYTES);
    for (const [i, part] of chunks.entries()) {
      await db.query(upsertSql(`${key}#${i}`), [`${key}#${i}`, part, now, source]);
    }
    await db.query(upsertSql(`${key}${META_SUFFIX}`), [
      `${key}${META_SUFFIX}`,
      JSON.stringify({ chunks: chunks.length }),
      now,
      source,
    ]);

    // 上次分片更多时，尾部的片要删掉，否则读端会拼进过期内容
    const stale = await readChunkCount(key);
    for (let i = chunks.length; i < stale; i++) {
      await db.query("DELETE FROM board_reports WHERE key = ?", [`${key}#${i}`]);
    }
    // 单行版本也要删，读端优先读单行
    await db.query("DELETE FROM board_reports WHERE key = ?", [key]);

    console.log(`[report] ${key} 分 ${chunks.length} 片写入（${Math.round(text.length / 1024)}KB）`);
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `::error::[report] 写入 ${key} 失败（后台读不到这份快照）：${msg.slice(0, 300)}`,
    );
    return false;
  }
}