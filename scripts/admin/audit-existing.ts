/**
 * 存量重判：发布前对已经在榜的条目做一次体检，找出「应该下榜」的。
 *
 * 为什么需要这一步：
 *   榜单只在发布时新增条目，从不重新判定老条目。站点挂掉、流量跌到 1000 以下的
 *   条目会永久留在榜上——而 data.ts 的 tierOf 又会在构建时静默把它们过滤掉，
 *   结果就是「后台看不到原因，线上某天突然少了一条」。
 *
 * 成本（209 条存量）：
 *   默认（只用现有数据重算）        $0
 *   --traffic（批量查 Similarweb）  约 $0.00001/域，合计约 $0.002
 *   --probe（HTTP 探活）             $0，约 5 分钟
 *
 * 输出 content/tools-audit.json 供后台预览展示。
 * 默认**不改动** aitools.json；只有加 --apply-drops 才会真的把下榜条目移除。
 *
 * 用法：
 *   pnpm tsx scripts/admin/audit-existing.ts --dry
 *   pnpm tsx scripts/admin/audit-existing.ts --traffic --probe
 *   pnpm tsx scripts/admin/audit-existing.ts --traffic --probe --apply-drops
 */
import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import "../fetch/config"; // 副作用导入：加载 .env.local 里的 APIFY_TOKEN
import { extractTrafficMetrics, fetchLergassyMulti, hasApify } from "../fetch/sources/apify";
import { applyTraffic } from "../fetch/apply-traffic";
import { probeAll } from "./probe";
import { judge, visitsOf, type VerdictTier } from "./verdict";
import { saveReport } from "./reports";
import { statsLine, writeToolStats } from "./tool-stats";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOLS_PATH = path.join(ROOT, "content/aitools.json");
const AUDIT_PATH = path.join(ROOT, "content/tools-audit.json");
/** 与 backfill-traffic.ts 一致：一次 Actor run 处理 24 个域名 */
const ENRICH_BATCH = 24;

export interface AuditDropped {
  domain: string;
  name: string;
  tier: VerdictTier;
  reason: string;
  monthlyVisits?: number;
  phUpvotes?: number;
}

export interface AuditReport {
  generatedAt: string;
  /** 本次是否刷新过 Similarweb 流量 */
  refreshedTraffic: boolean;
  /** 本次是否做过存活探测 */
  probed: boolean;
  total: number;
  before: { core: number; watch: number; qualified: number };
  after: { core: number; watch: number; qualified: number };
  dropped: AuditDropped[];
  /** 本次因流量下滑从 core 跌到 watch 的（不下榜，但值得看） */
  degraded: Array<{ domain: string; name: string; monthlyVisits?: number }>;
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function tally(tools: AITool[]): { core: number; watch: number; qualified: number } {
  let core = 0;
  let watch = 0;
  for (const t of tools) {
    const tier = judge(t).tier;
    if (tier === "core") core++;
    else if (tier === "watch") watch++;
  }
  return { core, watch, qualified: core + watch };
}

/** 批量刷新 Similarweb 流量，只对成功返回的条目写入 */
async function refreshTraffic(tools: AITool[]): Promise<number> {
  if (!hasApify()) {
    console.warn("[audit] 未配置 APIFY_TOKEN，跳过流量刷新（只用现有数据重判）");
    return 0;
  }
  let ok = 0;
  for (let i = 0; i < tools.length; i += ENRICH_BATCH) {
    const chunk = tools.slice(i, i + ENRICH_BATCH);
    const fetched = await fetchLergassyMulti(chunk.map((t) => t.domain));
    for (const tool of chunk) {
      const raw = fetched.get(tool.domain.toLowerCase());
      if (!raw) continue;
      const metrics = extractTrafficMetrics(raw);
      if (!metrics?.monthlyVisits) continue;
      applyTraffic(tool, raw, metrics);
      tool.collectedAt = new Date().toISOString();
      ok++;
    }
    console.log(`[audit] 流量刷新 ${Math.min(i + ENRICH_BATCH, tools.length)}/${tools.length}｜成功 ${ok}`);
  }
  return ok;
}

async function main(): Promise<void> {
  const dryRun = has("dry");
  const doTraffic = has("traffic");
  const doProbe = has("probe");
  const applyDrops = has("apply-drops");

  const tools = readJson<AITool[]>(TOOLS_PATH, []);
  if (tools.length === 0) {
    console.log("[audit] content/aitools.json 为空，无需重判");
    console.log(JSON.stringify({ total: 0, dropped: 0 }));
    return;
  }

  const before = tally(tools);
  console.log(
    `[audit] 文件 ${tools.length} 条，在榜 ${before.qualified}（core ${before.core} / watch ${before.watch}）` +
      `｜流量刷新 ${doTraffic ? "开" : "关"}｜探活 ${doProbe ? "开" : "关"}${dryRun ? "｜dry-run" : ""}`,
  );

  // 流量必须在重判之前刷新，否则等于没判
  const refreshed = doTraffic ? await refreshTraffic(tools) : 0;
  if (doTraffic) console.log(`[audit] 流量刷新完成 ${refreshed}/${tools.length}`);

  // 只探「规模上可能留在榜上」的站，规模不够的探了也不改变结论
  const aliveTargets = doProbe
    ? tools.filter((t) => {
        const tier = judge(t).tier;
        return tier !== "reject";
      })
    : [];
  const aliveMap = aliveTargets.length
    ? await probeAll(aliveTargets)
    : new Map<string, boolean | null>();
  if (doProbe) {
    console.log(`[audit] 探活 ${aliveTargets.length} 个（规模不达标的已跳过）`);
  }

  const dropped: AuditDropped[] = [];
  const degraded: AuditReport["degraded"] = [];
  let coreAfter = 0;
  let watchAfter = 0;

  for (const tool of tools) {
    const beforeVerdict = judge(tool);
    const verdict = judge(tool, aliveMap.get(tool.domain) ?? null);

    if (verdict.tier === "core") coreAfter++;
    else if (verdict.tier === "watch") watchAfter++;

    // 只有在榜条目才谈得上「下榜」；文件里本来就够不上门槛的，不重复报
    if (beforeVerdict.tier === "reject") continue;

    if (verdict.tier === "reject") {
      dropped.push({
        domain: tool.domain,
        name: tool.name,
        tier: verdict.tier,
        reason: verdict.reason,
        monthlyVisits: visitsOf(tool),
        phUpvotes: tool.phUpvotes ?? undefined,
      });
    } else if (beforeVerdict.tier === "core" && verdict.tier === "watch") {
      degraded.push({ domain: tool.domain, name: tool.name, monthlyVisits: visitsOf(tool) });
    }
  }

  dropped.sort((a, b) => (a.monthlyVisits ?? 0) - (b.monthlyVisits ?? 0));
  const after = { core: coreAfter, watch: watchAfter, qualified: coreAfter + watchAfter };

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    refreshedTraffic: doTraffic,
    probed: doProbe,
    total: tools.length,
    before,
    after,
    dropped,
    degraded,
  };

  console.log(
    `[audit] 重判结果：下榜 ${dropped.length} 条｜降级 ${degraded.length} 条` +
      `｜重判后 qualified ${after.qualified}/${tools.length}`,
  );
  for (const d of dropped.slice(0, 15)) {
    console.log(`  - ${d.domain.padEnd(28)} ${d.reason}`);
  }
  if (dropped.length > 15) console.log(`  … 其余 ${dropped.length - 15} 条见 tools-audit.json`);

  if (dryRun) {
    console.log("[audit] dry-run，未写入任何文件");
    console.log(JSON.stringify({ total: tools.length, dropped: dropped.length, dry: true }));
    return;
  }

  if (applyDrops && dropped.length) {
    const dropSet = new Set(dropped.map((d) => d.domain));
    writeJson(
      TOOLS_PATH,
      tools.filter((t) => !dropSet.has(t.domain)),
    );
    console.log(`[audit] 已从 content/aitools.json 移除 ${dropSet.size} 条下榜条目`);
    console.log(`[audit] ${statsLine(await writeToolStats())}`);
  } else if (dropped.length) {
    console.log("[audit] 未加 --apply-drops，aitools.json 未改动（仅生成下榜清单）");
  }

  writeJson(AUDIT_PATH, report);
  await saveReport("tools-audit", report, "audit-existing");
  console.log(`[audit] 已写入 content/tools-audit.json`);
  console.log(JSON.stringify({ total: tools.length, dropped: dropped.length, report: AUDIT_PATH }));
}

main().catch((e) => {
  console.error("[audit] 失败：", e);
  process.exit(1);
});