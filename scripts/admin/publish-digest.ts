/**
 * 每日情报 → D1。
 *
 * 数据源 `content/digest/<date>.json`，由 `scripts/fetch/daily/build.ts` 生成，
 * 生成完调一次本脚本即可。
 *
 * 与其它榜不同，情报是**按日分文件**的：
 *   - 名次在单期内连续编号（模块顺序 → 模块内顺序）
 *   - item_key 必须带日期前缀，否则不同日期的同一条事件会互相覆盖
 *     （同一个 GitHub 项目可能连着三天上榜，id 是一样的）
 *
 * 只发最新一期：历史期由 /daily/[date] 从文件读，不需要进 D1 的名次表。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-digest.ts
 *   pnpm tsx scripts/admin/publish-digest.ts --date 2026-11-03
 *   pnpm tsx scripts/admin/publish-digest.ts --no-d1
 */
import fs from "node:fs";
import path from "node:path";
import { syncBoardToD1 } from "./board-sync";
import type { PublishRow } from "./publish-board";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIGEST_DIR = path.join(ROOT, "content/digest");

interface DigestItem {
  id: string;
  title: string;
  score: number;
  category?: string;
  summary?: string;
  [key: string]: unknown;
}

interface DigestModule {
  key: string;
  items: DigestItem[];
}

interface DigestFile {
  date: string;
  generatedAt: string;
  modules: DigestModule[];
}

/** --date 2026-11-03 指定期号；不传则取目录里最新的一期 */
function parseDate(): string | null {
  const i = process.argv.indexOf("--date");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

function latestDate(): string {
  const files = fs
    .readdirSync(DIGEST_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) throw new Error(`content/digest 下没有已发布的期号`);
  return files.at(-1)!.replace(/\.json$/, "");
}

async function main(): Promise<void> {
  const date = parseDate() ?? latestDate();
  const file = path.join(DIGEST_DIR, `${date}.json`);
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);

  const digest = JSON.parse(fs.readFileSync(file, "utf-8")) as DigestFile;
  const modules = digest.modules ?? [];
  if (modules.length === 0) throw new Error(`${date} 没有模块，拒绝发布空榜`);

  const rows: PublishRow[] = [];
  let rank = 0;

  for (const mod of modules) {
    for (const item of mod.items ?? []) {
      rank += 1;
      rows.push({
        key: `${date}:${item.id}`,
        rank,
        // score 在 D1 里是 NOT NULL，上游缺字段时兜 0 而不是让整条写入失败
        score: typeof item.score === "number" ? item.score : 0,
        // 情报不分层，全部进主榜
        tier: "core",
        name: item.title,
        url: null,
        cats: item.category ? [item.category] : null,
        // 单条只有几百字节，卡片带全量字段
        card: { rank, date, module: mod.key, ...item },
        detail: { date, module: mod.key, ...item },
      });
    }
  }

  if (rows.length === 0) throw new Error(`${date} 没有任何条目，拒绝发布空榜`);

  console.log(
    `[digest] ${date}：${modules.length} 个模块 / ${rows.length} 条，` +
      `榜首「${rows[0]?.name}」`,
  );

  const res = await syncBoardToD1({
    board: "digest",
    rows,
    actor: process.env.GITHUB_ACTOR ?? "manual",
    /*
     * 期号即版本号：同一天重跑会被当前生效版本挡下，避免把同一期发两遍。
     *
     * 但必须补成完整 ISO（`2026-11-03T00:00:00`）—— 版本号是全局的，
     * 其余榜都是 19 位。只用 `2026-11-03` 会让「按 version 排序」的地方
     * 把这一期排到同一天任何发布之前，后台看起来像是几天前发的。
     */
    version: `${date}T00:00:00`,
  });

  if (!res.ok && res.error !== "missing-credentials") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});