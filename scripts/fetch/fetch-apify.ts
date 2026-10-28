import fs from "node:fs";
import path from "node:path";
import type { AITool, ChannelKey, TrafficTrendPoint } from "@horizons/shared";
import "./config"; // 加载 .env.local
import { fetchVortex, fetchTrafficMetrics } from "./sources/apify";

/**
 * Apify 数据获取：拉取「产品表现」8 指标 + 流量故事数据（渠道/国家/排名/关键词/趋势），
 * 写回 content/aitools.json。
 * 用法：pnpm tsx scripts/fetch/fetch-apify.ts --domain picvo.ai [--dry]
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

const MONTHS: Record<string, string> = {
  January: "01", February: "02", March: "03", April: "04", May: "05", June: "06",
  July: "07", August: "08", September: "09", October: "10", November: "11", December: "12",
};

/** vortex 渠道字段 → ChannelKey */
const CHANNEL_MAP: [keyof Record<string, unknown>, ChannelKey][] = [
  ["directTraffic", "direct"],
  ["searchOrganicTraffic", "organicSearch"],
  ["searchPaidTraffic", "paidSearch"],
  ["referralTraffic", "referral"],
  ["socialTraffic", "organicSocial"],
  ["displayAdsTraffic", "displayAds"],
  ["mailTraffic", "email"],
  ["genAiTraffic", "aiAssistants"],
];

function parseDomain(): string {
  const i = process.argv.indexOf("--domain");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].toLowerCase() : "picvo.ai";
}

function loadTools(): AITool[] {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
}

function saveTools(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

/** "September 2026" → "2026-09" */
function toMonth(date: string | undefined): string | undefined {
  if (!date) return undefined;
  const [m, y] = date.split(" ");
  const mm = MONTHS[m];
  return mm ? `${y}-${mm}` : undefined;
}

/** 统一为「最近 6 个自然月」：以最大月为基准往前数 6 个月，缺失月份补 0（新站无历史时为 0 流量，真实） */
function last6Months(trend: TrafficTrendPoint[]): TrafficTrendPoint[] {
  if (trend.length === 0) return [];
  const sorted = [...trend].sort((a, b) => (a.date < b.date ? -1 : 1));
  const [ly, lm] = sorted[sorted.length - 1].date.split("-").map(Number);
  const months: string[] = [];
  let y = ly;
  let m = lm;
  for (let i = 0; i < 6; i++) {
    months.unshift(`${y}-${String(m).padStart(2, "0")}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const byDate = new Map(sorted.map((t) => [t.date, t]));
  return months.map((d) => byDate.get(d) ?? { date: d, total: 0, organic: 0 });
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

  // 1. vortex 只跑一次：既供 8 指标，也供渠道/国家/排名/关键词/趋势
  const item = await fetchVortex(domain);
  const metrics = await fetchTrafficMetrics(domain, item);
  if (!metrics?.monthlyVisits) {
    console.error(`[apify] ${domain} 无有效流量数据`);
    process.exit(1);
  }
  console.log("[apify] 8 指标：", JSON.stringify(metrics, null, 2));
  tool.trafficMetrics = metrics;

  // 核心指标与 vortex 对齐：月访问量 / 自然搜索 / 环比同源，
  // 避免 enrich-site 写入的 DFS「搜索流量」口径与总访问量混在一张卡上
  tool.metrics = {
    ...(tool.metrics ?? {}),
    monthlyVisits: metrics.monthlyVisits,
    organicVisits: metrics.organicSearchVisits,
    organicShare:
      metrics.monthlyVisits && metrics.organicSearchVisits
        ? Math.round((metrics.organicSearchVisits / metrics.monthlyVisits) * 1000) / 10
        : undefined,
    directVisits: metrics.directVisits,
    momGrowth: metrics.monthlyVisitsGrowth,
  };

  // 2. 复用同一份 vortex 结果，不再二次调用 actor
  if (item) {
    // 渠道份额（0-1 → %）
    const channelShares: Partial<Record<ChannelKey, number>> = {};
    for (const [field, key] of CHANNEL_MAP) {
      const v = (item as unknown as Record<string, number | null | undefined>)[field];
      if (typeof v === "number") channelShares[key] = Math.round(v * 1000) / 10;
    }
    if (Object.keys(channelShares).length) tool.channelShares = channelShares;

    // 国家分布
    if (item.website_traffic_by_country?.length) {
      tool.geoDistribution = item.website_traffic_by_country
        .filter((c) => c.countryName && c.share != null)
        .map((c) => ({ country: c.countryName!, share: Math.round(c.share! * 1000) / 10 }));
    }

    // 排名
    if (item.rankGlobal || item.countryRank) {
      tool.ranks = { global: item.rankGlobal, country: item.countryRank };
    }

    // 关键词
    if (item.topKeywords?.length) {
      tool.keywords = item.topKeywords
        .filter((k) => k.keyword)
        .map((k) => ({
          term: k.keyword!,
          volume: k.searchVolume,
          cpc: k.cpc ?? undefined,
          traffic: k.estimatedValue,
        }));
    }

    // 流量趋势：统一为最近 6 个自然月（新站无历史月份补 0，真实反映从 0 起步）
    // vortex 只给每月总访问量，自然搜索按「最新月自然搜索占比」等比推算（无占比时记 0）
    const organicShare =
      metrics.monthlyVisits && metrics.organicSearchVisits
        ? metrics.organicSearchVisits / metrics.monthlyVisits
        : 0;
    const rawTrend: TrafficTrendPoint[] = (item.monthlyVisits ?? [])
      .map((m) => {
        const date = toMonth(m.month);
        if (!date) return null;
        const total = m.visits ?? 0;
        return {
          date,
          total,
          organic: total > 0 && organicShare > 0 ? Math.round(total * organicShare) : 0,
        };
      })
      .filter((t): t is TrafficTrendPoint => t !== null);
    const trend = last6Months(rawTrend);
    if (trend.length >= 2) tool.trend = trend;
    else if (metrics.monthlyVisits && metrics.snapshotMonth) {
      // 主 actor 无分月明细时，至少保留一个真实月份的点，不编造历史
      tool.trend = [
        {
          date: metrics.snapshotMonth,
          total: metrics.monthlyVisits,
          organic: metrics.organicSearchVisits ?? 0,
        },
      ];
    }

    console.log(
      `[apify] 渠道 ${Object.keys(channelShares).length} 个｜国家 ${tool.geoDistribution?.length ?? 0} 个｜关键词 ${tool.keywords?.length ?? 0} 个｜趋势 ${trend.length} 个月`,
    );
  }

  tool.collectedAt = new Date().toISOString();

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
