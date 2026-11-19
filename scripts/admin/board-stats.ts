/**
 * 榜单概览快照生成器。
 *
 * 后台概览读不了正式榜文件：github.json 59MB、trends.json 5MB，
 * 既超过 GitHub Contents API 的单文件上限（1MB），也超过 Worker 的内存预算。
 * 所以发布脚本写完榜单后顺手写一份几百字节的快照 content/board-stats.json，
 * 后台只读这份快照。
 *
 * 快照是纯派生数据：随时可由正式榜重建，不参与任何写入，
 * 因此不会变成第二个事实来源。
 *
 * 四个大榜的文件现在都不入库了（构建缓存），CI 里未必都在场：
 * 文件缺失的榜用 D1 的 board_stats 补齐 —— 那本来就是发布时写进去的同一份数字，
 * 缺了就说明这次环境没 hydrate，而不是榜单真的空了。
 *
 * 用法：
 *   pnpm tsx scripts/admin/board-stats.ts
 * 或在 publish-*.ts 末尾调用 writeBoardStats()。
 */
import fs from "node:fs";
import path from "node:path";
import { createD1Client, d1Configured } from "./d1-client";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STATS_PATH = path.join(ROOT, "content/board-stats.json");

export interface BoardStat {
  /** 正式榜文件里的条目总数 */
  total: number;
  /** 榜单文件自身的更新时间；文件没有该字段时为 null */
  updatedAt: string | null;
  /** 数据来源文件，后台据此说明「这个数字从哪来」 */
  source: string;
}

export interface BoardStatsFile {
  generatedAt: string;
  boards: Record<string, BoardStat>;
}

interface BoardSource {
  file: string;
  /** 从文件里取条目总数 */
  count: (data: unknown) => number;
}

/**
 * 五个榜的取数口径。
 *
 * 每个榜的「上榜条数」定义不一样，不能统一用数组长度：
 *   - tools  有收录门槛，要用 tools-stats.json 的 listed，不是候选总数；
 *   - trends 的 keywords 里含别名，别名不占榜位，要排除；
 *   - 其余三榜的文件本身就是榜单，数组长度即上榜数。
 *
 * 口径写在这里而不是让后台自己猜，是为了让后台数字和线上页面
 * 永远出自同一份计数结果。
 */
const SOURCES: Record<string, BoardSource> = {
  tools: {
    file: "content/tools-stats.json",
    count: (d) => (d as { listed?: number } | null)?.listed ?? 0,
  },
  trends: {
    file: "content/trends.json",
    count: (d) => {
      const list = (d as { keywords?: Array<{ variantOf?: string }> } | null)?.keywords ?? [];
      return list.filter((t) => !t.variantOf).length;
    },
  },
  models: {
    file: "content/models.json",
    count: (d) => (d as { models?: unknown[] } | null)?.models?.length ?? 0,
  },
  github: {
    file: "content/github.json",
    count: (d) => (d as { repos?: unknown[] } | null)?.repos?.length ?? 0,
  },
  opps: {
    file: "content/opportunities.json",
    count: (d) => (d as { opportunities?: unknown[] } | null)?.opportunities?.length ?? 0,
  },
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf-8"));
  } catch {
    return null;
  }
}

export function computeBoardStats(): BoardStatsFile {
  const boards: Record<string, BoardStat> = {};
  for (const [name, src] of Object.entries(SOURCES)) {
    const data = readJson(src.file);
    if (data === null) continue;
    const meta = data as { updatedAt?: unknown; generatedAt?: unknown } | null;
    // tools-stats.json 记的是 generatedAt，其余榜记 updatedAt，统一取到有值的那个
    const updatedAt =
      typeof meta?.updatedAt === "string"
        ? meta.updatedAt
        : typeof meta?.generatedAt === "string"
          ? meta.generatedAt
          : null;
    boards[name] = {
      total: src.count(data),
      updatedAt,
      source: src.file,
    };
  }
  return { generatedAt: new Date().toISOString(), boards };
}

/**
 * 用 D1 补齐「文件不在场」的榜。
 *
 * 只补缺失项，不覆盖文件算出来的数字：文件是刚刚发布的那一份，比库只可能更新、不会更旧。
 * 没有 D1 通道时原样返回（本地离线跑统计不至于失败）。
 */
async function fillMissingFromD1(stats: BoardStatsFile): Promise<BoardStatsFile> {
  if (!d1Configured()) return stats;

  try {
    const client = createD1Client();
    const res = await client.query<{ board: string; total: number; updated_at: string | null }>(
      "SELECT board, total, updated_at FROM board_stats",
      [],
    );
    for (const row of res.results) {
      if (stats.boards[row.board]) continue;
      stats.boards[row.board] = {
        total: row.total,
        updatedAt: row.updated_at,
        source: "d1:board_stats",
      };
    }
  } catch (e) {
    console.warn("[stats] 用 D1 补齐缺失榜失败（不影响已有条目）：", e);
  }
  return stats;
}

export async function writeBoardStats(): Promise<BoardStatsFile> {
  const stats = await fillMissingFromD1(computeBoardStats());
  const tmp = `${STATS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, STATS_PATH);
  return stats;
}

/** 供流水线日志使用的一行摘要 */
export function statsLine(stats: BoardStatsFile): string {
  return Object.entries(stats.boards)
    .map(([name, s]) => `${name} ${s.total}`)
    .join("｜");
}

/**
 * 把当前统计回填进 D1 的 board_stats 表。
 *
 * 日常发布不需要它：syncBoardToD1 写库成功后会自动更新对应榜的那一行。
 * 这个入口只用于两种情况：
 *   1. 表刚建好，需要从现有榜单文件灌一次初值；
 *   2. 怀疑统计与线上不一致，手工重算覆盖。
 *
 * 因此 source 记为 backfill，和发布写入的 publish 区分开，排查时能看出数据来源。
 */
export async function writeBoardStatsToD1(): Promise<number> {
  if (!d1Configured()) {
    throw new Error(
      "没有可用的 D1 通道（需 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，或本机 wrangler login）",
    );
  }

  const stats = computeBoardStats();
  const client = createD1Client();
  let written = 0;

  for (const [board, s] of Object.entries(stats.boards)) {
    await client.query(
      `INSERT INTO board_stats (board, total, updated_at, generated_at, source)
       VALUES (?, ?, ?, ?, 'backfill')
       ON CONFLICT (board) DO UPDATE SET
         total = excluded.total,
         updated_at = excluded.updated_at,
         generated_at = excluded.generated_at,
         source = excluded.source`,
      [board, s.total, s.updatedAt, Date.now()],
    );
    written++;
  }

  return written;
}

// 直接执行时刷新快照；被 publish-*.ts import 时不自动跑
if (process.argv[1]?.endsWith("board-stats.ts")) {
  (async () => {
    const stats = await writeBoardStats();
    console.log(`[stats] ${statsLine(stats)} → content/board-stats.json`);

    // 加 --d1 才写库，避免本地随手跑一次就把线上统计覆盖掉
    if (process.argv.includes("--d1")) {
      const n = await writeBoardStatsToD1();
      console.log(`[stats] 已回填 D1 board_stats：${n} 行`);
    }
  })().catch((e) => {
    console.error("[stats] 失败：", e);
    process.exitCode = 1;
  });
}