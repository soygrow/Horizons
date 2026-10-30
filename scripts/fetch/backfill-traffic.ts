import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import "./config"; // 加载 .env.local
import { extractTrafficMetrics, fetchLergassyMulti } from "./sources/apify";
import { applyTraffic } from "./apply-traffic";

/**
 * 批量补齐「缺月访问量」的站。
 *
 * 用法：
 *   pnpm tsx scripts/fetch/backfill-traffic.ts [--limit 50] [--dry]
 *
 * 效率：底层按 25 个域名一次 Actor run，235 个站约 7~10 分钟；
 *       逐个查询则要 42s × 235 ≈ 2.7 小时。
 *
 * 安全性：
 *   - 全部结果先在内存中更新，结束后一次性原子写盘，中途中断不会写坏文件；
 *   - 已有月访问量的站自动跳过（兼容 metrics 与 trafficMetrics 两种口径）；
 *   - 平台确实查不到的站记入 content/cache/traffic-tried.json，7 天内不再重试。
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");
const TRIED_PATH = path.resolve(process.cwd(), "content/cache/traffic-tried.json");
const RETRY_DAYS = 7;

function intFlag(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function loadTools(): AITool[] {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
}

function saveTools(tools: AITool[]): void {
  const tmp = `${TOOLS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tools, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, TOOLS_PATH);
}

function readTried(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(TRIED_PATH, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeTried(tried: Record<string, string>): void {
  fs.mkdirSync(path.dirname(TRIED_PATH), { recursive: true });
  fs.writeFileSync(TRIED_PATH, JSON.stringify(tried, null, 2) + "\n", "utf-8");
}

async function main(): Promise<void> {
  const limit = intFlag("--limit", Number.MAX_SAFE_INTEGER);
  const dry = process.argv.includes("--dry");

  const tools = loadTools();
  const tried = readTried();
  const retryable = (d: string): boolean => {
    const at = tried[d];
    if (!at) return true;
    return Date.now() - Date.parse(at) > RETRY_DAYS * 86_400_000;
  };

  const targets = tools
    .filter((t) => {
      // 已有数据可能落在 metrics（历史口径）或 trafficMetrics（SimilarWeb 口径），
      // 只认其中一个会把另一个来源的站误判为「缺失」并重复采集
      const known = t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits;
      return known === undefined && retryable(t.domain);
    })
    .slice(0, limit);

  if (targets.length === 0) {
    console.log("[backfill] 没有待补的站（缺失的都已确认平台无数据，7 天后才会重试）");
    return;
  }
  console.log(`[backfill] 待补 ${targets.length} 个｜每批 25 个${dry ? "（dry-run）" : ""}`);

  const domains = targets.map((t) => t.domain);
  const result = await fetchLergassyMulti(domains);

  let ok = 0;
  let empty = 0;
  let failed = 0;
  for (const t of targets) {
    const raw = result.get(t.domain);
    if (raw === undefined) {
      // 网络/平台故障：本轮没拿到结果，不记入 tried，下次仍会重试
      failed++;
      continue;
    }
    const metrics = raw ? extractTrafficMetrics(raw) : null;
    if (!metrics?.monthlyVisits) {
      empty++;
      tried[t.domain] = new Date().toISOString();
      continue;
    }
    applyTraffic(t, raw, metrics);
    t.collectedAt = new Date().toISOString();
    delete tried[t.domain];
    ok++;
  }

  console.log(`[backfill] 成功 ${ok}｜平台无数据 ${empty}｜请求失败 ${failed}`);

  if (dry) {
    console.log("[backfill] dry-run，未写入");
    return;
  }
  saveTools(tools);
  writeTried(tried);
  console.log("[backfill] 已写入 content/aitools.json");
}

main().catch((e) => {
  console.error("[backfill] 异常：", e);
  process.exit(1);
});