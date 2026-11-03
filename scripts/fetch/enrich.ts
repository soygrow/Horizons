import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { detectTechStack } from "./sources/techstack";
import { extractContact } from "./sources/contact";
import { detectPricing } from "./sources/pricing";
import { isBlockedDomain } from "@horizons/shared";
import type { AITool } from "@horizons/shared";

/* 榜单判定，与 apps/web/src/lib/data.ts 的 tierOf 保持同步 */
const MIN_VISITS_CORE = 10_000;
const MIN_VISITS_WATCH = 1_000;
const WATCH_PH_UPVOTES = 300;

function tierOf(t: AITool): "core" | "watch" | null {
  if (isBlockedDomain(t.domain)) return null;
  const v = t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits;
  if (v === undefined) return (t.phUpvotes ?? 0) >= WATCH_PH_UPVOTES ? "watch" : null;
  if (v >= MIN_VISITS_CORE) return "core";
  if (v >= MIN_VISITS_WATCH) {
    const g = t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth;
    return typeof g === "number" && g < 0 ? "watch" : "core";
  }
  return null;
}

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): number {
  const [min, max] = config.requestDelayMs;
  return Math.floor(min + Math.random() * (max - min + 1));
}

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

async function fetchHome(
  url: string,
): Promise<{ html: string; headers: Record<string, string> } | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent": config.userAgent,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const headers = Object.fromEntries(res.headers.entries());
    return { html, headers };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const dryRun = process.argv.includes("--dry");
  console.log(
    `[enrich] 开始增强工具详情字段${limit > 0 ? `，本次最多 ${limit} 个` : ""}${dryRun ? "（dry-run）" : ""}`,
  );

  const tools = loadTools();
  const listedOnly = process.argv.includes("--listed-only");
  // 只跑真正缺字段的站：已有 techStack/contact/pricing 的站重抓一遍纯属浪费请求
  const needsWork = (t: AITool): boolean =>
    !t.techStack?.length || !t.contact || !t.pricing?.length;
  const targets = tools.filter((t) => (!listedOnly || tierOf(t) !== null) && needsWork(t));
  if (listedOnly) console.log(`[enrich] 仅榜内：${targets.length}/${tools.length} 个待补`);
  let processed = 0;
  let changed = 0;

  for (const tool of targets) {
    if (limit > 0 && processed >= limit) break;
    if (!tool.url || !/^https?:/i.test(tool.url)) continue;
    processed++;

    await sleep(randomDelay());
    const home = await fetchHome(tool.url);
    if (!home) {
      console.log(`[enrich] ${tool.domain}：首页抓取失败，跳过`);
      continue;
    }

    let dirty = false;

    if (!tool.techStack || tool.techStack.length === 0) {
      const ts = detectTechStack(home.html, home.headers);
      if (ts.length > 0) {
        tool.techStack = ts;
        dirty = true;
      }
    }
    if (!tool.contact) {
      const c = extractContact(home.html, tool.url);
      if (c) {
        tool.contact = c;
        dirty = true;
      }
    }
    if (!tool.pricing || tool.pricing.length === 0) {
      const p = await detectPricing(tool.url, home.html);
      if (p) {
        tool.pricing = p;
        dirty = true;
      }
    }

    if (dirty) {
      tool.collectedAt = new Date().toISOString();
      changed++;
      console.log(
        `[enrich] ${tool.domain}：tech=${tool.techStack?.length ?? 0} contact=${tool.contact ? "Y" : "N"} pricing=${tool.pricing?.length ?? 0}`,
      );
    } else {
      console.log(`[enrich] ${tool.domain}：无新增字段`);
    }
  }

  if (!dryRun && changed > 0) {
    saveTools(tools);
  }
  console.log(`[enrich] 完成：处理 ${processed} 个，更新 ${changed} 个${dryRun ? "（未写入）" : ""}`);
}

main().catch((e) => {
  console.error("[enrich] 失败：", e);
  process.exit(1);
});
