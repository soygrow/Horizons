import "./config";
import fs from "node:fs";

import { applyTraffic } from "./apply-traffic";
import { extractTrafficMetrics, fetchLergassyMulti } from "./sources/apify";

/**
 * 补齐缺失的全渠道流量（trafficMetrics）。
 *
 * 背景：部分站的 metrics 只有 DFS 的「搜索流量」口径（organic === monthlyVisits，
 * 自然搜索占比恒为 100%），因为 enrich-site 阶段流量抓取失败/未覆盖。
 *
 * 用法：
 *   pnpm tsx scripts/fetch/patch-traffic.ts [--dry] [域名...]
 * 不带域名时读取 /tmp/no-tm.txt。
 *
 * 走 fetchLergassyMulti（批量 + 会打印失败原因），不复用单域的静默缓存。
 */
const DRY = process.argv.includes("--dry");
/** --refresh：已有月访问但缺少趋势/环比的站也重拉，只补空字段 */
const REFRESH = process.argv.includes("--refresh");
const argDomains = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const listPath = "/tmp/no-tm.txt";
const domains = argDomains.length
  ? argDomains
  : fs
      .readFileSync(listPath, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

const file = "content/aitools.json";
const all = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, any>>;

async function main(): Promise<void> {
  let ok = 0;
  let miss = 0;
  /** 任何实际写入都算变更，避免 ok=0 时误判成「无改动」而不落盘 */
  let changed = 0;

  const raw = await fetchLergassyMulti(domains);

  for (const domain of domains) {
    const tool = all.find((t) => t.domain === domain);
    if (!tool) {
      console.log(`✗ ${domain} 不在库中`);
      miss++;
      continue;
    }

    // 1) 全渠道流量
    const thin = !tool.trend || tool.trend.length < 2 || tool.trafficMetrics?.monthlyVisitsGrowth == null;
    if (tool.trafficMetrics?.monthlyVisits && !(REFRESH && thin)) {
      console.log(`- ${domain} 已有 trafficMetrics，跳过流量`);
    } else {
      const item = raw.get(domain);
      if (item === undefined) {
        console.log(`✗ ${domain} 平台故障（可重试）`);
        miss++;
      } else if (!item) {
        console.log(`✗ ${domain} SimilarWeb 无该站数据`);
        miss++;
      } else {
        const metrics = extractTrafficMetrics(item as any);
        if (!metrics?.monthlyVisits) {
          console.log(`✗ ${domain} 未取到月访问量`);
          miss++;
        } else {
          console.log(
            `✓ ${domain} 月访问 ${metrics.monthlyVisits}｜自然 ${metrics.organicSearchVisits ?? "—"}｜直接 ${
              metrics.directVisits ?? "—"
            }`,
          );
          if (!DRY) {
            // 自然搜索量与占比本轮不动：刷新时若新结果没有该渠道，
            // 保留原有值，避免 applyTraffic 整体覆盖把已采到的自然搜索清空
            const prevOrganicVisits = tool.trafficMetrics?.organicSearchVisits;
            const prevOrganicMetric = tool.metrics?.organicVisits;
            const prevShare = tool.metrics?.organicShare;
            applyTraffic(tool as any, item as any, metrics);
            if (tool.trafficMetrics && tool.trafficMetrics.organicSearchVisits == null && prevOrganicVisits != null) {
              tool.trafficMetrics.organicSearchVisits = prevOrganicVisits;
            }
            if (tool.metrics && tool.metrics.organicVisits == null && prevOrganicMetric != null) {
              tool.metrics.organicVisits = prevOrganicMetric;
            }
            if (tool.metrics && tool.metrics.organicShare == null && prevShare != null) {
              tool.metrics.organicShare = prevShare;
            }
            changed++;
          }
          ok++;
        }
      }
    }
  }

  if (!DRY && changed > 0) {
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`\n写回 ${file}：变更 ${changed} 项，流量成功 ${ok}，失败 ${miss}`);
  } else {
    console.log(`\n流量成功 ${ok}，失败 ${miss}${DRY ? "（dry，未写回）" : "（无变更）"}`);
  }
}

void main();