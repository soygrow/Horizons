import fs from "node:fs";
import path from "node:path";
import { isBlockedDomain } from "@horizons/shared";
import type { AITool } from "@horizons/shared";
import "./config"; // 加载 .env.local
import { extractTrafficMetrics, fetchLergassyMulti } from "./sources/apify";
import type { SimilarwebRawItem } from "./sources/apify";
import { applyTraffic } from "./apply-traffic";

/* --------------------------- 榜单判定（与 web 侧一致） --------------------------- */
// 与 apps/web/src/lib/data.ts 的 tierOf 保持同步，避免「榜内」口径漂移。
const MIN_VISITS_CORE = 10_000;
const MIN_VISITS_WATCH = 1_000;
const WATCH_PH_UPVOTES = 300;

function visitsOf(t: AITool): number | undefined {
  return t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits;
}

function tierOf(t: AITool): "core" | "watch" | null {
  if (isBlockedDomain(t.domain)) return null;
  const v = visitsOf(t);
  if (v === undefined) return (t.phUpvotes ?? 0) >= WATCH_PH_UPVOTES ? "watch" : null;
  if (v >= MIN_VISITS_CORE) return "core";
  if (v >= MIN_VISITS_WATCH) {
    const g = t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth;
    return typeof g === "number" && g < 0 ? "watch" : "core";
  }
  return null;
}

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

const CACHE_DIR = path.resolve(process.cwd(), "content/cache/api/apify");
const CACHE_TTL_MS = 30 * 86_400_000;
const BATCH_SIZE = 24;

/**
 * 已抓过且未过期的 lergassy 响应：命中则直接复用，不再发起 Actor run。
 * 这些站的数据本就在缓存里，只是从未写回 aitools.json（例如只补过月访问的站），
 * 重新调用属于纯浪费，因此补精细化字段前先吃缓存。
 */
function loadLergassyCache(): Map<string, SimilarwebRawItem> {
  const out = new Map<string, SimilarwebRawItem>();
  if (!fs.existsSync(CACHE_DIR)) return out;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf-8")) as {
        endpoint?: string;
        key?: string;
        at?: string;
        ok?: boolean;
        data?: SimilarwebRawItem;
      };
      if (!r.endpoint?.startsWith("lergassy") || !r.ok || !r.data || !r.key) continue;
      if (r.at && Date.now() - Date.parse(r.at) > CACHE_TTL_MS) continue;
      out.set(String(r.key).toLowerCase(), r.data);
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

/** 是否缺 Similarweb 才能给的字段；repair 模式把「缺渠道/国家/竞品」也算上 */
function lacksSimilarweb(t: AITool, repair: boolean): boolean {
  if (!repair) return visitsOf(t) === undefined;
  const noMetrics = !t.trafficMetrics || !Object.keys(t.trafficMetrics).length;
  const noChannel = !t.channelShares || !Object.keys(t.channelShares).length;
  const noGeo = !t.geoDistribution?.length;
  const noComp = !t.observations?.competitors?.length;
  return noMetrics || noChannel || noGeo || noComp;
}

async function main(): Promise<void> {
  const limit = intFlag("--limit", Number.MAX_SAFE_INTEGER);
  const dry = process.argv.includes("--dry");
  const repair = process.argv.includes("--repair");
  const fromCache = process.argv.includes("--from-cache");
  const force = process.argv.includes("--force");
  const scopeIdx = process.argv.indexOf("--scope");
  const scope = scopeIdx >= 0 ? (process.argv[scopeIdx + 1] ?? "listed") : "listed";

  const tools = loadTools();
  const tried = readTried();
  const retryable = (d: string): boolean => {
    const at = tried[d];
    if (!at) return true;
    return Date.now() - Date.parse(at) > RETRY_DAYS * 86_400_000;
  };

  const targets = tools
    .filter((t) => {
      if (!lacksSimilarweb(t, repair)) return false;
      // 只更新榜内站：不在榜单的站不占采集预算
      if (scope === "listed" && tierOf(t) === null) return false;
      // 待判定：落榜 + 非黑名单 + 无流量数据 + PH 热度有基础，补完流量由原规则重新判定
      if (scope === "pending") {
        if (tierOf(t) !== null) return false;
        if (isBlockedDomain(t.domain)) return false;
        if (visitsOf(t) !== undefined) return false;
        if ((t.phUpvotes ?? 0) < 100) return false;
      }
      // repair 模式的目标站不是「平台查不到」，不受 7 天冷却限制
      if (!repair && !force && !retryable(t.domain)) return false;
      return true;
    })
    .slice(0, limit);

  if (targets.length === 0) {
    console.log(`[backfill] scope=${scope} 没有待补的站`);
    return;
  }

  const cache = fromCache ? loadLergassyCache() : new Map<string, SimilarwebRawItem>();
  console.log(
    `[backfill] scope=${scope}${repair ? " repair" : ""}${fromCache ? " from-cache" : ""}｜目标 ${targets.length} 个｜每批 ${BATCH_SIZE}｜缓存可复用 ${cache.size}`,
  );

  // dry-run 只做本地预览：不发起任何 Actor run，避免「预览」变成真实消耗
  if (dry) {
    const hit = targets.filter((t) => cache.has(t.domain.toLowerCase())).length;
    console.log(`[backfill] dry-run：将调用 ${targets.length - hit} 个、复用缓存 ${hit} 个`);
    console.log("  目标：" + targets.map((t) => t.domain).join(", "));
    return;
  }

  let ok = 0;
  let empty = 0;
  let failed = 0;
  let reused = 0;

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const chunk = targets.slice(i, i + BATCH_SIZE);
    const need = chunk.filter((t) => !cache.has(t.domain.toLowerCase()));

    const fetched = new Map<string, SimilarwebRawItem | null | undefined>();
    if (need.length) {
      const r = await fetchLergassyMulti(need.map((t) => t.domain));
      for (const [k, v] of r) fetched.set(k.toLowerCase(), v);
    }

    for (const t of chunk) {
      const key = t.domain.toLowerCase();
      const hitCache = cache.has(key);
      const raw = hitCache ? cache.get(key) : fetched.get(key);
      if (hitCache) reused++;
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

    // 按批落盘：单批约 2 分钟，避免长任务中断导致前面批次的结果全部丢失
    if (!dry) {
      saveTools(tools);
      writeTried(tried);
    }
    console.log(
      `[backfill] 进度 ${Math.min(i + BATCH_SIZE, targets.length)}/${targets.length}｜成功 ${ok}｜无数据 ${empty}｜失败 ${failed}｜复用缓存 ${reused}`,
    );
  }

  console.log(`[backfill] 完成：成功 ${ok}｜平台无数据 ${empty}｜请求失败 ${failed}｜复用缓存 ${reused}`);
  if (dry) console.log("[backfill] dry-run，未写入");
  else console.log("[backfill] 已写入 content/aitools.json");
}

main().catch((e) => {
  console.error("[backfill] 异常：", e);
  process.exit(1);
});