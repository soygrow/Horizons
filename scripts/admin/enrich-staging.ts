/**
 * 第二阶段：对「已确认收录」的候选做富化，并产出字段完整度报告。
 *
 * 流程位置：
 *   fetch-staging.ts  → 判定（8 个必需字段）→ 人工确认 stage=approved
 *   → 本脚本富化 → stage=enriched + fieldGaps
 *   → 后台看 tools-field-report.json 决定发哪些 → publish-tools.ts --domains
 *
 * 富化本身复用 scripts/fetch/enrich-site.ts（DataForSEO + LLM + 自建爬虫），
 * 通过 --staging 直接读写待发布队列，不触碰 content/aitools.json。
 *
 * 用法：
 *   pnpm tsx scripts/admin/enrich-staging.ts --limit 10
 *   pnpm tsx scripts/admin/enrich-staging.ts --domains a.com,b.com
 *   pnpm tsx scripts/admin/enrich-staging.ts --free-only --dry
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  computeFieldGaps,
  computeFieldIssues,
  computeEntryIssues,
  hasField,
  visitsOf,
  FIELD_DIMENSIONS,
  type FieldIssue,
  type StagingFile,
  type StagingItem,
} from "./verdict";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STAGING_PATH = path.join(ROOT, "content/tools-staging.json");
const REPORT_PATH = path.join(ROOT, "content/tools-field-report.json");
/** 单站富化的硬超时：DFS + LLM 正常在 2–5 分钟 */
const PER_SITE_TIMEOUT_MS = 12 * 60_000;

export interface FieldGapRow {
  domain: string;
  name: string;
  tier: string;
  stage: string;
  monthlyVisits?: number;
  /** 空置维度数 */
  gapCount: number;
  gaps: string[];
  /** 异常维度数（有值但不合法） */
  issueCount: number;
  issues: FieldIssue[];
}

export interface FieldReport {
  generatedAt: string;
  /** 参与统计的条目数（已确认收录的） */
  total: number;
  /** 至少有一个维度异常的条目数 */
  itemsWithIssues: number;
  /** 按页面展示维度统计：空置（没采到）与异常（采到了但不对）分开 */
  dimensions: Array<{
    key: string;
    label: string;
    /** 空置：字段完全没有值 */
    missing: number;
    missingRatio: number;
    missingDomains: string[];
    /** 异常：有值但不合法，补采也修不好，必须人工核对 */
    invalid: number;
    invalidRatio: number;
    invalidSamples: Array<{ domain: string; reason: string }>;
  }>;
  /** 条目级异常（官网域名对不上、名称为空等），不属于任何页面维度 */
  entryIssues: Array<{ domain: string; label: string; reason: string }>;
  items: FieldGapRow[];
}

function readStaging(): StagingFile {
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

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDomains(): Set<string> | null {
  const raw = arg("domains");
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * 按页面展示维度统计，只有 approved / enriched 参与（candidate 还没富化，无意义）。
 *
 * 两类问题分开算，因为处理方式不同：
 *   空置 missing —— 这次没采到，补采就能修
 *   异常 invalid —— 采到了但不合法，补采也修不好，必须人工核对
 * 同一条目同一维度只会落入其中一类，不重复计数。
 * 一律实时计算，不信任 entry 上可能过期的 fieldGaps。
 */
export function buildFieldReport(items: StagingItem[]): FieldReport {
  const scope = items.filter((i) => i.stage === "approved" || i.stage === "enriched");
  const ratio = (n: number): number => (scope.length ? Math.round((n / scope.length) * 100) : 0);

  const detail = scope.map((item) => {
    const issues = computeFieldIssues(item);
    const issueKeys = new Set(issues.map((x) => x.key));
    const gaps = FIELD_DIMENSIONS.filter((d) => !hasField(item, d.key) && !issueKeys.has(d.key)).map(
      (d) => d.key,
    );
    return { item, gaps, issues, entry: computeEntryIssues(item) };
  });

  const dimensions = FIELD_DIMENSIONS.map((d) => {
    const missingDomains = detail.filter((x) => x.gaps.includes(d.key)).map((x) => x.item.domain);
    const invalidRows = detail
      .map((x) => ({ domain: x.item.domain, reason: x.issues.find((s) => s.key === d.key)?.reason ?? "" }))
      .filter((x) => x.reason);
    return {
      key: d.key,
      label: d.label,
      missing: missingDomains.length,
      missingRatio: ratio(missingDomains.length),
      missingDomains: missingDomains.slice(0, 50),
      invalid: invalidRows.length,
      invalidRatio: ratio(invalidRows.length),
      invalidSamples: invalidRows.slice(0, 20),
    };
  });

  const entryIssues = detail.flatMap((x) =>
    x.entry.map((e) => ({ domain: x.item.domain, label: e.label, reason: e.reason })),
  );

  return {
    generatedAt: new Date().toISOString(),
    total: scope.length,
    itemsWithIssues: detail.filter((x) => x.issues.length > 0 || x.entry.length > 0).length,
    dimensions,
    entryIssues,
    items: detail.map((x) => ({
      domain: x.item.domain,
      name: x.item.name,
      tier: x.item.verdict?.tier ?? "?",
      stage: x.item.stage ?? "candidate",
      monthlyVisits: visitsOf(x.item),
      gapCount: x.gaps.length,
      gaps: x.gaps,
      issueCount: x.issues.length,
      issues: x.issues,
    })),
  };
}

function main(): void {
  const dry = process.argv.includes("--dry");
  const freeOnly = process.argv.includes("--free-only");
  const only = parseDomains();
  const limit = Number(arg("limit") ?? 10);

  const staging = readStaging();
  const targets = staging.items.filter((i) => {
    if (!i?.domain) return false;
    if (only) return only.has(i.domain);
    return i.stage === "approved";
  });

  const picked = Number.isFinite(limit) && limit > 0 ? targets.slice(0, limit) : targets;

  console.log(
    `[enrich-staging] 队列 ${staging.items.length}｜已确认待富化 ${targets.length}｜本次处理 ${picked.length}` +
      `${freeOnly ? "｜仅免费字段" : ""}${dry ? "｜dry-run" : ""}`,
  );

  if (picked.length === 0) {
    console.log(
      "[enrich-staging] 没有已确认（stage=approved）的条目。请先在后台勾选确认收录，或用 --domains 指定。",
    );
    console.log(JSON.stringify({ processed: 0, ok: 0, failed: 0, report: REPORT_PATH }));
    return;
  }

  if (dry) {
    for (const t of picked) console.log(`  · ${t.domain.padEnd(30)} ${t.name}`);
    console.log(JSON.stringify({ processed: picked.length, dry: true }));
    return;
  }

  let ok = 0;
  const failed: string[] = [];

  for (const tool of picked) {
    const args = ["exec", "tsx", "scripts/fetch/enrich-site.ts", "--domain", tool.domain, "--staging"];
    if (freeOnly) args.push("--free-only");
    console.log(`\n[enrich-staging] → ${tool.domain}`);
    const res = spawnSync("pnpm", args, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: PER_SITE_TIMEOUT_MS,
      env: process.env,
    });
    if (res.status === 0) ok++;
    else failed.push(`${tool.domain}(exit ${res.status ?? "timeout"})`);
  }

  // 子进程逐条改过队列文件，这里重新读取再写 stage / fieldGaps
  const latest = readStaging();
  // 精确匹配失败域名（避免 a.com / ab.com 这类前缀撞车）
  const failedSet = new Set(failed.map((f) => f.split("(")[0]));
  const done = new Set(picked.filter((t) => !failedSet.has(t.domain)).map((t) => t.domain));
  const items: StagingItem[] = latest.items.map((i) => {
    if (!done.has(i.domain)) return i;
    return { ...i, stage: "enriched", enrichedAt: new Date().toISOString(), fieldGaps: computeFieldGaps(i) };
  });

  const next: StagingFile = {
    ...latest,
    updatedAt: new Date().toISOString(),
    items,
    lastEnrich: { at: new Date().toISOString(), requested: picked.length, ok, failed: failed.length },
  };
  writeJson(STAGING_PATH, next);

  const report = buildFieldReport(items);
  writeJson(REPORT_PATH, report);

  console.log(`\n[enrich-staging] 完成 ${ok}/${picked.length}${failed.length ? `｜失败 ${failed.length}` : ""}`);
  if (report.total > 0) {
    console.log(`[enrich-staging] 字段体检（共 ${report.total} 条，空置 / 有值但异常）：`);
    for (const d of report.dimensions) {
      const flag = d.invalid > 0 ? " ← 需人工核对" : "";
      console.log(
        `  ${d.label.padEnd(14)} 空 ${String(d.missing).padStart(3)}（${String(d.missingRatio).padStart(3)}%）` +
          ` ｜ 异常 ${String(d.invalid).padStart(3)}（${String(d.invalidRatio).padStart(3)}%）${flag}`,
      );
    }
    if (report.entryIssues.length) {
      console.log(`[enrich-staging] 条目级异常 ${report.entryIssues.length} 处：`);
      for (const e of report.entryIssues.slice(0, 10)) {
        console.log(`  · ${e.domain}：${e.label} — ${e.reason}`);
      }
    }
  }
  console.log(JSON.stringify({ processed: picked.length, ok, failed: failed.length, report: REPORT_PATH }));
}

main();