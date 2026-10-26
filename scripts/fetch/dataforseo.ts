import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import {
  hasDataForSEO,
  fetchTrafficEstimate,
  fetchKeywords,
  fetchGeoDistribution,
  fetchTrafficHistory,
} from "./sources/dataforseo";

/**
 * DataForSEO 增强入口：把搜索流量 / 关键词 / 国家分布 / 趋势写入 content/aitools.json。
 *
 * 用法：
 *   pnpm dataforseo              # 仅批量流量估算（便宜，全量）
 *   pnpm dataforseo --full       # 额外跑关键词/国家/趋势（单域名按次计费）
 *   pnpm dataforseo --full --limit 20   # --full 时限制处理数量
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

function loadTools(): AITool[] {
  try {
    return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  } catch {
    return [];
  }
}

function saveTools(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

function parseLimit(): number {
  const i = process.argv.indexOf("--limit");
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0; // 0 = 全部
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  if (!hasDataForSEO()) {
    console.error(
      "[dataforseo] 未配置 DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD，请在 .env.local 填写后重试",
    );
    process.exit(1);
  }

  const full = process.argv.includes("--full");
  const limit = parseLimit();
  const tools = loadTools();
  const domains = tools.map((t) => t.domain).filter(Boolean);

  console.log(
    `[dataforseo] 开始：${domains.length} 个域名${full ? "（含关键词/国家/趋势）" : "（仅流量估算）"}`,
  );

  // 1) 批量流量估算（一次最多 1000 域名，超量时需分批，TODO）
  const traffic = await fetchTrafficEstimate(domains.slice(0, 1000));
  let trafficUpdated = 0;
  for (const tool of tools) {
    const t = traffic.get(tool.domain);
    if (t) {
      tool.traffic = {
        ...tool.traffic,
        organicVisits: t.organicVisits,
        paidVisits: t.paidVisits,
      };
      trafficUpdated++;
    }
  }
  console.log(`[dataforseo] 流量估算完成，更新 ${trafficUpdated} 个`);

  // 2) 单域名增强（关键词/国家/趋势），按次计费，仅在 --full 时执行
  if (full) {
    let processed = 0;
    for (const tool of tools) {
      if (limit > 0 && processed >= limit) break;
      if (!tool.domain) continue;
      processed++;

      await sleep(500);
      try {
        const keywords = await fetchKeywords(tool.domain);
        if (keywords.length > 0) tool.keywords = keywords;

        const geo = await fetchGeoDistribution(tool.domain);
        if (geo.length > 0) tool.geoDistribution = geo;

        const history = await fetchTrafficHistory(tool.domain);
        if (history.length > 0) tool.trafficHistory = history;

        console.log(
          `[dataforseo] ${tool.domain}: kw=${keywords.length} geo=${geo.length} hist=${history.length}`,
        );
      } catch (e) {
        console.warn(
          `[dataforseo] ${tool.domain} 失败：`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  const now = new Date().toISOString();
  for (const t of tools) t.collectedAt = now;
  saveTools(tools);
  console.log(`[dataforseo] 完成：写入 ${tools.length} 条`);
}

main().catch((e) => {
  console.error("[dataforseo] 失败：", e);
  process.exit(1);
});
