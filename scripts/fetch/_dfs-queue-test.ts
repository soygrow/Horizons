/**
 * 临时验证脚本：确认各 DFS 端点是否支持 standard 队列（task_post/task_get）。
 * 用法：pnpm tsx scripts/fetch/_dfs-queue-test.ts [domain]
 * 验证完即删除。
 */
import "./config";
import {
  hasDataForSEO,
  fetchKeywords,
  fetchGeoDistribution,
  fetchTrafficHistory,
  fetchBacklinksSummary,
  fetchCompetitors,
  fetchRelatedKeywords,
  fetchTrafficEstimate,
  fetchWhois,
} from "./sources/dataforseo";

const domain = process.argv[2] ?? "picvo.ai";

async function timed<T>(label: string, fn: () => Promise<T>, pick: (v: T) => string): Promise<void> {
  const t0 = Date.now();
  try {
    const v = await fn();
    console.log(`✅ ${label} ${((Date.now() - t0) / 1000).toFixed(1)}s → ${pick(v)}`);
  } catch (e) {
    console.log(`❌ ${label} ${((Date.now() - t0) / 1000).toFixed(1)}s → ${e instanceof Error ? e.message : e}`);
  }
}

async function main(): Promise<void> {
  if (!hasDataForSEO()) {
    console.error("缺少 DATAFORSEO 凭据");
    process.exit(1);
  }
  console.log(`[queue-test] 目标 ${domain}｜DFS_QUEUE=${process.env.DFS_QUEUE ?? "standard(默认)"}`);

  await timed("bulk_traffic_estimation", () => fetchTrafficEstimate([domain]), (m) => `${m.size} 条`);
  await timed("ranked_keywords", () => fetchKeywords(domain, 10), (v) => `${v.length} 个关键词`);
  await timed("domain_rank_overview", () => fetchGeoDistribution(domain), (v) => `${v.length} 个国家`);
  await timed("historical_rank_overview", () => fetchTrafficHistory(domain), (v) => `${v.history.length} 个月`);
  await timed("backlinks/summary", () => fetchBacklinksSummary(domain), (v) => (v ? `${v.total} 外链` : "null"));
  await timed("competitors_domain", () => fetchCompetitors(domain, 8), (v) => `${v.length} 个竞品`);
  await timed("related_keywords", () => fetchRelatedKeywords([domain.split(".")[0]], 15), (v) => `${v.length} 个`);
  await timed("whois/overview", () => fetchWhois(domain), (v) => v ?? "undefined");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});