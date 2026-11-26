/**
 * 第二阶段：对「已确认收录」的候选做富化，并产出字段完整度报告。
 *
 * 流程位置：
 *   fetch-staging.ts  → 判定（8 个必需字段）→ 人工确认 stage=approved
 *   → 本脚本富化 → stage=enriched + fieldGaps
 *   → 后台看 tools-field-report.json 决定发哪些 → publish-tools.ts --domains
 *
 * 富化本身复用 scripts/fetch/enrich-site.ts（field-collect + LLM + 自建爬虫），
 * 通过 --staging 直接读写待发布队列，不触碰 content/aitools.json。
 *
 * 用法：
 *   pnpm tsx scripts/admin/enrich-staging.ts --limit 10
 *   pnpm tsx scripts/admin/enrich-staging.ts --domains a.com,b.com
 *   pnpm tsx scripts/admin/enrich-staging.ts --free-only --dry
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  computeFieldGaps,
  computeFieldIssues,
  computeEntryIssues,
  hasField,
  visitsOf,
  FIELD_DIMENSIONS,
  type FieldIssue,
  type StagingItem,
} from "./verdict";
import { expireStaleEnriching, readWorkspace, syncCandidates, type ItemStatus } from "./board-items";
import { hasApify } from "../fetch/sources/apify";
import { saveReport } from "./reports";

const ROOT = path.resolve(import.meta.dirname, "../..");
const REPORT_PATH = path.join(ROOT, "content/tools-field-report.json");
/** 单站富化的硬超时：采集 + LLM 正常在 2–5 分钟 */
const PER_SITE_TIMEOUT_MS = 12 * 60_000;

/**
 * 本轮已占住「富化中」、还没落定终态的域名。
 *
 * 收尾正常时它们会被写成 enriched / enrich_failed / approved；一旦中途抛异常，
 * 收尾压根不执行，这批条目就会永久挂着「富化中」。文件末尾的 catch 靠这份名单兜底。
 */
const inFlight: string[] = [];

/** 收尾与异常兜底共用：stage 决定落库状态，卡片内容原样 */
function toRows(items: StagingItem[]) {
  return items.map((i) => ({
    itemKey: i.domain.toLowerCase(),
    name: i.name,
    url: i.url ?? `https://${i.domain}`,
    status: (i.stage ?? "candidate") as ItemStatus,
    // 不传就会被打回 new：线上更新条目必须保住 refresh 来源
    kind: i.kind === "refresh" ? ("refresh" as const) : ("new" as const),
    judge: i.verdict,
    card: i,
  }));
}

/**
 * 同一时刻并发跑几个站。
 *
 * 单站实测 3~4 分钟（后台一次提交 30 条，跑满 60 分钟只到第 17 条就被 Actions 掐掉），
 * 而这 3~4 分钟几乎全在等外部接口：Playwright 开页截图、两次 vortex run-sync、
 * SERP、三段 DeepSeek。本地 CPU 基本闲着，串行跑纯属把等待时间叠加。
 *
 * 默认 3 是保守值：Apify 账号要同时容纳 3 个 actor run，机器要同时跑 3 个 Chromium。
 * 想再快可用 ENRICH_CONCURRENCY 调高（4~5），但要盯日志里的内存与 429。
 */
const DEFAULT_CONCURRENCY = 3;

/**
 * 本进程的时间预算（分钟），可用 ENRICH_BUDGET_MINUTES 覆盖。
 *
 * Actions 的 job 超时是 60 分钟，超时会被直接 kill —— 末尾「统一打 stage + 写库」
 * 那一步就没了，条目全卡在 enriching，只能等下一次跑才被放出来。
 * 所以留 10 分钟余量给收尾（D1 写入 + git commit + 触发构建）：到点不再开新站，
 * 没跑到的条目退回 approved，下次点一次就能接着跑。
 */
const DEFAULT_BUDGET_MINUTES = 45;

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

interface SiteRunResult {
  /** 子进程退出码；null 表示被信号杀掉或起不来 */
  code: number | null;
  /** 是否踩到了单站硬超时 */
  expired: boolean;
}

/**
 * 跑一个站（子进程），把它的输出按行透传。
 *
 * 并发跑时各站日志会交错，所以每行前加 `[域名]` 前缀 —— 不然出问题根本分不清
 * 哪一行是哪个站的。串行时（concurrency=1）不加前缀，保持原来的日志形态。
 *
 * 用 detached + 杀进程组：`pnpm exec tsx` 会再拉起 node，只 kill pnpm 会留下
 * 孤儿进程继续占着 Chromium 和 Apify 配额。
 */
function runSite(domain: string, args: string[], prefix: boolean): Promise<SiteRunResult> {
  return new Promise((resolve) => {
    const child = spawn("pnpm", args, {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const tag = prefix ? `[${domain}] ` : "";
    const relay = (stream: NodeJS.ReadableStream | null, out: NodeJS.WritableStream) => {
      if (!stream) return;
      let rest = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        rest += chunk;
        let nl = rest.indexOf("\n");
        while (nl >= 0) {
          // 去掉 \r：子进程在容器里可能吐 CRLF，留着会在 Actions 日志里多出空行
          out.write(`${tag}${rest.slice(0, nl).replace(/\r$/, "")}\n`);
          rest = rest.slice(nl + 1);
          nl = rest.indexOf("\n");
        }
      });
      stream.on("end", () => {
        if (rest) out.write(`${tag}${rest.replace(/\r$/, "")}\n`);
      });
    };
    relay(child.stdout, process.stdout);
    relay(child.stderr, process.stderr);

    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, PER_SITE_TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      console.error(`${tag}[enrich-staging] 子进程启动失败：${e.message}`);
      resolve({ code: null, expired });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, expired });
    });
  });
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

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dry = process.argv.includes("--dry");
  const freeOnly = process.argv.includes("--free-only");
  /** 线上更新：强制重采，绕过 field-collect 的一个月缓存，否则跑完数据不变 */
  const force = process.argv.includes("--force");
  /** 只采集 / 只跑文案（两个开关关掉另一侧时由后台传下来） */
  const noLlm = process.argv.includes("--no-llm");
  const insightOnly = process.argv.includes("--insight-only");
  const only = parseDomains();
  /** 按来源过滤：两个后台 tab 的数据互不交叉 */
  const rawKind = arg("kind");
  const kind = rawKind === "new" || rawKind === "refresh" ? rawKind : null;
  // 更新一条要重采整站，跑得比新条目慢；批量与 API 的 MAX_REFRESH_DOMAINS 对齐（15），
  // 给 60 分钟的 job 窗口留余量（突发一个站卡到单站超时不会把整批拖崩）
  const limit = Number(arg("limit") ?? (kind === "refresh" ? 15 : 10));

  // 并发与时间预算：命令行优先，其次环境变量（workflow 里注入），最后取默认值
  const concurrency = (() => {
    const n = Number(arg("concurrency") ?? process.env.ENRICH_CONCURRENCY ?? DEFAULT_CONCURRENCY);
    return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 8) : DEFAULT_CONCURRENCY;
  })();
  const budgetMinutes = (() => {
    const n = Number(arg("budget-minutes") ?? process.env.ENRICH_BUDGET_MINUTES ?? DEFAULT_BUDGET_MINUTES);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BUDGET_MINUTES;
  })();
  const deadline = Date.now() + budgetMinutes * 60_000;

  // 上一轮跑飞的条目先放出来：否则它们一直占着 enriching，
  // 既不能重选，也不会进发布队列，只能人工改库
  await expireStaleEnriching("tools", (m) => console.log(m));

  const staging = await readWorkspace<StagingItem>("tools");
  /**
   * 开始时就已经占着「富化中」的条目（后台派发时标的，或上一批崩溃留下的）。
   *
   * 本轮结束时它们必须有归宿：名单外 / 没轮到的条目绝不能原样写回 enriching ——
   * 那样它既不能被重新选中（复选框禁用），也不会自己消失，只能等 60 分钟超时；
   * 而超时兜底靠 updated_at，任何一次写库都会把计时往后推，实际就是永久卡死
   * （11-26 tiden.ai 卡了两小时、运行记录说「失败 5 条」队列只有 4 条，就是这个）。
   */
  const startedEnriching = new Set(
    staging.items.filter((i) => i.stage === "enriching").map((i) => i.domain),
  );
  const targets = staging.items.filter((i) => {
    if (!i?.domain) return false;
    if (kind && (i.kind ?? "new") !== kind) return false;
    if (only) return only.has(i.domain);
    // enriching 必须认：后台派发时已经把状态从 approved 改成了 enriching，
    // 这里只挑 approved 的话，按钮点下去脚本一条都挑不到。
    // enrich_failed 不在其中：失败要人工重新勾选再跑，不能自动重花一遍钱。
    return i.stage === "approved" || i.stage === "enriching";
  });

  const picked = Number.isFinite(limit) && limit > 0 ? targets.slice(0, limit) : targets;

  console.log(
    `[enrich-staging]${kind ? ` 来源 ${kind}` : ""} 队列 ${staging.items.length}｜待富化 ${targets.length}｜本次处理 ${picked.length}` +
      `${force ? "｜强制重采" : ""}${freeOnly ? "｜仅免费字段" : ""}` +
      `${noLlm ? "｜跳过文案" : ""}${insightOnly ? "｜仅重跑文案" : ""}${dry ? "｜dry-run" : ""}` +
      `｜并发 ${concurrency}｜预算 ${budgetMinutes} 分钟`,
  );

  if (picked.length === 0) {
    console.log(
      "[enrich-staging] 没有待富化的条目（stage=approved / enriching）。" +
        "请先在后台勾选确认收录，或用 --domains 指定。",
    );
    console.log(JSON.stringify({ processed: 0, ok: 0, failed: 0, report: REPORT_PATH }));
    return;
  }

  if (dry) {
    for (const t of picked) console.log(`  · ${t.domain.padEnd(30)} ${t.name}`);
    console.log(JSON.stringify({ processed: picked.length, dry: true }));
    return;
  }

  // 从这里起开始动库：中途抛异常时 catch 要把这批「富化中」落定，见文件末尾
  inFlight.push(...picked.map((t) => t.domain));

  let ok = 0;
  const failed: string[] = [];
  /** 时间预算用尽、压根没开跑的条目：退回 approved，下次点一下就能接着跑 */
  const skipped: string[] = [];

  /*
   * 并发跑：按 picked 顺序发牌，每个 worker 跑完一条自己取下一条。
   *
   * 到点（deadline）就不再开新站，只把剩下的记进 skipped —— 正在跑的站不打断，
   * 免得半套结果写进库。这样最坏情况是「跑了 25 条，剩 5 条退回待富化」，
   * 而不是被 Actions 硬杀、条目全卡在 enriching。
   */
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, picked.length) }, async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= picked.length) return;
      const tool = picked[idx];

      if (Date.now() >= deadline) {
        skipped.push(tool.domain);
        continue;
      }

      const args = ["exec", "tsx", "scripts/fetch/enrich-site.ts", "--domain", tool.domain, "--staging"];
      if (freeOnly) args.push("--free-only");
      if (force) args.push("--force");
      if (noLlm) args.push("--no-llm");
      if (insightOnly) args.push("--insight-only");
      console.log(`\n[enrich-staging] → ${tool.domain}`);
      const res = await runSite(tool.domain, args, concurrency > 1);
      if (res.code === 0) {
        ok++;
        console.log(`[enrich-staging] ✓ ${tool.domain}（已完成 ${ok}/${picked.length}）`);
      } else {
        failed.push(`${tool.domain}(${res.expired ? "timeout" : `exit ${res.code ?? "signal"}`})`);
      }
    }
  });
  await Promise.all(workers);

  if (skipped.length) {
    console.warn(
      `::warning::[enrich-staging] 时间预算 ${budgetMinutes} 分钟已用尽，${skipped.length} 条未开跑，已退回「已确认收录」：` +
        `${skipped.slice(0, 5).join("、")}${skipped.length > 5 ? " 等" : ""}。下次再点一次即可接着跑。`,
    );
  }

  // 子进程已把富化结果写回 D1，这里重新读一遍再统一打 stage / fieldGaps
  const latest = await readWorkspace<StagingItem>("tools");
  // 精确匹配失败域名（避免 a.com / ab.com 这类前缀撞车）
  const failedSet = new Set(failed.map((f) => f.split("(")[0]));
  const skippedSet = new Set(skipped);
  const done = new Set(
    picked.filter((t) => !failedSet.has(t.domain) && !skippedSet.has(t.domain)).map((t) => t.domain),
  );
  const items: StagingItem[] = latest.items.map((i) => {
    // 成功 → enriched；失败 → enrich_failed（以前失败什么都不写，条目退回 approved，
    // 后台既看不出失败也分不清是不是没跑过）
    if (done.has(i.domain)) {
      return { ...i, stage: "enriched", enrichedAt: new Date().toISOString(), fieldGaps: computeFieldGaps(i) };
    }
    if (failedSet.has(i.domain)) return { ...i, stage: "enrich_failed" };
    // 没开跑的不算失败：留着 enriching 会被判超时，退回 approved 才能被再次选中
    if (skippedSet.has(i.domain)) return { ...i, stage: "approved" };
    // 开始时就在「富化中」、本轮却没轮到它（--domains 没点到 / --limit 截断 / 来源不匹配）：
    // 退回待富化让它能被重新选中，绝不原样写回一条永不释放的假「富化中」
    if (startedEnriching.has(i.domain)) return { ...i, stage: "approved" };
    return i;
  });

  const report = buildFieldReport(items);
  writeJson(REPORT_PATH, report);
  /* 后台只读 D1：富化后的状态与体检报告都要落库 */
  await syncCandidates("tools", toRows(items));
  await saveReport("tools-field", report, "enrich-staging");

  console.log(
    `\n[enrich-staging] 完成 ${ok}/${picked.length}` +
      `${failed.length ? `｜失败 ${failed.length}` : ""}` +
      `${skipped.length ? `｜预算用尽未跑 ${skipped.length}（已退回待富化）` : ""}` +
      `（耗时 ${Math.round((Date.now() - startedAt) / 60_000)} 分钟）`,
  );
  if (report.total > 0) {
    // 没配 APIFY_TOKEN 时流量 / 关键词 / 渠道 / 国家分布全是空的，这属于配置缺失而非富化失败，
    // 不说明的话看报告的人只会以为富化又白跑了
    if (!hasApify()) {
      console.log(
        "[enrich-staging] 未配置 APIFY_TOKEN：流量 / 关键词 / 渠道结构 / 国家分布 这几项不会更新（属预期，配好凭据再跑一次就能填）",
      );
    }
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
  console.log(
    JSON.stringify({
      processed: picked.length,
      ok,
      failed: failed.length,
      skipped: skipped.length,
      report: REPORT_PATH,
    }),
  );

  // 全失败必须让任务失败：以前无论成败都 exit 0，后台任务列表显示「成功」，
  // 但队列一条都没富化、阶段停在「待富化」，人只能对着日志猜。
  // 只有「没跑到的」（预算用尽）不算失败，那是正常的提前收工。
  if (ok === 0 && failed.length > 0) {
    console.error(`[enrich-staging] ${picked.length} 条全部失败，按失败退出（后台会显示失败）`);
    process.exitCode = 1;
  } else if (failed.length) {
    console.warn(
      `::warning::[enrich-staging] ${failed.length}/${picked.length} 条失败：${failed.slice(0, 5).join("、")}`,
    );
  }
}

main().catch(async (e: unknown) => {
  console.error("[enrich-staging] 失败：", e);
  /*
   * 收尾没机会执行（异常直接从中间冒出来）：这批还挂在「富化中」的条目必须落定。
   * 不落定的话后台永远显示「富化中」—— 复选框禁用、也选不中富化，运行记录写着
   * 「失败 N 条」而队列里只有 N-1 条失败，数字永远对不上。
   * 判「富化失败」而不是退回待富化：这轮确实跑了又没跑成，运营该看到它并决定重试。
   */
  if (inFlight.length) {
    try {
      const latest = await readWorkspace<StagingItem>("tools");
      const mine = new Set(inFlight);
      const stuck = latest.items.filter((i) => mine.has(i.domain) && i.stage === "enriching");
      if (stuck.length) {
        const items = latest.items.map((i) =>
          mine.has(i.domain) && i.stage === "enriching" ? { ...i, stage: "enrich_failed" } : i,
        );
        await syncCandidates("tools", toRows(items));
        console.error(
          `[enrich-staging] 已把 ${stuck.length} 条未完成的条目落成「富化失败」，可在后台重试`,
        );
      }
    } catch (e2) {
      console.error("[enrich-staging] 兜底落库也失败了，条目会停在「富化中」：", e2);
    }
  }
  process.exitCode = 1;
});