/**
 * 单站补齐「域名权重」。
 * 优先级：
 *   1) Apify datascraperes/bulk-domain-rating-checker 的 domainRating（Ahrefs DR，0~100）—— 主口径，label="DR"；
 *   2) DataForSEO backlinks/summary 的 rank（0~1000，类 DR 的域名等级）—— label="权重"；
 *   3) 若前两者均无，回退到已抓取的 SimilarWeb 全球排名（ranks.global），label="全球排名"。
 * 用法：pnpm tsx scripts/fetch/fetch-domain-weight.ts --domain picvo.ai
 * 写入 tool.metrics.domainWeight 与 domainWeightLabel。
 */
import fs from "node:fs";
import path from "node:path";
import "./config"; // 加载 .env.local（含 APIFY_TOKEN / DATAFORSEO_LOGIN/PASSWORD）
import { fetchDomainRating } from "./sources/apify";
import { fetchBacklinksSummary } from "./sources/dataforseo";
import type { AITool } from "@horizons/shared";

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

function parseDomain(): string {
  const i = process.argv.indexOf("--domain");
  return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1].toLowerCase() : "picvo.ai";
}

function persist(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

async function main(): Promise<void> {
  const domain = parseDomain();
  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  const tool = tools.find((t) => t.domain === domain);
  if (!tool) {
    console.error(`[fetch-domain-weight] 未找到 ${domain}`);
    process.exit(1);
  }

  // 1) Apify 主口径（DR，0~100）
  const dr = await fetchDomainRating(domain);
  if (dr !== null) {
    tool.metrics = { ...(tool.metrics ?? {}), domainWeight: dr, domainWeightLabel: "DR" };
    persist(tools);
    console.log(`[fetch-domain-weight] ${domain} 域名权重(DR)= ${dr}（DR）`);
    return;
  }
  console.warn(`[fetch-domain-weight] ${domain} Apify 无 DR，回退 DataForSEO`);

  // 2) DataForSEO 次口径
  const summary = await fetchBacklinksSummary(domain);
  if (summary && summary.domainWeight > 0) {
    tool.metrics = { ...(tool.metrics ?? {}), domainWeight: summary.domainWeight, domainWeightLabel: "权重" };
    persist(tools);
    console.log(`[fetch-domain-weight] ${domain} 域名权重(DFS)= ${summary.domainWeight}（权重）`);
    return;
  }
  console.warn(`[fetch-domain-weight] ${domain} DFS 无域名等级，回退 SimilarWeb 全球排名`);

  // 3) 回退：SimilarWeb 全球排名
  const globalRank = tool.ranks?.global;
  if (globalRank && globalRank > 0) {
    tool.metrics = { ...(tool.metrics ?? {}), domainWeight: globalRank, domainWeightLabel: "全球排名" };
    persist(tools);
    console.log(`[fetch-domain-weight] ${domain} 域名权重(全球排名)= ${globalRank}（全球排名）`);
    return;
  }

  console.warn(`[fetch-domain-weight] ${domain} 无任何域名权重来源，保持待接入`);
}

main().catch((e) => {
  console.error("[fetch-domain-weight] 失败：", e);
  process.exit(1);
});
