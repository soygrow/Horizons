/**
 * 把仓库里现有的候选池 / 报告 / 统计回填进 D1。
 *
 * 后台只读 D1，所以「文件里已经有、库里还没有」的数据必须搬一次：
 *   - 首次切库，避免后台一上线就是空页；
 *   - 库里数据被误删时，可以按文件重建。
 *
 * 默认整榜覆盖（先清空再写）：库里可能残留上一版状态，
 * 不覆盖会得到「文件里没有、库里却有」的幽灵条目。
 * 文件为空时宁可跳过也不算覆盖 —— 空文件通常意味着采集没跑，
 * 而不是「这个榜应该被清空」，真要清空用 --force。
 *
 * 用法：
 *   pnpm tsx scripts/admin/backfill-d1.ts               # 全部榜 + 报告
 *   pnpm tsx scripts/admin/backfill-d1.ts --board=github
 *   pnpm tsx scripts/admin/backfill-d1.ts --dry         # 只统计不写入
 *   pnpm tsx scripts/admin/backfill-d1.ts --force       # 允许空文件清空榜单
 */
import fs from "node:fs";
import path from "node:path";
import {
  clearCandidates,
  syncCandidates,
  type BoardItemInput,
  type ItemStatus,
} from "./board-items";
import { writeBoardStatsToD1 } from "./board-stats";
import { d1Configured } from "./d1-client";
import { saveDigestIssue, type DigestIssueLike } from "./digest-issues";
import { saveReport } from "./reports";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTENT = path.join(ROOT, "content");

type Board = "tools" | "trends" | "github";
const BOARDS: Board[] = ["tools", "trends", "github"];

function readJson<T>(file: string): T | null {
  const p = path.join(CONTENT, file);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch (e) {
    console.warn(`[backfill] ${file} 解析失败，跳过：`, e instanceof Error ? e.message : e);
    return null;
  }
}

interface StagingLike {
  updatedAt?: string;
  runAt?: string;
  items?: Array<Record<string, unknown>>;
  candidates?: Array<Record<string, unknown>>;
  updates?: unknown[];
  rejected?: string[];
  board?: unknown;
  lastRun?: unknown;
  lastPublish?: unknown;
  ruleVersion?: string;
  scoreModel?: string;
  target?: number;
}

/** 各榜的发布期快照在 board_reports 里的 key，与采集脚本保持一致 */
const META_KEY = { trends: "trends-meta", github: "github-meta" } as const;

/**
 * 位次快照 / 上次采集 / 上次发布摘要也搬进库。
 * 这些是采集时用完整数据算出来的结果，后台无法从库里还原，
 * 不搬的话后台的「会挤掉谁」预览就是空的。
 */
function metaPayload(board: Board, staging: StagingLike): Record<string, unknown> | null {
  if (board === "tools") return null;

  if (board === "trends") {
    return {
      updatedAt: staging.updatedAt,
      runAt: staging.runAt,
      board: staging.board ?? null,
      lastRun: staging.lastRun ?? null,
      lastPublish: staging.lastPublish ?? null,
    };
  }

  return {
    updatedAt: staging.updatedAt,
    ruleVersion: staging.ruleVersion,
    scoreModel: staging.scoreModel,
    target: staging.target,
    board: staging.board ?? null,
    // updates 队列约 476KB，不搬内容，只留条数
    updatesCount: staging.updates?.length ?? 0,
    lastRun: staging.lastRun ?? null,
    lastPublish: staging.lastPublish ?? null,
  };
}

/** 候选口径按榜各自的业务主键映射，与采集脚本保持一致 */
function mapItems(board: Board, staging: StagingLike): BoardItemInput[] {
  const rejected = (staging.rejected ?? []).map((key) => ({
    itemKey: String(key).toLowerCase(),
    name: String(key),
    status: "rejected" as const,
  }));

  if (board === "tools") {
    return [
      ...(staging.items ?? []).map((it) => ({
        itemKey: String(it.domain ?? "").toLowerCase(),
        name: String(it.name ?? it.domain ?? ""),
        url: typeof it.url === "string" ? it.url : null,
        status: (it.stage ?? "candidate") as ItemStatus,
        judge: it.verdict,
        card: it,
      })),
      ...rejected,
    ];
  }

  if (board === "trends") {
    return [
      ...(staging.items ?? []).map((it) => ({
        itemKey: String(it.keyword ?? "").toLowerCase(),
        name: String(it.keyword ?? ""),
        status: "candidate" as const,
        card: it,
      })),
      ...rejected,
    ];
  }

  // github：候选是 { repo, score, grade, ... }，主键用 owner/repo 小写
  return [
    ...(staging.candidates ?? []).map((c) => {
      const repo = (c.repo ?? {}) as Record<string, unknown>;
      const fullName = String(repo.fullName ?? "");
      return {
        itemKey: fullName.toLowerCase(),
        name: fullName,
        url: typeof repo.htmlUrl === "string" ? repo.htmlUrl : null,
        status: "candidate" as const,
        judge: {
          score: c.score,
          grade: c.grade,
          estimatedRank: c.estimatedRank,
          check: c.check,
        },
        card: c,
      };
    }),
    ...rejected,
  ];
}

const STAGING_FILE: Record<Board, string> = {
  tools: "tools-staging.json",
  trends: "trends-staging.json",
  github: "github-staging.json",
};

interface ReportSpec {
  key: string;
  file: string;
}

const REPORTS: ReportSpec[] = [
  { key: "tools-stats", file: "tools-stats.json" },
  { key: "tools-audit", file: "tools-audit.json" },
  { key: "tools-field", file: "tools-field-report.json" },
];

async function backfillBoard(
  board: Board,
  opts: { dry: boolean; force: boolean },
): Promise<void> {
  const staging = readJson<StagingLike>(STAGING_FILE[board]);
  if (!staging) {
    console.log(`[backfill] ${board}: 没有 ${STAGING_FILE[board]}，跳过`);
    return;
  }

  // 快照与候选数量无关：候选为 0 的榜也要把位次快照搬过去
  const meta = metaPayload(board, staging);
  if (meta && board !== "tools") {
    const key = META_KEY[board];
    if (opts.dry) {
      console.log(`[backfill] ${board}: board_reports:${key} 待写入`);
    } else {
      await saveReport(key, meta, "backfill");
      console.log(`[backfill] ${board}: 已写入 board_reports:${key}`);
    }
  }

  const rows = mapItems(board, staging).filter((r) => r.itemKey);
  const active = rows.filter((r) => r.status !== "rejected").length;
  const rejected = rows.length - active;

  if (active === 0 && !opts.force) {
    console.log(
      `[backfill] ${board}: 文件里没有待审候选（拒绝 ${rejected} 条），跳过以避免清空库里数据（需清空请加 --force）`,
    );
    return;
  }

  console.log(`[backfill] ${board}: 候选 ${active} 条、拒绝 ${rejected} 条`);
  if (opts.dry) return;

  await clearCandidates(board);
  const n = await syncCandidates(board, rows);
  console.log(`[backfill] ${board}: 已写入 ${n} 行`);
}

/** 往期日报：一期一个文件，直接整份搬进 digest_issues */
async function backfillDigest(opts: { dry: boolean }): Promise<void> {
  const dir = path.join(CONTENT, "digest");
  if (!fs.existsSync(dir)) {
    console.log("[backfill] digest: 没有 content/digest，跳过");
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (files.length === 0) {
    console.log("[backfill] digest: 没有已发布的期号，跳过");
    return;
  }

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as DigestIssueLike;
    if (opts.dry) {
      console.log(`[backfill] digest ${file}: 待写入`);
      continue;
    }
    const ok = await saveDigestIssue(data);
    console.log(`[backfill] digest ${data.date}: ${ok ? "已写入" : "失败"}`);
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const only = process.argv.find((a) => a.startsWith("--board="))?.slice("--board=".length);

  if (!d1Configured()) {
    console.error(
      "[backfill] 没有可用的 D1 通道（需 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，或本机 wrangler login）",
    );
    process.exitCode = 1;
    return;
  }
  if (dry) console.log("[backfill] --dry：只统计，不写入");

  const boards = only ? BOARDS.filter((b) => b === only) : BOARDS;
  if (only && boards.length === 0) {
    console.error(`[backfill] 未知榜 ${only}，可选 ${BOARDS.join(" / ")}`);
    process.exitCode = 1;
    return;
  }

  for (const board of boards) {
    await backfillBoard(board, { dry, force });
  }

  if (!only) {
    for (const spec of REPORTS) {
      const data = readJson<Record<string, unknown>>(spec.file);
      if (!data) {
        console.log(`[backfill] ${spec.key}: 没有 ${spec.file}，跳过`);
        continue;
      }
      if (dry) {
        console.log(`[backfill] ${spec.key}: 待写入`);
        continue;
      }
      await saveReport(spec.key, data, "backfill");
      console.log(`[backfill] ${spec.key}: 已写入 board_reports`);
    }

    if (!dry) {
      const n = await writeBoardStatsToD1();
      console.log(`[backfill] board_stats: 已刷新 ${n} 个榜`);
    }

    await backfillDigest({ dry });
  }

  console.log("[backfill] 完成");
}

main().catch((e) => {
  console.error("[backfill] 失败：", e);
  process.exitCode = 1;
});