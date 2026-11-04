/**
 * 修复详情页基础指标的三类「假空值」。
 *
 *   1) --direct-zero  直接访问量写成 0 的假值（数据源没给份额 ≠ 访问量为 0）
 *   2) --registered   用 RDAP 补注册时间（含 Verisign 回退）
 *   3) --weight       域名权重无 DR/DFS 来源时，回退 SimilarWeb 全球排名
 *
 * 不带参数时三项全做。全部免费，不消耗付费额度。
 * 用法：pnpm tsx scripts/fetch/repair-basics.ts [--direct-zero] [--registered] [--weight] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import "./config"; // 加载 .env.local
import { fetchRegistrationDate } from "./sources/site-audit";
import type { AITool } from "@horizons/shared";

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");
const args = process.argv.slice(2);
const has = (flag: string): boolean => args.includes(flag);
const dry = has("--dry");

function persist(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

/** 简单并发池：限制同时在飞的任务数，避免把 RDAP 打成 DDoS */
async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  const doAll = !has("--direct-zero") && !has("--registered") && !has("--weight");

  // 1) 直接访问量假 0：只有 channelShares 里确实有 direct 份额时，0 才是真的
  if (doAll || has("--direct-zero")) {
    let cleaned = 0;
    for (const tool of tools) {
      const tm = tool.trafficMetrics;
      if (!tm) continue;
      const knownDirect = tool.channelShares?.direct !== undefined;
      if (tm.directVisits === 0 && !knownDirect) {
        delete tm.directVisits;
        const m = tool.metrics as { directVisits?: number } | undefined;
        if (m?.directVisits === 0) delete m.directVisits;
        cleaned++;
      }
    }
    console.log(`[repair] 直接访问假 0 → 未采集：${cleaned} 站`);
    if (!dry && cleaned > 0) persist(tools);
  }

  // 2) 注册时间
  if (doAll || has("--registered")) {
    const targets = tools.filter((t) => !t.metrics?.registeredAt);
    console.log(`[repair] 待补注册时间：${targets.length} 站`);
    let ok = 0;
    let done = 0;
    await mapLimit(targets, 4, async (tool) => {
      const date = await fetchRegistrationDate(tool.domain);
      done++;
      if (date) {
        tool.metrics = { ...(tool.metrics ?? {}), registeredAt: date };
        ok++;
      }
      if (done % 20 === 0) {
        console.log(`  进度 ${done}/${targets.length}｜命中 ${ok}`);
        if (!dry) persist(tools);
      }
    });
    console.log(`[repair] 注册时间：命中 ${ok}/${targets.length}`);
    if (!dry) persist(tools);
  }

  // 3) 域名权重回退：没有 DR / DFS 等级时用 SimilarWeb 全球排名（越小越强）
  if (doAll || has("--weight")) {
    let filled = 0;
    for (const tool of tools) {
      if (tool.metrics?.domainWeight !== undefined) continue;
      const global = tool.ranks?.global;
      if (typeof global === "number" && global > 0) {
        tool.metrics = {
          ...(tool.metrics ?? {}),
          domainWeight: global,
          domainWeightLabel: "全球排名",
        };
        filled++;
      }
    }
    console.log(`[repair] 域名权重回退全球排名：${filled} 站`);
    if (!dry && filled > 0) persist(tools);
  }

  if (dry) console.log("[repair] dry-run，未写入");
}

main().catch((e: unknown) => {
  console.error("[repair] 失败：", e);
  process.exit(1);
});