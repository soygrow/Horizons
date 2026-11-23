/**
 * 发布一个批次的机会：候选池 → content/opportunities.json → D1。
 *
 *   pnpm tsx scripts/admin/publish-opps-batch.ts --batch 2026-W47
 *   pnpm tsx scripts/admin/publish-opps-batch.ts --batch 2026-W47 --no-d1
 *
 * 为什么发布要单独一步、而不是生成完就上：
 * 生成结果先落在候选池，人在后台逐条看、逐条拒，确认 5 条都满意再发布。
 * 发布前的任何操作（拒绝、补位）都只动候选池，线上始终是上一次的稳定版本。
 *
 * 条数硬约束 5 条：少于 5 说明还有被拒没补位、或候选没生成全，要拦住；
 * 多于 5 说明补位时没先把被拒的那条标掉，也要拦住让人先处理。
 */
import "../fetch/config";

import fs from "node:fs";
import path from "node:path";

import { listCandidates, markPublished } from "./board-items";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OPPS_PATH = path.join(ROOT, "content/opportunities.json");
const BATCH_SIZE = 5;
const BATCH_RE = /^\d{4}-W\d{2}$/;

interface OpportunityRecord {
  slug: string;
  batch: string;
  title: string;
  scores?: Record<string, number>;
  evidence?: Array<{ board?: string; ref?: string }>;
  [key: string]: unknown;
}

interface OpportunityFile {
  version?: string;
  updatedAt?: string;
  opportunities: OpportunityRecord[];
}

function argValue(name: string, env: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const fromArg = i >= 0 ? process.argv[i + 1] : undefined;
  return (fromArg ?? process.env[env] ?? "").trim();
}

async function main(): Promise<void> {
  const batch = argValue("batch", "OPP_BATCH");
  if (!BATCH_RE.test(batch)) {
    throw new Error(`批次号必须是 YYYY-Www 形式，收到「${batch}」`);
  }

  if (!fs.existsSync(OPPS_PATH)) throw new Error(`找不到 ${OPPS_PATH}`);
  const file = JSON.parse(fs.readFileSync(OPPS_PATH, "utf8")) as OpportunityFile;

  /* 候选池是唯一来源：拒绝过的（status=rejected）不参与发布 */
  const candidates = (await listCandidates<OpportunityRecord>("opps")).filter(
    (c) => c.card?.batch === batch && c.status !== "rejected",
  );

  if (candidates.length !== BATCH_SIZE) {
    const rejected = (await listCandidates<OpportunityRecord>("opps")).filter(
      (c) => c.card?.batch === batch && c.status === "rejected",
    ).length;
    throw new Error(
      `批次 ${batch} 当前可发布 ${candidates.length} 条，要求正好 ${BATCH_SIZE} 条` +
        (rejected ? `（另有 ${rejected} 条已拒绝，需要先补位）` : "（候选没生成全？）"),
    );
  }

  const items = candidates.map((c) => c.card!);
  for (const c of candidates) {
    const item = c.card!;
    if (!item.slug || !item.title) throw new Error(`候选 ${c.itemKey} 缺少 slug 或 title`);
    if (!item.scores) throw new Error(`候选 ${item.slug} 缺少 scores`);
    if (!item.evidence?.length) throw new Error(`候选 ${item.slug} 缺少 evidence`);
  }

  /* 同一批次重发要覆盖，不能让旧条目和新条目并存 */
  const others = (file.opportunities ?? []).filter((o) => o.batch !== batch);
  const merged = [...others, ...items].sort((a, b) => a.batch.localeCompare(b.batch));

  file.opportunities = merged;
  file.updatedAt = new Date().toISOString().slice(0, 19);

  fs.writeFileSync(OPPS_PATH, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  console.log(
    `[opps] 已写入 ${batch}：${items.length} 条，文件共 ${merged.length} 条 / ${
      new Set(merged.map((o) => o.batch)).size
    } 个批次`,
  );

  /* 同步 D1 交给现成的发布脚本，避免两套名次算法各算一遍 */
  if (!process.argv.includes("--no-d1")) {
    const { execFileSync } = await import("node:child_process");
    execFileSync("pnpm", ["exec", "tsx", "scripts/admin/publish-opps.ts"], {
      cwd: ROOT,
      stdio: "inherit",
    });
    const marked = await markPublished("opps", items.map((o) => o.slug));
    console.log(`[opps] 候选池已标记上线 ${marked} 条`);
  } else {
    console.log("[opps] --no-d1：只改了文件，没有同步数据库");
  }

  console.log("::notice::发布完成，记得提交 content/opportunities.json 触发站点重建");
}

main().catch((e) => {
  console.error(`[opps] 发布失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});