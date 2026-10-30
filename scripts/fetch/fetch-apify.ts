import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import "./config"; // 加载 .env.local
import { fetchLergassy, fetchTrafficMetrics } from "./sources/apify";
import { applyTraffic } from "./apply-traffic";

/**
 * Apify 数据获取：拉取「产品表现」8 指标 + 渠道/国家/排名/趋势，写回 content/aitools.json。
 *
 * 2026-10 实测：主 Actor vortex_data/similarweb-scraper 对所有域名（含 picvo.ai、
 * claude.com）均返回空数组，已不可用；lergassy/similarweb-traffic-scraper 正常
 * 且不产生费用，因此以它为唯一可用源。
 *
 * 用法：pnpm tsx scripts/fetch/fetch-apify.ts --domain picvo.ai [--dry]
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

function parseDomain(): string {
  const i = process.argv.indexOf("--domain");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].toLowerCase() : "picvo.ai";
}

function loadTools(): AITool[] {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
}

function saveTools(tools: AITool[]): void {
  // 原子写：先写临时文件再 rename，避免中断把唯一数据源写坏
  const tmp = `${TOOLS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tools, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, TOOLS_PATH);
}

async function main(): Promise<void> {
  const domain = parseDomain();
  const dry = process.argv.includes("--dry");
  console.log(`[apify] 目标：${domain}${dry ? "（dry-run）" : ""}`);

  const tools = loadTools();
  const tool = tools.find((t) => t.domain === domain);
  if (!tool) {
    console.error(`[apify] 未找到 ${domain}`);
    process.exit(1);
  }

  // 原始条目提供渠道/国家/排名/趋势；8 指标内部命中同一份缓存，不会二次请求
  const raw = await fetchLergassy(domain);
  const metrics = await fetchTrafficMetrics(domain);
  if (!metrics?.monthlyVisits) {
    console.error(`[apify] ${domain} 无有效流量数据`);
    process.exit(1);
  }
  console.log("[apify] 8 指标：", JSON.stringify(metrics, null, 2));

  applyTraffic(tool, raw, metrics);
  tool.collectedAt = new Date().toISOString();
  console.log(
    `[apify] 渠道 ${Object.keys(tool.channelShares ?? {}).length} 个｜国家 ${tool.geoDistribution?.length ?? 0} 个｜趋势 ${tool.trend?.length ?? 0} 个月`,
  );

  if (dry) {
    console.log("[apify] dry-run，未写入");
  } else {
    saveTools(tools);
    console.log(`[apify] 已写入 ${domain}`);
  }
}

main().catch((e) => {
  console.error("[apify] 失败：", e);
  process.exit(1);
});