/**
 * 每日情报 → D1（落库 / 发榜）。
 *
 * 整期 JSON 的唯一副本在 `digest_issues.payload`，本脚本有两个入口：
 *   - 默认：读 `content/digest/<date>.json`（`build.ts` 的产物），落库 + 发榜；
 *   - `--from-d1`：只读库里的 payload，**不看成稿文件** —— 后台「发布本期」走这条，
 *     因为预览期手改的文案已经写进库了，重新成稿会把改动冲掉。
 *
 * 与其它榜不同，情报是**按日分**的：
 *   - 名次在单期内连续编号（模块顺序 → 模块内顺序）
 *   - item_key 必须带日期前缀，否则不同日期的同一条事件会互相覆盖
 *     （同一个 GitHub 项目可能连着三天上榜，id 是一样的）
 *
 * 只发最新一期：历史期的页面由构建期从 `digest_issues` 还原，不进名次表。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-digest.ts --date 2026-11-03
 *   pnpm tsx scripts/admin/publish-digest.ts --date 2026-11-03 --issues-only   # 只落库，不发榜
 *   pnpm tsx scripts/admin/publish-digest.ts --date 2026-11-03 --from-d1       # 只发榜，源是库
 *   pnpm tsx scripts/admin/publish-digest.ts --date 2026-11-03 --full          # 建新版本
 */
import fs from "node:fs";
import path from "node:path";
import { syncBoardToD1 } from "./board-sync";
import { createD1Client, d1Configured } from "./d1-client";
import { saveDigestIssue, type DigestIssueLike } from "./digest-issues";
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

/** 从库里读回这一期 —— 发榜只认这一份，不再重新成稿 */
async function readFromD1(date: string): Promise<DigestFile> {
  if (!d1Configured()) {
    throw new Error("--from-d1 需要 D1 凭据（CLOUDFLARE_API_TOKEN 或 wrangler 登录态）");
  }
  const res = await createD1Client().query<{ payload: string }>(
    "SELECT payload FROM digest_issues WHERE date = ?",
    [date],
  );
  const row = res.results[0];
  if (!row) throw new Error(`库里没有 ${date} 这一期，先点「生成」`);
  return JSON.parse(row.payload) as DigestFile;
}

async function main(): Promise<void> {
  const fromD1 = process.argv.includes("--from-d1");
  const issuesOnly = process.argv.includes("--issues-only");
  if (fromD1 && issuesOnly) throw new Error("--from-d1 与 --issues-only 不能同时用");

  const date = parseDate() ?? (fromD1 ? "" : latestDate());
  if (!date) throw new Error("--from-d1 必须配 --date <YYYY-MM-DD>");

  let digest: DigestFile;
  if (fromD1) {
    digest = await readFromD1(date);
    console.log(`[digest] ${date}：源是 digest_issues（不重新成稿）`);
  } else {
    const file = path.join(DIGEST_DIR, `${date}.json`);
    if (!fs.existsSync(file)) throw new Error(`找不到 ${file}`);
    digest = JSON.parse(fs.readFileSync(file, "utf-8")) as DigestFile;
  }
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

  /*
   * --issues-only：只把整期 JSON 落进 digest_issues，不建名次。
   * 后台「生成」（compose）用 —— 那一阶段还没决定发不发榜，但页面要能预览，
   * 而预览页已经是构建期从 digest_issues 还原的，所以必须先把这期存进库。
   */
  if (issuesOnly) {
    console.log(`[digest] ${date}：只写 digest_issues（不建名次）`);
  } else {
    const res = await syncBoardToD1({
      board: "digest",
      rows,
      actor: process.env.GITHUB_ACTOR ?? "manual",
      /*
       * 默认增量：只有最新一期进名次表（历史期由构建期从 digest_issues 还原），
       * 所以在当前版本上原地替换本期即可，不必为每天建一个新版本 ——
       * 一次完整发布要连其余五个榜一起重写，约 2.3 万行写入，日更吃不消。
       *
       * 加 --full 才建版本，此时期号即版本号：同一天重跑会被当前生效版本挡下。
       * 必须补成完整 ISO（`2026-11-03T00:00:00`）—— 版本号是全局的，其余榜都是 19 位，
       * 只用 `2026-11-03` 会让「按 version 排序」的地方把这一期排到当天任何发布之前。
       */
      patch: !process.argv.includes("--full"),
      version: `${date}T00:00:00`,
    });

    if (!res.ok && res.error !== "missing-credentials") process.exitCode = 1;
  }

  /*
   * 落库只在「源是文件」时做：--from-d1 的 payload 本来就是从库里读出来的，
   * 再写一遍只会把 updated_at 刷成现在，掩盖这一期真正成稿 / 改稿的时间。
   */
  if (!fromD1) {
    await saveDigestIssue(digest as unknown as DigestIssueLike);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});