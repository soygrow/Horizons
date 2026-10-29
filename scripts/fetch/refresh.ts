/**
 * 单站 / 批量一站式更新：vortex → DFS + 审计 + LLM → 截图。
 *
 * 用法：
 *   pnpm refresh --domain picvo.ai            # 单个站，跑全部阶段
 *   pnpm refresh --missing --limit 20         # 批量：无流量数据的站，先跑 20 个
 *   pnpm refresh --missing=all                # 批量：缺流量或缺分析的站
 *   pnpm refresh --domain a.com,b.com --stages=site,shot
 *
 * 说明：
 *   - 阶段按 apify → site → shot 顺序串行，任一阶段失败不阻塞后续阶段，只记录。
 *   - --missing 每跑一个就写盘，中断后重跑会自动跳过已完成的站。
 *   - 没有 trafficMetrics 的站 vortex 可能返回空（站点过小），
 *     这类站 apify 阶段会失败，但 site/shot 仍会继续（DFS 搜索流量兜底）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AITool } from "@horizons/shared";

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");
const TSX = path.resolve(process.cwd(), "node_modules/.bin/tsx");

type Stage = "apify" | "site" | "shot";

const ALL_STAGES: Stage[] = ["apify", "site", "shot"];

const STAGE_SCRIPT: Record<Stage, string> = {
  apify: "scripts/fetch/fetch-apify.ts",
  site: "scripts/fetch/enrich-site.ts",
  shot: "scripts/fetch/screenshot.ts",
};

function loadTools(): AITool[] {
  return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
}

function argValue(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1) || undefined;
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

/** --missing / --missing=traffic 都算开启，返回筛选口径 */
function parseMissing(): "traffic" | "analysis" | "all" | null {
  const raw = process.argv.find((a) => a === "--missing" || a.startsWith("--missing="));
  if (!raw) return null;
  const v = raw.split("=")[1];
  return v === "analysis" || v === "all" ? v : "traffic";
}

function parseStages(): Stage[] {
  const raw = argValue("--stages");
  if (!raw) return ALL_STAGES;
  const picked = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Stage => (ALL_STAGES as string[]).includes(s));
  return picked.length ? picked : ALL_STAGES;
}

/**
 * 近期已同步过的站不再重复跑，避免「本来就没搜索流量」的站被反复抓取。
 * 用 dataSnapshot.syncedAt（数据同步时间）而不是 collectedAt（条目抓取时间），
 * 后者会被描述/标签类脚本刷新，无法代表流量数据是否跑过。
 */
const RECENT_DAYS = Number(process.env.REFRESH_RECENT_DAYS ?? 7);

function syncedRecently(tool: AITool): boolean {
  if (process.argv.includes("--force")) return false;
  const raw = tool.dataSnapshot?.syncedAt;
  if (!raw) return false;
  const t = Date.parse(raw);
  return Number.isFinite(t) && Date.now() - t < RECENT_DAYS * 86400_000;
}

function isMissing(tool: AITool, mode: "traffic" | "analysis" | "all"): boolean {
  const noTraffic = !tool.trafficMetrics?.monthlyVisits;
  const noAnalysis = !tool.aiInsight;
  if (mode === "traffic") return noTraffic && !syncedRecently(tool);
  if (mode === "analysis") return noAnalysis && !syncedRecently(tool);
  return (noTraffic || noAnalysis) && !syncedRecently(tool);
}

function runScript(script: string, domain: string): Promise<{ code: number; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(TSX, [script, "--domain", domain], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
    });
    child.on("error", (e) => {
      console.error(`[refresh] 启动失败：${e.message}`);
      resolve({ code: 1, ms: Date.now() - t0 });
    });
    child.on("close", (code) => resolve({ code: code ?? 1, ms: Date.now() - t0 }));
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(TSX)) {
    console.error(`[refresh] 未找到 tsx：${TSX}`);
    process.exit(1);
  }

  const stages = parseStages();
  const limitRaw = Number(argValue("--limit") ?? 0);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 0;

  let targets: string[];
  const domainArg = argValue("--domain");
  const missing = parseMissing();

  if (domainArg) {
    targets = domainArg.toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
  } else if (missing) {
    targets = loadTools().filter((t) => isMissing(t, missing)).map((t) => t.domain);
  } else {
    console.error("[refresh] 需要 --domain 或 --missing");
    process.exit(1);
  }

  if (limit > 0) targets = targets.slice(0, limit);
  if (targets.length === 0) {
    console.log("[refresh] 没有需要更新的站点");
    return;
  }

  console.log(
    `[refresh] 站点 ${targets.length} 个｜阶段 ${stages.join(" → ")}${missing ? `｜筛选 ${missing}` : ""}`,
  );

  const failed: { domain: string; stage: Stage; code: number }[] = [];
  const noTraffic: string[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < targets.length; i++) {
    const domain = targets[i];
    console.log(`\n=========== [${i + 1}/${targets.length}] ${domain} ===========`);
    for (const stage of stages) {
      const { code, ms } = await runScript(STAGE_SCRIPT[stage], domain);
      console.log(`[refresh] ${domain} ${stage} ${code === 0 ? "✅" : "❌"} ${(ms / 1000).toFixed(1)}s`);
      if (code !== 0) {
        // apify 拿不到流量很常见（站点过小），不阻塞 DFS / 截图，单独归类
        if (stage === "apify") {
          noTraffic.push(domain);
          continue;
        }
        failed.push({ domain, stage, code });
        break;
      }
    }
  }

  const totalMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n[refresh] 完成：${targets.length} 个站点，用时 ${totalMin} 分钟`);
  if (noTraffic.length) {
    console.log(`[refresh] vortex 无流量 ${noTraffic.length} 个（已用 DFS 搜索流量兜底）：${noTraffic.join(", ")}`);
  }
  if (failed.length) {
    console.log(`[refresh] 失败 ${failed.length} 项：`);
    for (const f of failed) console.log(`  - ${f.domain} [${f.stage}] exit=${f.code}`);
    console.log("[refresh] 重跑失败项：pnpm refresh --domain " + failed.map((f) => f.domain).join(","));
  }
}

main().catch((e) => {
  console.error("[refresh] 失败：", e);
  process.exit(1);
});