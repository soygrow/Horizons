/**
 * 机会榜 → D1。
 *
 * `content/opportunities.json` 是人工策展文件，没有采集流程，所以本脚本
 * 既是发布入口也是唯一的同步点 —— 改完 JSON 跑一次即可。
 *
 * 名次口径：每个批次内各自按 demand 分降序排名（与 /opportunity 页一致）。
 * 所有批次都写进 D1 —— 后台的「线上机会」要能按批次回查，只留最新一批就查不到历史。
 * 前台不受影响：首页与 archive 都是构建期直接读这个 JSON，不走 D1。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-opps.ts
 *   pnpm tsx scripts/admin/publish-opps.ts --full     # 建新版本号
 *   pnpm tsx scripts/admin/publish-opps.ts --no-d1
 */
import fs from "node:fs";
import path from "node:path";
import { opportunityScore, type OppScores } from "../../apps/site/src/lib/opportunity";
import { syncBoardToD1, versionOf } from "./board-sync";
import type { PublishRow } from "./publish-board";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OPPS_PATH = path.join(ROOT, "content/opportunities.json");

interface OpportunityRecord {
  slug: string;
  batch: string;
  title: string;
  oneLiner?: string;
  audience?: string[];
  scores: OppScores;
  [key: string]: unknown;
}

interface OpportunityFile {
  version?: string;
  updatedAt?: string;
  opportunities: OpportunityRecord[];
}

/**
 * 把 `updatedAt` 归一成 19 位 ISO。
 *
 * 版本号是六个榜共用的命名空间，长度不一致会让「按 version 排序」错位，
 * 后台也会把 `2026-11-10T12:00` 和 `2026-11-10T12:00:05` 当成两期。
 */
function isoVersion(raw: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return versionOf();
  const base = raw.slice(0, 19);
  // 上游可能只写到分钟，补 00 秒而不是原样用 16 位
  return base.length === 19 ? base : `${base}:00`;
}

async function main(): Promise<void> {
  if (!fs.existsSync(OPPS_PATH)) {
    throw new Error(`找不到 ${OPPS_PATH}`);
  }
  const file = JSON.parse(fs.readFileSync(OPPS_PATH, "utf-8")) as OpportunityFile;
  const all = file.opportunities ?? [];
  if (all.length === 0) throw new Error("opportunities.json 里没有条目，拒绝发布空榜");

  /* 批次号形如 2026-W44，W 后两位补零，字典序即时间序 */
  const batches = [...new Set(all.map((o) => o.batch))].sort().reverse();

  const rows: PublishRow[] = [];
  for (const batch of batches) {
    const items = all
      .filter((o) => o.batch === batch)
      .sort((a, b) => {
        const d = b.scores.demand - a.scores.demand;
        if (d !== 0) return d;
        return a.slug.localeCompare(b.slug);
      });

    items.forEach((opp, i) => {
      /* 每个批次内从 1 重新排名：批次之间是并列关系，跨批排名没有意义 */
      const rank = i + 1;
      const score = opportunityScore(opp.scores);
      rows.push({
        key: opp.slug,
        rank,
        score,
        // 机会榜是公开榜，不分层
        tier: "core",
        name: opp.title,
        url: null,
        cats: opp.audience?.length ? opp.audience : null,
        /* batch 以循环变量为准（opp.batch 可能存在空值，卡片的批次必须是确定值） */
        card: { ...opp, batch, rank, overall: score },
        /* 0024：批次写成列，后台的批次下拉按索引分组，不再解析每行卡片 */
        batch,
        detail: { data: opp, derived: { rank, score } },
      });
    });

    console.log(`[opps] 批次 ${batch}：${items.length} 条，榜首「${items[0]?.title}」`);
  }

  console.log(`[opps] 共 ${batches.length} 个批次 / ${rows.length} 条机会`);

  const res = await syncBoardToD1({
    board: "opps",
    rows,
    actor: process.env.GITHUB_ACTOR ?? "manual",
    /*
     * 默认增量：名次表只放最新一批（历史批次用不到名次表），原地替换即可。
     * 加 --full 才建版本，此时版本号取文件里的 updatedAt，同一批次重跑会被拒绝。
     */
    patch: !process.argv.includes("--full"),
    version: file.updatedAt ? isoVersion(file.updatedAt) : versionOf(),
  });

  if (!res.ok && res.error !== "missing-credentials") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});