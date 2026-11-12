/**
 * 工具榜概览快照生成器。
 *
 * 后台不能直接读 content/aitools.json（8MB，Worker 内存吃不消），
 * 所以由流水线在抓取/发布后顺手写一份轻量快照 content/tools-stats.json，
 * 后台只读这个几百字节的文件。
 *
 * 判定口径统一由 @horizons/shared 的 tool-tier 提供，本文件不再维护副本。
 *
 * 用法：pnpm tsx scripts/admin/tool-stats.ts
 */
import fs from "node:fs";
import path from "node:path";
import { tierOf, visitsOf } from "@horizons/shared";
import type { AITool, ToolTier } from "@horizons/shared";
import { saveReport } from "./reports";
import { readWorkspace } from "./board-items";
import type { StagingItem } from "./verdict";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOLS_PATH = path.join(ROOT, "content/aitools.json");
const STATS_PATH = path.join(ROOT, "content/tools-stats.json");

/** 榜单目标条数（与 data.ts 的 MAX_LISTED_TOOLS 一致） */
export const TARGET_LISTED = 1000;

/* --------------------------- 收录口径（来自 shared） --------------------------- */
export { tierOf, visitsOf };
export type Tier = ToolTier;

/* --------------------------------- 快照结构 --------------------------------- */

export interface ToolStats {
  generatedAt: string;
  target: number;
  /** content/aitools.json 全部候选 */
  candidates: number;
  /** 达到收录门槛（未考虑 1000 条上限） */
  qualified: number;
  /** 实际会出现在榜单上的条数（qualified 与 target 取小） */
  listed: number;
  core: number;
  watch: number;
  /** 有月访问量的候选数 */
  withTraffic: number;
  /** 待发布队列：pending=待判断/待确认，approved=已确认待富化，enriched=可发榜 */
  staging: { pending: number; approved: number; enriched: number; rejected: number };
  /** 距离目标的缺口 */
  gap: number;
}

export function computeToolStats(
  tools: AITool[],
  stagingItems: StagingItem[],
  rejected: string[],
): ToolStats {
  let core = 0;
  let watch = 0;
  let withTraffic = 0;

  for (const t of tools) {
    if (visitsOf(t) !== undefined) withTraffic++;
    const tier = tierOf(t);
    if (tier === "core") core++;
    else if (tier === "watch") watch++;
  }

  const qualified = core + watch;
  const listed = Math.min(qualified, TARGET_LISTED);
  return {
    generatedAt: new Date().toISOString(),
    target: TARGET_LISTED,
    candidates: tools.length,
    qualified,
    listed,
    core,
    watch,
    withTraffic,
    staging: {
      pending: stagingItems.filter((i) => !i.stage || i.stage === "candidate").length,
      approved: stagingItems.filter((i) => i.stage === "approved").length,
      enriched: stagingItems.filter((i) => i.stage === "enriched").length,
      rejected: rejected.length,
    },
    gap: Math.max(0, TARGET_LISTED - listed),
  };
}

/* --------------------------------- 读写文件 --------------------------------- */

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeToolStats(): Promise<ToolStats> {
  const tools = readJson<AITool[]>(TOOLS_PATH, []);
  // 队列统计取自 D1（候选池唯一来源）；未配置 D1 时为空，不影响正式库口径
  const { items, rejected } = await readWorkspace<StagingItem>("tools");
  const stats = computeToolStats(tools, items, rejected);

  const tmp = `${STATS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, STATS_PATH);

  /* 后台只读 D1：文件照写，同一份快照再落一次库 */
  await saveReport("tools-stats", stats, "tool-stats");
  return stats;
}

/** 供流水线日志使用的一行摘要 */
export function statsLine(stats: ToolStats): string {
  return (
    `候选 ${stats.candidates}｜达标 ${stats.qualified}（core ${stats.core} / watch ${stats.watch}）` +
    `｜上榜 ${stats.listed}/${stats.target}｜缺口 ${stats.gap}` +
    `｜队列 待确认 ${stats.staging.pending} / 已确认 ${stats.staging.approved} / 可发榜 ${stats.staging.enriched}`
  );
}

// 直接执行时刷新快照；被 publish-tools.ts import 时不自动跑
if (process.argv[1]?.endsWith("tool-stats.ts")) {
  writeToolStats()
    .then((stats) => {
      console.log(`[stats] ${statsLine(stats)}`);
      console.log(`[stats] 已写入 content/tools-stats.json`);
    })
    .catch((e: unknown) => {
      console.error("[stats] 失败：", e);
      process.exitCode = 1;
    });
}