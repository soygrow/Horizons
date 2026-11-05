/**
 * 批量补全域名权重（Ahrefs DR 0~100）。
 *
 * 现状：库里 metrics.domainWeight 混了三种口径
 *   1) DR（真权重，0~100）—— 覆盖极少
 *   2) DFS backlinks rank
 *   3) SimilarWeb 全球排名（#38 ~ #1300 万）—— 占绝大多数，是「知名度」不是「权重」
 * 本脚本只做一件事：对凡是不是 DR 口径的站，重新查 Ahrefs DR；查到就覆盖为 DR，
 * 查不到保留原值（全球排名仍有排序参考价值，直接清空反而丢信息）。
 *
 * 用法：
 *   pnpm tsx scripts/fetch/fetch-domain-weight-bulk.ts [--dry] [--all] [域名...]
 *   --all  连已是 DR 的站也重查（默认跳过）
 */
import "./config";
import fs from "node:fs";

import { fetchDomainRatingBatch } from "./sources/apify";

const DRY = process.argv.includes("--dry");
const ALL = process.argv.includes("--all");
const argDomains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILE = "content/aitools.json";
const BATCH = 40;

interface Row {
  domain: string;
  metrics?: { domainWeight?: number; domainWeightLabel?: string; [k: string]: unknown };
  [k: string]: unknown;
}

async function main(): Promise<void> {
  const all = JSON.parse(fs.readFileSync(FILE, "utf8")) as Row[];

  const targets = all.filter((t) => {
    if (argDomains.length) return argDomains.includes(t.domain);
    return ALL || t.metrics?.domainWeightLabel !== "DR";
  });

  console.log(
    `目标 ${targets.length} 站（库内 ${all.length}）；已是 DR ${
      all.filter((t) => t.metrics?.domainWeightLabel === "DR").length
    } 站`,
  );
  console.log(`预估成本 $${(targets.length * 0.0028).toFixed(2)}\n`);

  let hit = 0;
  let miss = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const domains = chunk.map((t) => t.domain);
    process.stdout.write(`[${i + 1}-${Math.min(i + BATCH, targets.length)}/${targets.length}] `);

    let map: Map<string, number>;
    try {
      map = await fetchDomainRatingBatch(domains);
    } catch (e) {
      console.log(`批失败：${(e as Error).message}`);
      miss += chunk.length;
      continue;
    }

    let batchHit = 0;
    for (const t of chunk) {
      const dr = map.get(t.domain.replace(/^www\./, "").toLowerCase());
      if (dr === undefined) {
        miss++;
        continue;
      }
      const prev = t.metrics?.domainWeight;
      const prevLabel = t.metrics?.domainWeightLabel ?? "无";
      if (!DRY) {
        t.metrics = { ...(t.metrics ?? {}), domainWeight: dr, domainWeightLabel: "DR" };
      }
      hit++;
      batchHit++;
      console.log(`  ${t.domain.padEnd(26)} DR=${String(dr).padEnd(4)}（原 ${prevLabel} ${prev ?? "—"}）`);
    }
    console.log(`  → 本批命中 ${batchHit}/${chunk.length}`);
    // 每批落盘：中断重跑时已补的站会因 label=DR 自动跳过，不必重付钱
    if (!DRY && batchHit > 0) fs.writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
  }

  if (!DRY && hit > 0) {
    console.log(`\n写回 ${FILE}`);
  }
  console.log(`\n完成：命中 ${hit}，未取到 ${miss}${DRY ? "（dry，未写回）" : ""}`);
}

void main();