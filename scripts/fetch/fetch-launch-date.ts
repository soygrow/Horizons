/**
 * 重取「上线时间」（launchedAt）。
 *
 * 为什么重取：此前 launchedAt 来自 Product Hunt —— enrich-site 用站名去 PH 搜，
 * 取回的是「最近一条同名 post」的 createdAt，导致 316 站里 241 站的「上线时间」
 * 全部落在采集当月（2026-09/10），与真实上线时间无关。该来源已废弃。
 *
 * 新口径：Wayback Machine 最早快照 = 该站点第一次被公开存档的时间，是「网站上线」
 * 目前唯一能大规模拿到的客观证据。
 *
 * 回退与打标：
 *   - 有快照 → launchedAt = 首快照日期，basis = "wayback"
 *   - 无快照（多为极新站）→ 回退域名注册时间，basis = "registered"，estimated = true
 *   - 首快照与域名注册相差 > 3 年 → 域名很可能是旧站改造/转过手，
 *     首快照不等于当前产品上线，打 estimated 供前端加 * 说明
 *
 * 用法：pnpm tsx scripts/fetch/fetch-launch-date.ts [--dry] [--force] [域名...]
 *   --force  已有 wayback 口径的站也重查
 */
import "./config";
import fs from "node:fs";

import { fetchWaybackFirstSnapshots } from "./sources/apify";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const argDomains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILE = "content/aitools.json";
const BATCH = 50;
/** 首快照与域名注册相差超过这么多天，认为域名历史早于当前产品 */
const SUSPECT_DAYS = 3 * 365;

interface Row {
  domain: string;
  launchedAt?: string;
  launchedAtBasis?: "wayback" | "registered";
  launchedAtEstimated?: boolean;
  metrics?: { registeredAt?: string; registeredAtSuspect?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

const days = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

async function main(): Promise<void> {
  const all = JSON.parse(fs.readFileSync(FILE, "utf8")) as Row[];
  const targets = all.filter((t) => {
    if (argDomains.length) return argDomains.includes(t.domain);
    return FORCE || t.launchedAtBasis !== "wayback";
  });

  console.log(`目标 ${targets.length} 站（库内 ${all.length}）；预估成本 $${(targets.length * 0.001).toFixed(2)}\n`);

  let got = 0;
  let fallback = 0;
  let none = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    process.stdout.write(`[${i + 1}-${Math.min(i + BATCH, targets.length)}/${targets.length}] `);

    let map: Map<string, string>;
    try {
      map = await fetchWaybackFirstSnapshots(chunk.map((t) => t.domain));
    } catch (e) {
      console.log(`批失败：${(e as Error).message}`);
      continue;
    }

    let batchGot = 0;
    let batchChanged = 0;
    for (const t of chunk) {
      const key = t.domain.replace(/^www\./, "").toLowerCase();
      const snap = map.get(key);
      const reg = t.metrics?.registeredAt;

      if (snap) {
        const estimated = !!reg && !t.metrics?.registeredAtSuspect && days(snap, reg) > SUSPECT_DAYS;
        if (!DRY) {
          t.launchedAt = snap;
          t.launchedAtBasis = "wayback";
          t.launchedAtEstimated = estimated || undefined;
        }
        got++;
        batchGot++;
        batchChanged++;
      } else if (reg) {
        if (!DRY) {
          t.launchedAt = reg;
          t.launchedAtBasis = "registered";
          t.launchedAtEstimated = true;
        }
        fallback++;
        batchChanged++;
      } else {
        if (!DRY) {
          t.launchedAt = undefined;
          t.launchedAtBasis = undefined;
          t.launchedAtEstimated = undefined;
        }
        none++;
      }
    }
    console.log(`快照 ${batchGot}/${chunk.length}`);
    if (!DRY && batchChanged > 0) fs.writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`);
  }

  console.log(`\n完成：wayback ${got}，回退注册时间 ${fallback}，无任何来源 ${none}${DRY ? "（dry）" : ""}`);
  if (!DRY) console.log(`写回 ${FILE}`);
}

void main();