/**
 * 后台「获取新工具」入口（由 .github/workflows/fetch-tools.yml 调用）。
 *
 * 与 `pnpm fetch` 的区别：结果**不写** content/aitools.json，而是落到
 * content/tools-staging.json 等待后台审核；审核通过后由 publish-tools.ts 合并进正式库。
 *
 * 抓取源与本地一致（Product Hunt），流量富化复用 backfill-traffic 的批次口径，
 * 因此后台点一次按钮 = 本地跑一次 pnpm fetch + backfill-traffic。
 *
 * 用法：
 *   pnpm tsx scripts/admin/fetch-staging.ts --count 60 --order newest --enrich
 *   pnpm tsx scripts/admin/fetch-staging.ts --count 20 --dry
 */
import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import { config } from "../fetch/config"; // 顺带加载 .env.local
import { fetchProductHuntTools, closePHBrowser } from "../fetch/sources/productHunt";
import { fetchHackerNewsTools } from "../fetch/sources/hackerNews";
import { fetchFazierTools } from "../fetch/sources/fazier";
import { fetchFuturepediaTools } from "../fetch/sources/futurepedia";
import { loadExisting } from "../fetch/dedupe";
import { extractTrafficMetrics, fetchLergassyMulti, hasApify } from "../fetch/sources/apify";
import { applyTraffic } from "../fetch/apply-traffic";
import { probeAll } from "./probe";
import { syncCandidates } from "./board-items";
import {
  judge,
  visitsOf,
  MIN_VISITS_WATCH,
  WATCH_PH_UPVOTES,
  type StagingFile,
  type StagingItem,
} from "./verdict";

export type { StagingFile };

const ROOT = path.resolve(import.meta.dirname, "../..");
const STAGING_PATH = path.join(ROOT, "content/tools-staging.json");

/** 与 backfill-traffic.ts 一致的批大小：一次 Actor run 处理 24 个域名 */
const ENRICH_BATCH = 24;
/** 单次最多抓 200 个：再多 Actions 容易超时，且后台一次审核不过来 */
const MAX_COUNT = 200;

/* ------------------------------- 参数解析 ------------------------------- */

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(name: string, fallback: number): number {
  const raw = Number(arg(name));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), MAX_COUNT);
}

/* ------------------------------- 文件读写 ------------------------------- */

function loadStaging(): StagingFile {
  try {
    const raw = JSON.parse(fs.readFileSync(STAGING_PATH, "utf-8")) as Partial<StagingFile>;
    return {
      updatedAt: raw.updatedAt ?? new Date(0).toISOString(),
      items: Array.isArray(raw.items) ? raw.items : [],
      rejected: Array.isArray(raw.rejected) ? raw.rejected : [],
      lastRun: raw.lastRun,
      lastEnrich: raw.lastEnrich,
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), items: [], rejected: [] };
  }
}

/** 原子写：先写临时文件再 rename，中断不会把待发布队列写坏 */
function saveStaging(data: StagingFile): void {
  const tmp = `${STAGING_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, STAGING_PATH);
}

/* ------------------------------- 站点存活探测 ------------------------------- */
/* probeAlive / probeAll 在 ./probe.ts，与 audit-existing.ts 共用同一份规则 */

/* ------------------------------- 流量富化 ------------------------------- */

/**
 * 补 Similarweb 流量：没有月访问量的站进不了主榜（只能靠 PH 热度进观察区），
 * 所以新抓的站尽量一次补齐。单域成本近乎为 0（实测 528 次共 $0.0056）。
 */
async function enrichTraffic(items: AITool[]): Promise<number> {
  if (items.length === 0) return 0;
  if (!hasApify()) {
    console.warn("[staging] 未配置 APIFY_TOKEN，跳过流量富化");
    return 0;
  }

  let ok = 0;
  for (let i = 0; i < items.length; i += ENRICH_BATCH) {
    const chunk = items.slice(i, i + ENRICH_BATCH);
    const fetched = await fetchLergassyMulti(chunk.map((t) => t.domain));
    for (const tool of chunk) {
      const raw = fetched.get(tool.domain.toLowerCase());
      // undefined = 网络/平台故障，null = 平台确实没有该站数据，两者都不写
      if (!raw) continue;
      const metrics = extractTrafficMetrics(raw);
      if (!metrics?.monthlyVisits) continue;
      applyTraffic(tool, raw, metrics);
      tool.collectedAt = new Date().toISOString();
      ok++;
    }
    console.log(
      `[staging] 富化进度 ${Math.min(i + ENRICH_BATCH, items.length)}/${items.length}｜成功 ${ok}`,
    );
  }
  return ok;
}

/* ------------------------------- 多源合并抓取 ------------------------------- */

/**
 * 三源合并。
 *
 * 顺序是刻意的：HN 走公开 API、直接给真实域名，最稳；Futurepedia 一个请求
 * 就能拿完；Product Hunt 放最后兜底 —— 它的 `/r/` 短链已被 Cloudflare
 * 挑战覆盖（服务端 403、有头 Chrome 停在验证页），每条约 7s 空转，
 * 不该占用前两个源的预算。
 *
 * 三个源共用同一份 `existingNames` / `seen`，先到先得，天然去重。
 * 任一源抛错只降级不中断，避免一个源挂掉拖垮整轮采集。
 */
async function fetchAllSources(
  count: number,
  order: "VOTES" | "NEWEST",
  topic: string,
  existingNames: Set<string>,
  seen: Set<string>,
): Promise<AITool[]> {
  const out: AITool[] = [];

  // Fazier 放第一：和 PH 同形态（名字 + 一句话 + 票数 + 官网直链），
  // 单页就能出 50 条左右，是当前唯一能稳定撑起产量的源。
  try {
    const fz = await fetchFazierTools(count, existingNames, seen);
    out.push(...fz.items);
  } catch (e) {
    console.warn(`[staging] Fazier 抓取失败：${e instanceof Error ? e.message : e}`);
  }

  if (out.length < count) {
    try {
      const hn = await fetchHackerNewsTools(count - out.length, existingNames, seen);
      out.push(...hn.items);
    } catch (e) {
      console.warn(`[staging] HN 抓取失败：${e instanceof Error ? e.message : e}`);
    }
  }

  if (out.length < count) {
    try {
      const fp = await fetchFuturepediaTools(count - out.length, existingNames, seen);
      out.push(...fp.items);
    } catch (e) {
      console.warn(`[staging] Futurepedia 抓取失败：${e instanceof Error ? e.message : e}`);
    }
  }

  if (out.length < count) {
    try {
      const ph = await fetchProductHuntTools(
        count - out.length,
        order,
        topic,
        existingNames,
        seen,
      );
      out.push(...ph);
    } catch (e) {
      console.warn(`[staging] Product Hunt 抓取失败：${e instanceof Error ? e.message : e}`);
    } finally {
      await closePHBrowser();
    }
  }

  console.log(`[staging] 三源合并完成：${out.length}/${count}`);
  return out;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main(): Promise<void> {
  const dryRun = has("dry");
  const enrich = !has("no-enrich");
  const count = intArg("count", config.maxPerRun);
  const order = arg("order") === "newest" ? ("NEWEST" as const) : ("VOTES" as const);
  const topic = arg("topic") ?? config.productHunt.topicSlugs[0];

  const staging = loadStaging();
  const existing = loadExisting();

  // 已发布 + 待发布 + 已拒绝，三类都算「见过」，避免重复抓取占额度
  const seen = new Set<string>([
    ...existing.map((t) => t.domain),
    ...staging.items.map((t) => t.domain),
    ...staging.rejected,
  ]);
  const existingNames = new Set([
    ...existing.map((t) => t.name.toLowerCase()),
    ...staging.items.map((t) => t.name.toLowerCase()),
  ]);

  console.log(
    `[staging] 目标 ${count} 个｜来源 Fazier + HN + Futurepedia + Product Hunt(${order}/${topic})` +
      `｜富化 ${enrich ? "开" : "关"}${dryRun ? "｜dry-run" : ""}`,
  );

  const fresh: AITool[] = await fetchAllSources(count, order, topic, existingNames, seen);
  console.log(`[staging] 新增候选 ${fresh.length}/${count} 个（跳过原因见上方 [fetch] 日志）`);

  if (fresh.length === 0) {
    console.log("[staging] 无新增，staging 未变动");
    console.log(JSON.stringify({ added: 0, enriched: 0, total: staging.items.length }));
    return;
  }

  const enriched = enrich ? await enrichTraffic(fresh) : 0;
  console.log(`[staging] 流量判定字段就绪 ${enriched}/${fresh.length}`);

  // 第二阶段之前的「判定」：只靠 A1–A4 必需字段定 tier，
  // 不做 DFS 关键词/外链/AI 解读——那部分要等人工确认收录后再手动触发。
  // 探活短路：流量和 PH 票都不够的条目，A4 已经能判死，再发一次 GET 纯属浪费
  const needProbe = has("no-probe")
    ? []
    : fresh.filter((t) => {
        const v = visitsOf(t);
        if (v !== undefined) return v >= MIN_VISITS_WATCH;
        return (t.phUpvotes ?? 0) >= WATCH_PH_UPVOTES;
      });
  const skippedProbe = fresh.length - needProbe.length;
  if (skippedProbe > 0) {
    console.log(`[staging] 跳过探活 ${skippedProbe} 个（流量与 PH 票均不足，A4 已可判定）`);
  }
  const aliveMap: Map<string, boolean | null> = needProbe.length
    ? await probeAll(needProbe)
    : new Map<string, boolean | null>();
  console.log(`[staging] 存活探测 ${needProbe.length} 个`);
  const items: StagingItem[] = fresh.map((t) => {
    const verdict = judge(t, aliveMap.get(t.domain) ?? null);
    return { ...t, verdict, stage: verdict.tier === "reject" ? "rejected" : "candidate" };
  });
  const tally = { core: 0, watch: 0, reject: 0 };
  for (const it of items) tally[it.verdict!.tier]++;
  console.log(
    `[staging] 判定结果：主榜 ${tally.core}｜观察区 ${tally.watch}｜不收录 ${tally.reject}`,
  );

  if (dryRun) {
    console.log("[staging] dry-run，以下为将写入的条目：");
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  const merged: StagingFile = {
    updatedAt: new Date().toISOString(),
    items: [...staging.items, ...items],
    // 新抓到的域名若命中拒绝名单会进来，这里再兜一层
    rejected: staging.rejected.filter((d) => !fresh.some((t) => t.domain === d)),
    lastRun: {
      at: new Date().toISOString(),
      requested: count,
      added: fresh.length,
      skipped: Math.max(0, count - fresh.length),
      judged: items.length,
      enriched: 0,
    },
    lastEnrich: staging.lastEnrich,
  };
  saveStaging(merged);
  console.log(
    `[staging] 已写入 content/tools-staging.json｜待发布 ${merged.items.length} 条（本次 +${fresh.length}）`,
  );

  // 同时落库：后台只读 D1，文件仅作发布脚本的兜底输入
  const saved = await syncCandidates(
    "tools",
    merged.items.map((t) => ({
      itemKey: t.domain,
      name: t.name,
      url: t.url ?? null,
      cats: t.categories ?? null,
      status: t.stage === "rejected" ? "rejected" : "candidate",
      judge: t.verdict,
      card: t,
    })),
  );
  if (saved > 0) console.log(`[staging] 已同步 ${saved} 条到 D1 board_items`);
  // Actions 日志里以单行 JSON 结尾，方便人工与脚本解析
  console.log(
    JSON.stringify({
      added: fresh.length,
      judged: items.length,
      core: tally.core,
      watch: tally.watch,
      reject: tally.reject,
      total: merged.items.length,
    }),
  );
}

main().catch((e) => {
  console.error("[staging] 失败：", e);
  process.exit(1);
});