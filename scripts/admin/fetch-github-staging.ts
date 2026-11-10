/**
 * 后台「采集 GitHub 榜」入口（由 .github/workflows/fetch-github.yml 调用）。
 *
 * 与 `rebuild-github.ts` 的关键区别：**不写 content/github.json**。
 * 结果落到 content/github-staging.json 等后台审核，点「发布」后才由
 * publish-github.ts 合并进正式榜 —— 与工具榜、趋势榜是同一套双阶段流程。
 *
 * 采集做四件事：
 *   1. 搜索候选池（复用 rebuild 的 6 小时候选缓存，避免反复打搜索接口）
 *   2. 按收录原则判定，补 README / 贡献者 / 提交活跃度
 *   3. 现榜条目只更新数值（星标、issue、推送时间）并重算分数，
 *      绝不覆盖已有的 README 与中文情报 —— 那是花了 LLM 成本攒下来的
 *   4. 与当前榜对比，算出「预计发布后」谁进、谁出、谁升降
 *
 * 用法：
 *   pnpm tsx scripts/admin/fetch-github-staging.ts                    # 目标 2000 条
 *   TARGET=2000 SEARCH_PAGES=5 pnpm tsx scripts/admin/fetch-github-staging.ts
 *   pnpm tsx scripts/admin/fetch-github-staging.ts --dry              # 只统计不落盘
 *   pnpm tsx scripts/admin/fetch-github-staging.ts --refresh-cache    # 强制重搜
 *
 * 环境变量：GITHUB_TOKEN（强烈建议，匿名搜索 10 次/分钟会跑一整晚）
 */
import fs from "node:fs";
import path from "node:path";
import {
  computeProductScore,
  diffRepoRanks,
  pickTopRepoRows,
  toRepoRankRow,
} from "@horizons/shared";
import type {
  GitHubRepo,
  RepoRankRow,
  RepoRankReport,
  RepoStagingFile,
  StagingCandidate,
  StagingUpdate,
} from "@horizons/shared";
import { config } from "../fetch/config"; // 顺带加载 .env.local
import { heatFromStars, mapCategories } from "../fetch/github-utils";
import { QUERIES } from "../fetch/github-queries";
import {
  RANKING_RULES,
  RANKING_RULE_VERSION,
  checkRankable,
  type RankItem,
} from "../fetch/github-ranking-rules";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_PATH = path.join(ROOT, "content/github.json");
const STAGING_PATH = path.join(ROOT, "content/github-staging.json");
const CACHE_PATH = path.join(ROOT, "content/cache/github-candidates.json");

const TOKEN = process.env.GITHUB_TOKEN;
/** 榜单容量：发布后严格只保留前 TARGET 名 */
const TARGET = Math.max(100, parseInt(process.env.TARGET ?? "2000", 10) || 2000);
const PER_PAGE = Math.min(100, Math.max(1, parseInt(process.env.PER_PAGE ?? "100", 10) || 100));
/**
 * 搜索页数。默认 5（GitHub 上限）：
 * 3 页时合格池只有 1553 条，凑不满 2000；第 4-5 页星标虽然更低，
 * 但仍在 800 门槛之上，正好用来补足容量。
 */
const SEARCH_PAGES = Math.min(5, Math.max(1, parseInt(process.env.SEARCH_PAGES ?? "5", 10) || 5));
const SEARCH_DELAY = Math.max(2300, parseInt(process.env.SEARCH_DELAY ?? "3800", 10) || 3800);
const DRY = process.argv.includes("--dry");
const REFRESH_CACHE = process.argv.includes("--refresh-cache");
/**
 * 候选缓存的有效期（分钟）。默认 3 小时：
 * 全量搜索要打 700+ 次接口、跑近 50 分钟，后台每次点「采集」都重搜没有意义；
 * 想要最新数据就勾「强制重搜」（--refresh-cache）。
 */
const CACHE_TTL_MIN = Math.max(0, parseInt(process.env.CACHE_TTL_MIN ?? "180", 10) || 180);
/** 只跑前 N 个搜索词：调试用，正式采集不设 */
const QUERY_LIMIT = Math.max(0, parseInt(process.env.QUERY_LIMIT ?? "0", 10) || 0);
/**
 * 补 README 的上限：防止候选池异常大时把 Actions 跑爆。
 * 注意不能用 `|| 1200` 兜底 —— README_BUDGET=0 是合法值（调试时想跳过），
 * 用 || 会把它变成 1200，反而跑满配额。
 */
const README_BUDGET = (() => {
  const n = parseInt(process.env.README_BUDGET ?? "1200", 10);
  return Number.isFinite(n) && n >= 0 ? n : 1200;
})();

interface SearchItem extends RankItem {
  html_url: string;
  homepage?: string | null;
  owner?: { login?: string; avatar_url?: string };
  open_issues_count?: number;
  watchers_count?: number;
}

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

async function coreRemaining(): Promise<number> {
  try {
    const res = await fetch("https://api.github.com/rate_limit", { headers: headers() });
    if (!res.ok) return 0;
    const d = (await res.json()) as { resources?: { core?: { remaining?: number } } };
    return d.resources?.core?.remaining ?? 0;
  } catch {
    return 0;
  }
}

/** 搜索候选池：与 rebuild-github.ts 共用同一份缓存文件（格式保持一致） */
async function collectCandidates(): Promise<Map<string, SearchItem>> {
  let cachedItems: SearchItem[] = [];
  let cachedQueries: string[] = [];
  /** 缓存里每条查询已经搜到第几页；旧缓存没有这个字段，按 3 页算（rebuild 的历史默认值） */
  let cachedPages = 0;

  if (!REFRESH_CACHE && fs.existsSync(CACHE_PATH)) {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as {
        fetchedAt?: string;
        items?: SearchItem[];
        queries?: string[];
        pages?: number;
      };
      const age = Date.now() - Date.parse(c.fetchedAt ?? "");
      if (c.items?.length && age < CACHE_TTL_MIN * 60_000) {
        console.log(
          `[staging] 复用候选池缓存（${c.items.length} 个，${Math.round(age / 60000)} 分钟前）`,
        );
        return new Map(c.items.map((it) => [it.full_name.toLowerCase(), it]));
      }
      cachedItems = c.items ?? [];
      cachedQueries = c.queries ?? [];
      cachedPages = c.pages ?? (cachedQueries.length ? 3 : 0);
    } catch {
      /* 缓存损坏则重新拉取 */
    }
  }

  const found = new Map<string, SearchItem>(cachedItems.map((it) => [it.full_name.toLowerCase(), it]));

  const queries = QUERY_LIMIT > 0 ? QUERIES.slice(0, QUERY_LIMIT) : QUERIES;
  /* 缓存里已经搜过的查询，只补搜页数没搜够的部分：
     例如上次搜到第 3 页、这次要 5 页，就只补 4-5 页，不重复打前面几页。 */
  const pageFrom = cachedPages > 0 ? Math.min(cachedPages + 1, SEARCH_PAGES) : 1;
  const todoQueries =
    cachedQueries.length > 0
      ? pageFrom > SEARCH_PAGES
        ? []
        : queries.filter((q) => cachedQueries.includes(q))
      : queries;

  console.log(
    `[staging] 搜索 ${todoQueries.length} 个查询 × 第 ${pageFrom}-${SEARCH_PAGES} 页，已有候选 ${found.size}`,
  );

  for (const [i, q] of todoQueries.entries()) {
    let added = 0;
    for (let page = pageFrom; page <= SEARCH_PAGES; page++) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`;
      let done = false;
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          const res = await fetch(url, { headers: headers() });
          if (res.status === 403 || res.status === 429) {
            const wait = 20_000 * attempt;
            console.warn(`[staging] 搜索限流 ${res.status}：${q}（第 ${page} 页）→ 等待 ${wait / 1000}s`);
            await sleep(wait);
            continue;
          }
          if (!res.ok) {
            console.warn(`[staging] 搜索失败 ${res.status}：${q}（第 ${page} 页）`);
            break;
          }
          const data = (await res.json()) as { items?: SearchItem[] };
          if (!data.items?.length) {
            done = true;
            break;
          }
          for (const it of data.items) {
            const key = it.full_name.toLowerCase();
            if (found.has(key)) continue;
            found.set(key, it);
            added++;
          }
          done = true;
          if (data.items.length < PER_PAGE) break;
        } catch (e) {
          console.warn(
            `[staging] 搜索异常 ${q}（第 ${page} 页，第 ${attempt} 次）：`,
            e instanceof Error ? e.message : e,
          );
          await sleep(3000 * attempt);
        }
      }
      if (!done) break;
      await sleep(SEARCH_DELAY);
    }
    if ((i + 1) % 10 === 0 || i === todoQueries.length - 1) {
      console.log(`[staging] (${i + 1}/${todoQueries.length}) 累计候选 ${found.size}（本轮 +${added}）`);
    }
  }

  try {
    const allQueries = [...new Set([...cachedQueries, ...todoQueries])];
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(
      CACHE_PATH,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          queries: allQueries,
          pages: Math.max(cachedPages, SEARCH_PAGES),
          items: [...found.values()],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  } catch (e) {
    console.warn("[staging] 候选池缓存失败：", e instanceof Error ? e.message : e);
  }
  return found;
}

function toRepo(d: SearchItem): GitHubRepo {
  const [owner, repo] = d.full_name.split("/");
  const topics = d.topics ?? [];
  const stars = d.stargazers_count ?? 0;
  return {
    fullName: d.full_name,
    owner: d.owner?.login ?? owner ?? "",
    repo: d.name ?? repo ?? "",
    name: d.name ?? repo ?? "",
    description: d.description ?? undefined,
    htmlUrl: d.html_url,
    homepage: d.homepage || undefined,
    avatarUrl: d.owner?.avatar_url,
    language: d.language ?? undefined,
    topics,
    license: d.license?.spdx_id
      ? { spdx: d.license.spdx_id, name: d.license.name ?? undefined }
      : undefined,
    createdAt: d.created_at,
    pushedAt: d.pushed_at,
    stars,
    forks: d.forks_count ?? 0,
    openIssues: d.open_issues_count ?? 0,
    watchers: d.watchers_count,
    categories: mapCategories(topics),
    heatScore: heatFromStars(stars),
    history: [],
    lastCrawledAt: new Date().toISOString(),
  };
}

async function fetchReadme(full: string, budget: { left: number }): Promise<string> {
  if (budget.left <= 0) return "";
  budget.left--;
  const [owner, repo] = full.split("/");
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: headers({ Accept: "application/vnd.github.raw+json" }),
    });
    if (res.ok) return await res.text();
  } catch {
    /* ignore */
  }
  return "";
}

async function fetchContributors(full: string): Promise<number | undefined> {
  const [owner, repo] = full.split("/");
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=false`,
      { headers: headers() },
    );
    if (!res.ok) return undefined;
    const link = res.headers.get("link") ?? "";
    const m = link.match(/page=(\d+)>;\s*rel="last"/);
    if (m) return parseInt(m[1], 10);
    const list = (await res.json()) as unknown[];
    return Array.isArray(list) ? list.length : undefined;
  } catch {
    return undefined;
  }
}

async function fetchCommitActivity(full: string): Promise<number[] | undefined> {
  const [owner, repo] = full.split("/");
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`,
      { headers: headers() },
    );
    if (!res.ok) return undefined;
    const d = (await res.json()) as Array<{ total?: number }>;
    return Array.isArray(d) ? d.map((w) => w.total ?? 0) : undefined;
  } catch {
    return undefined;
  }
}

/** 现榜数据整份读进来：2000 条的 README + 情报是有成本的，不能重新生成 */
function loadBoard(): { repos: GitHubRepo[]; updatedAt?: string } {
  if (!fs.existsSync(GITHUB_PATH)) return { repos: [] };
  const raw = JSON.parse(fs.readFileSync(GITHUB_PATH, "utf-8")) as {
    updatedAt?: string;
    repos?: GitHubRepo[];
  };
  return { repos: raw.repos ?? [], updatedAt: raw.updatedAt };
}

function loadStaging(): RepoStagingFile | null {
  if (!fs.existsSync(STAGING_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(STAGING_PATH, "utf-8")) as RepoStagingFile;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const board = loadBoard();
  const prevStaging = loadStaging();
  const rejected = new Set(prevStaging?.rejected ?? []);

  console.log(
    `[staging] 当前榜 ${board.repos.length} 条，目标 ${TARGET} 条，商品页数据不动`,
  );

  /* 现榜按全名索引：同一个仓库再次被搜到时，只更新数值不重建 */
  const prevByKey = new Map(board.repos.map((r) => [r.fullName.toLowerCase(), r]));

  const candidates = await collectCandidates();
  console.log(`[staging] 候选池 ${candidates.size} 个`);

  const rankable: { item: SearchItem; repo: GitHubRepo }[] = [];
  const dropped: Record<string, number> = {};
  for (const item of candidates.values()) {
    const key = item.full_name.toLowerCase();
    if (rejected.has(key)) {
      dropped["人工拒绝"] = (dropped["人工拒绝"] ?? 0) + 1;
      continue;
    }
    const check = checkRankable(item);
    if (!check.ok) {
      dropped[check.reason] = (dropped[check.reason] ?? 0) + 1;
      continue;
    }
    rankable.push({ item, repo: toRepo(item) });
  }
  console.log(
    `[staging] 通过收录原则 ${rankable.length} 个；未通过：${
      Object.entries(dropped)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, v]) => `${k} ${v}`)
        .join(" / ")
    }`,
  );

  /* 现榜条目：用最新数值覆盖，README / insight / derivative / history 全部保留 */
  const refreshed: GitHubRepo[] = [];
  const updates: StagingUpdate[] = [];
  const freshKeys = new Set<string>();

  for (const { item, repo } of rankable) {
    const key = repo.fullName.toLowerCase();
    const old = prevByKey.get(key);
    if (old) {
      freshKeys.add(key);
      const merged: GitHubRepo = {
        ...old,
        stars: repo.stars,
        forks: repo.forks,
        openIssues: repo.openIssues,
        pushedAt: repo.pushedAt,
        description: repo.description ?? old.description,
        homepage: repo.homepage ?? old.homepage,
        topics: repo.topics.length ? repo.topics : old.topics,
        categories: repo.topics.length ? repo.categories : old.categories,
        heatScore: repo.heatScore,
        lastCrawledAt: repo.lastCrawledAt,
      };
      merged.productScore = computeProductScore(merged);
      refreshed.push(merged);
      updates.push({
        fullName: merged.fullName,
        stars: merged.stars,
        forks: merged.forks,
        openIssues: merged.openIssues,
        pushedAt: merged.pushedAt,
        description: merged.description,
        homepage: merged.homepage,
        score: merged.productScore.score,
        grade: merged.productScore.grade,
      });
    } else {
      refreshed.push(repo);
    }
  }
  /* 本次没搜到的现榜条目原样保留：它仍然在榜上，只是这轮搜索没覆盖到 */
  for (const old of board.repos) {
    const key = old.fullName.toLowerCase();
    if (!freshKeys.has(key) && !refreshed.some((r) => r.fullName.toLowerCase() === key)) {
      refreshed.push(old);
    }
  }

  /* 只有新候选才需要补 README：现榜条目的 README 早就有 */
  const newcomers = refreshed.filter((r) => !prevByKey.has(r.fullName.toLowerCase()));
  const budget = { left: Math.min(README_BUDGET, await coreRemaining()) };
  console.log(
    `[staging] 新候选 ${newcomers.length} 个，本次可补 README ${budget.left} 个（API 余量）`,
  );

  let enriched = 0;
  for (const [i, repo] of newcomers.entries()) {
    if (!repo.readme && budget.left > 0) {
      repo.readme = await fetchReadme(repo.fullName, budget);
      repo.readmeSummary = repo.readme ? repo.readme.slice(0, 400) : undefined;
      enriched++;
    }
    if (repo.contributors === undefined && budget.left > 0) {
      budget.left--;
      repo.contributors = await fetchContributors(repo.fullName);
    }
    if (!repo.commitActivity && budget.left > 0) {
      budget.left--;
      repo.commitActivity = await fetchCommitActivity(repo.fullName);
    }
    repo.productScore = computeProductScore(repo);
    if ((i + 1) % 50 === 0) {
      console.log(`[staging] 补 README ${i + 1}/${newcomers.length}（余量 ${budget.left}）`);
    }
  }

  /* 排序取前 TARGET：容量就是靠这一刀兜住的 */
  const beforeRows: RepoRankRow[] = board.repos.map(toRepoRankRow);
  const afterRowsAll: RepoRankRow[] = refreshed.map(toRepoRankRow);
  const afterRows = pickTopRepoRows(afterRowsAll, TARGET);
  const keptKeys = new Set(afterRows.map((r) => r.fullName.toLowerCase()));

  const report = diffRepoRanks(beforeRows, afterRows);

  /* 新候选清单：只保留挤进前 TARGET 的，榜外的存了也不会发布 */
  const freshCandidates: StagingCandidate[] = refreshed
    .filter((r) => !prevByKey.has(r.fullName.toLowerCase()))
    .map((r) => {
      const score = r.productScore ?? computeProductScore(r);
      const rank = afterRows.findIndex((x) => x.fullName === r.fullName) + 1;
      return {
        repo: {
          ...r,
          /* staging 里不存 README 全文：2000 条的 README 会把文件撑到几十 MB，
             超过 GitHub contents API 的 1MB 上限，后台就存不进去了。
             发布时由 publish-github.ts 补回。 */
          readme: "",
          readmeSummary: r.readme ? r.readme.replace(/\s+/g, " ").trim().slice(0, 400) : undefined,
        },
        score: score.score,
        grade: score.grade,
        estimatedRank: rank || null,
        check: { ok: true, reason: "通过收录原则" },
      };
    })
    .filter((c) => keptKeys.has(c.repo.fullName.toLowerCase()))
    .sort((a, b) => (a.estimatedRank ?? 9999) - (b.estimatedRank ?? 9999));

  const shortfall = Math.max(0, TARGET - afterRows.length);

  const staging: RepoStagingFile = {
    updatedAt: new Date().toISOString(),
    ruleVersion: RANKING_RULE_VERSION,
    scoreModel: "pps-v4",
    target: TARGET,
    board: { updatedAt: board.updatedAt, rows: beforeRows },
    candidates: freshCandidates,
    updates,
    rejected: [...rejected],
    preview: report,
    lastRun: {
      at: new Date().toISOString(),
      candidates: candidates.size,
      qualified: rankable.length,
      fresh: freshCandidates.length,
      entered: report.entered.length,
      exited: report.exited.length,
      shortfall,
      elapsedMs: Date.now() - startedAt,
    },
    lastPublish: prevStaging?.lastPublish,
  };

  console.log(
    `[staging] 预计发布后：${afterRows.length} 条（缺口 ${shortfall}）· 进榜 ${report.entered.length} · 出榜 ${report.exited.length} · 上升 ${report.ups.length} · 下降 ${report.downs.length} · 显著 ${report.significant.length}`,
  );

  if (DRY) {
    console.log("[staging] --dry：未写入文件");
  } else {
    fs.writeFileSync(STAGING_PATH, JSON.stringify(staging, null, 2) + "\n", "utf-8");
    console.log(`[staging] 已写入 ${STAGING_PATH}`);
  }

  console.log(
    `##GH_STAGING_RESULT##${JSON.stringify({
      ok: true,
      candidates: candidates.size,
      qualified: rankable.length,
      fresh: freshCandidates.length,
      total: afterRows.length,
      target: TARGET,
      shortfall,
      entered: report.entered.length,
      exited: report.exited.length,
      significant: report.significant.length,
      elapsedMs: Date.now() - startedAt,
    })}`,
  );
}

main().catch((e) => {
  console.error("[staging] 失败：", e);
  console.log(`##GH_STAGING_RESULT##${JSON.stringify({ ok: false, error: String(e) })}`);
  process.exitCode = 1;
});