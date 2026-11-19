/**
 * 后台「发布 GitHub 榜」入口（由 .github/workflows/publish-github.yml 调用）。
 *
 * 必须由人点「发布」触发。
 *
 * 流程：
 *   读现榜（D1 当前版本快照）+ 读候选池 → 应用数值更新 → 合并新候选（补 README）
 *   → 按综合分排序取前 TARGET 名 → 与旧榜对比 → 写回 D1 → 打印位次变化
 *
 * 只写库：`content/github.json` 不再入库（.gitignore），它是构建缓存，
 * 由 `hydrate-github.ts` 从库里还原。本脚本跑完由 workflow 触发站点重建。
 *
 * 注意：
 *   - 现榜条目只更新星标/issue/推送时间并重算分数，README 与中文情报原样保留；
 *   - 新候选的 README 在这里补（候选池里为了控制文件体积没有存全文）；
 *   - 容量是硬约束：多出来的直接截断，被挤掉的在报告里算「出榜」。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-github.ts            # 正式发布
 *   pnpm tsx scripts/admin/publish-github.ts --dry      # 只打印报告，不写库
 *   GITHUB_TOKEN=ghp_xxx pnpm tsx scripts/admin/publish-github.ts
 */
import fs from "node:fs";
import path from "node:path";
import { computeProductScore, diffRepoRanks, toRepoRankRow } from "@horizons/shared";
import type { GitHubRepo, RepoRankRow, RepoStagingFile, StagingCandidate } from "@horizons/shared";
import { config } from "../fetch/config"; // 顺带加载 .env.local
import { RANKING_RULE_VERSION } from "../fetch/github-ranking-rules";
import { clearCandidates, listCandidates, syncCandidates } from "./board-items";
import { syncBoardToD1 } from "./board-sync";
import { d1Configured } from "./d1-client";
import { readListedGithub } from "./hydrate-github";
import type { PublishRow } from "./publish-board";
import { saveReport } from "./reports";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_PATH = path.join(ROOT, "content/github.json");
const STAGING_PATH = path.join(ROOT, "content/github-staging.json");

const TOKEN = process.env.GITHUB_TOKEN;
const DRY = process.argv.includes("--dry");
// --no-d1 / --strict-d1 由 board-sync 统一解析，这里不再重复判断
/** 报告里最多列多少条明细：后台表格是分页的，但 Actions 日志刷几百行没人看 */
const REPORT_LIMIT = 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": config.userAgent,
    Accept: "application/vnd.github+json",
    ...extra,
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function fetchReadme(full: string): Promise<string> {
  const [owner, repo] = full.split("/");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: headers({ Accept: "application/vnd.github.raw+json" }),
      });
      if (res.ok) return await res.text();
      if (res.status === 403 || res.status === 429) {
        await sleep(15_000 * attempt);
        continue;
      }
      return "";
    } catch {
      await sleep(2000 * attempt);
    }
  }
  return "";
}

/** 与 score.ts 的 compareByScore 完全一致 */
function compareRepos(a: GitHubRepo, b: GitHubRepo): number {
  const sa = a.productScore?.score ?? 0;
  const sb = b.productScore?.score ?? 0;
  if (sb !== sa) return sb - sa;
  if (b.stars !== a.stars) return b.stars - a.stars;
  return a.fullName.localeCompare(b.fullName);
}

/* ------------------------------ D1 同步 ------------------------------ */

/**
 * 卡片 = 仓库去掉 readme 与 history。
 * readme 平均 30KB 最大 421KB，history 是每日快照数组 —— 都不该进列表查询。
 */
function toCard(repo: GitHubRepo): Record<string, unknown> {
  const card: Record<string, unknown> = { ...repo };
  delete card.readme;
  delete card.history;
  return card;
}

/** 构造名次表：kept 的顺序就是名次，不再重排 */
function toRows(kept: readonly GitHubRepo[]): PublishRow[] {
  return kept.map((repo, i) => {
    const rank = i + 1;
    return {
      key: repo.fullName,
      rank,
      score: repo.productScore?.score ?? 0,
      // github 榜不分层，全部进主榜
      tier: "core",
      name: repo.fullName,
      url: repo.htmlUrl,
      cats: repo.categories?.length ? repo.categories : null,
      card: { rank, ...toCard(repo) },
      detail: repo,
    };
  });
}

/**
 * 读「现榜」基线。
 *
 * 库是唯一真源：从当前版本快照还原，README 与中文情报都在 detail 里。
 * 没有 D1 通道时才回落到构建缓存文件（本地离线调试）。
 */
async function loadCurrentBoard(): Promise<{
  updatedAt?: string;
  ruleVersion?: string;
  scoreModel?: string;
  repos: GitHubRepo[];
}> {
  if (d1Configured()) {
    const { repos, meta } = await readListedGithub();
    return {
      updatedAt: typeof meta.updatedAt === "string" ? meta.updatedAt : undefined,
      ruleVersion: typeof meta.ruleVersion === "string" ? meta.ruleVersion : undefined,
      scoreModel: typeof meta.scoreModel === "string" ? meta.scoreModel : undefined,
      repos,
    };
  }
  if (!fs.existsSync(GITHUB_PATH)) {
    throw new Error(
      "既没有 D1 通道，也没有 content/github.json 缓存：先配置 D1，或跑一次 hydrate-github",
    );
  }
  console.log("[publish] 无 D1 通道，现榜回落到 content/github.json 缓存");
  return JSON.parse(fs.readFileSync(GITHUB_PATH, "utf-8")) as {
    updatedAt?: string;
    ruleVersion?: string;
    scoreModel?: string;
    repos: GitHubRepo[];
  };
}

async function main(): Promise<void> {
  /*
   * --resync：只把现有 JSON 重灌进 D1，不动榜单与候选池。
   *
   * 补历史欠账时务必带上 --patch：整版发布要新建版本、继承其余五个榜、剪掉旧版本，
   * 一次三万八千行；而「库里还没有这个榜」的情况下增量写只会插入这个榜自己的一千多行。
   * 唯一的代价是不产生新版本 —— 反正之前是空的，没有什么可回滚的。
   *
   * 现在 github.json 已不入库，这个模式只在本地有缓存文件时可用，
   * 属于历史补偿手段，日常发布不再需要。
   */
  if (process.argv.includes("--resync")) {
    if (!fs.existsSync(GITHUB_PATH)) {
      throw new Error(
        "--resync 需要本地 content/github.json 缓存，但它已不入库。\n" +
          "先跑 pnpm tsx scripts/admin/hydrate-github.ts 从库还原，或直接用正常发布流程。",
      );
    }
    const board = JSON.parse(fs.readFileSync(GITHUB_PATH, "utf-8")) as { repos?: GitHubRepo[] };
    const rows = toRows(board.repos ?? []);
    console.log(`[publish] resync：按现有 ${rows.length} 条重灌 D1（不改榜单 / 候选池）`);
    await syncBoardToD1({
      board: "github",
      rows,
      actor: process.env.GITHUB_ACTOR ?? "manual",
    });
    return;
  }

  /*
   * --repost：把「已经 hydrate 到本地的现榜文件」整榜写回库，不碰候选池、不算位次。
   *
   * 用于发布之后的人工补写：发布只写库，而中文情报富化（enrich-github-insight）
   * 仍然是对文件动手 —— 补完再用这个模式推回库，库与文件就一致了。
   */
  if (process.argv.includes("--repost")) {
    if (!fs.existsSync(GITHUB_PATH)) {
      throw new Error("--repost 需要先 hydrate-github 还原出 content/github.json");
    }
    const board = JSON.parse(fs.readFileSync(GITHUB_PATH, "utf-8")) as {
      updatedAt?: string;
      ruleVersion?: string;
      scoreModel?: string;
      repos: GitHubRepo[];
    };
    const rows = toRows(board.repos ?? []);
    console.log(`[publish] repost：按本地 ${rows.length} 条回写 D1（不动候选池、不算位次）`);
    await syncBoardToD1({
      board: "github",
      rows,
      actor: process.env.GITHUB_ACTOR ?? "manual",
      patch: true,
      meta: {
        updatedAt: board.updatedAt,
        ruleVersion: board.ruleVersion,
        scoreModel: board.scoreModel,
      },
    });
    return;
  }

  if (!fs.existsSync(STAGING_PATH)) throw new Error("候选池不存在，请先点「采集」");

  const board = await loadCurrentBoard();
  const staging = JSON.parse(fs.readFileSync(STAGING_PATH, "utf-8")) as RepoStagingFile;

  /* 后台的审核只写 D1：候选与拒绝名单以库为准，库里空了才回落到文件 */
  const dbItems = await listCandidates<StagingCandidate>("github");
  if (dbItems.length > 0) {
    staging.candidates = dbItems
      .filter((r) => r.status !== "rejected" && r.card)
      .map((r) => r.card as StagingCandidate);
    const dbRejected = dbItems.filter((r) => r.status === "rejected").map((r) => r.itemKey);
    staging.rejected = [...new Set([...(staging.rejected ?? []), ...dbRejected])];
  }

  const beforeRepos = board.repos ?? [];
  const target = staging.target || 2000;
  const rejected = new Set(staging.rejected ?? []);

  if (!staging.candidates.length && !staging.updates.length) {
    throw new Error("候选池是空的，没有可发布的内容");
  }

  console.log(
    `[publish] 正式榜 ${beforeRepos.length} 条 · 候选 ${staging.candidates.length} 个 · 数值更新 ${staging.updates.length} 条 · 容量 ${target}`,
  );

  const byKey = new Map(beforeRepos.map((r) => [r.fullName.toLowerCase(), r]));

  /* 1) 应用现榜条目的数值更新（只动数值，不动 README / 中文情报） */
  let updated = 0;
  for (const u of staging.updates) {
    const repo = byKey.get(u.fullName.toLowerCase());
    if (!repo) continue;
    repo.stars = u.stars;
    repo.forks = u.forks;
    repo.openIssues = u.openIssues;
    if (u.pushedAt) repo.pushedAt = u.pushedAt;
    if (u.description) repo.description = u.description;
    if (u.homepage) repo.homepage = u.homepage;
    repo.productScore = computeProductScore(repo);
    updated++;
  }
  console.log(`[publish] 数值更新 ${updated} 条`);

  /* 2) 合并新候选：缺 README 的在这里补（候选池为控制体积没有存全文） */
  let added = 0;
  let readmeFetched = 0;
  for (const c of staging.candidates) {
    const key = c.repo.fullName.toLowerCase();
    if (rejected.has(key)) continue;
    const existing = byKey.get(key);
    if (existing) {
      /* 已经存在：只更新数值，避免覆盖已生成的中文情报 */
      existing.stars = c.repo.stars;
      existing.forks = c.repo.forks;
      existing.openIssues = c.repo.openIssues;
      existing.pushedAt = c.repo.pushedAt;
      existing.productScore = computeProductScore(existing);
      continue;
    }
    const repo: GitHubRepo = { ...c.repo };
    if (!repo.readme) {
      repo.readme = await fetchReadme(repo.fullName);
      if (repo.readme) readmeFetched++;
    }
    repo.productScore = computeProductScore(repo);
    byKey.set(key, repo);
    added++;
  }
  console.log(`[publish] 新增 ${added} 条（补 README ${readmeFetched} 次请求）`);

  /* 3) 排序后硬截断到 target */
  const merged = [...byKey.values()].sort(compareRepos);
  const kept = merged.slice(0, target);
  const truncated = merged.length - kept.length;

  /* 4) 与旧榜对比：这就是后台要提醒用户的「榜单变化」 */
  const beforeRows: RepoRankRow[] = beforeRepos.map(toRepoRankRow);
  const afterRows: RepoRankRow[] = kept.map(toRepoRankRow);
  const report = diffRepoRanks(beforeRows, afterRows);

  const line = (c: { fullName: string; from: number | null; to: number | null }) =>
    `  ${c.from === null ? "NEW" : c.from} → ${c.to === null ? "OUT" : c.to}`.padEnd(16) + c.fullName;

  console.log(`\n[publish] 榜单变化 ${beforeRows.length} → ${afterRows.length} 条`);
  if (truncated > 0) console.log(`[publish] 超出容量的 ${truncated} 条已截断`);
  console.log(`  新进榜 ${report.entered.length} · 出榜 ${report.exited.length}`);
  console.log(`  上升 ${report.ups.length} · 下降 ${report.downs.length} · 显著变动 ${report.significant.length}`);
  if (report.entered.length) {
    console.log("\n  新进榜：");
    for (const c of report.entered.slice(0, REPORT_LIMIT)) console.log(line(c));
  }
  if (report.exited.length) {
    console.log("\n  出榜：");
    for (const c of report.exited.slice(0, REPORT_LIMIT)) console.log(line(c));
  }
  if (report.top.length) {
    console.log("\n  前 50 名变动：");
    for (const c of report.top.slice(0, REPORT_LIMIT)) console.log(line(c));
  }

  /* 5) 组装新榜：只写库，不落文件（文件由构建时的 hydrate-github 从库还原） */
  const out = {
    updatedAt: new Date().toISOString(),
    ruleVersion: RANKING_RULE_VERSION,
    scoreModel: "pps-v4",
    repos: kept,
  };

  if (!DRY) {
    console.log(`\n[publish] 新榜 ${kept.length} 条，写入 D1`);

    /* 候选池清空，只留一份「上次发布」摘要供后台展示 */
    const nextStaging: RepoStagingFile = {
      ...staging,
      updatedAt: new Date().toISOString(),
      candidates: [],
      updates: [],
      board: { updatedAt: out.updatedAt, rows: afterRows },
      preview: null,
      lastPublish: {
        at: out.updatedAt,
        total: kept.length,
        source: "manual",
        report: {
          entered: report.entered.length,
          exited: report.exited.length,
          ups: report.ups.length,
          downs: report.downs.length,
          significant: report.significant.length,
        },
      },
    };
    fs.writeFileSync(STAGING_PATH, JSON.stringify(nextStaging, null, 2) + "\n", "utf-8");
    console.log(`[publish] 候选池已清空，发布摘要已记录`);

    /* 后台只读库：发布后的榜快照与摘要同步一份 */
    await saveReport(
      "github-meta",
      {
        updatedAt: nextStaging.updatedAt,
        ruleVersion: nextStaging.ruleVersion,
        scoreModel: nextStaging.scoreModel,
        target: nextStaging.target,
        board: nextStaging.board,
        lastRun: nextStaging.lastRun ?? null,
        lastPublish: nextStaging.lastPublish ?? null,
        preview: null,
      },
      "publish-github",
    );

    /* 库里同步清空，只保留拒绝名单 —— 后台刷新后不该再看到已发布的候选 */
    await clearCandidates("github");
    const n = await syncCandidates(
      "github",
      (nextStaging.rejected ?? []).map((key) => ({
        itemKey: key,
        name: key,
        status: "rejected" as const,
      })),
    );
    if (n > 0) console.log(`[publish] D1 候选池已清空，保留拒绝名单 ${n} 条`);
  } else {
    console.log("\n[publish] --dry：未写入库");
  }

  /* 6) 同步 D1：这是唯一落点，写不进去就等于没发布 */
  const d1 = DRY
    ? { ok: true }
    : await syncBoardToD1({
        board: "github",
        rows: toRows(kept),
        actor: process.env.GITHUB_ACTOR ?? "manual",
        /* updatedAt / ruleVersion / scoreModel 不是条目字段，存进 board_stats.meta */
        meta: {
          updatedAt: out.updatedAt,
          ruleVersion: out.ruleVersion,
          scoreModel: out.scoreModel,
        },
      });

  const freshNames = report.entered.map((c) => c.fullName);

  /* 给下游 enrich 步骤用：一行一个仓库全名。
     用 GNU 参数传 300 个全名会超出命令行长度，Actions 里改成读文件更稳。 */
  try {
    fs.writeFileSync(path.join(ROOT, ".gh-entered.txt"), freshNames.join("\n") + "\n", "utf-8");
  } catch {
    /* 写不了就算了，不影响发布本身 */
  }

  console.log(
    `##GH_PUBLISH_RESULT##${JSON.stringify({
      ok: true,
      total: kept.length,
      target,
      added,
      updated,
      truncated,
      entered: report.entered.length,
      exited: report.exited.length,
      ups: report.ups.length,
      downs: report.downs.length,
      significant: report.significant.length,
      /* D1 冷备的写入结果，后台据此提示「D1 未同步」 */
      d1: {
        ok: d1.ok,
        version: d1.version ?? null,
        listed: d1.listed ?? 0,
        error: d1.error ?? null,
      },
      /* 供下一步 enrich 用：新入榜的条目没有中文情报 */
      enteredNames: freshNames.slice(0, 300),
    })}`,
  );
}

main().catch((e) => {
  console.error("[publish] 失败：", e);
  console.log(`##GH_PUBLISH_RESULT##${JSON.stringify({ ok: false, error: String(e) })}`);
  process.exitCode = 1;
});