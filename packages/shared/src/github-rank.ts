/**
 * GitHub 榜的排位口径与位次变化。
 *
 * 这套算法有三个使用者：站点构建（artifacts.ts 排序）、后台发布预览（谁进谁出）、
 * 发布脚本（真正合并时再算一遍）。三处各写一份的话，预览说「挤掉第 1800 名」、
 * 发布却挤掉第 1795 名，用户没法信任这个按钮。所以排序规则只在这里定义一次。
 *
 * 排序必须与 score.ts 的 compareByScore 完全一致：
 *   综合分降序 → 星标降序 → 全名字典序
 */
import type { GitHubRepo } from "./types";
import { computeProductScore } from "./score";

/** 前 N 名的任何变动都要单独提醒 */
export const REPO_TOP_N = 50;
/**
 * 综合分变化超过这个值，才算「它自己变了」。
 *
 * 不能再用名次变动来判断：2000 条的榜单纯插入 68 个高分段项目，
 * 后面上千条都会顺延，按名次算就是 1213 条「显著变动」——全是噪音。
 * 读者真正关心的是「这个项目本身变强/变弱了吗」，还是「只是被人挤下去了」。
 */
export const REPO_SIGNIFICANT_SCORE_DELTA = 0.5;

/**
 * 排位所需的极简信息。
 *
 * content/github.json 有 59MB（每条带 README 全文），后台不可能每次都拉下来解析。
 * 所以候选池里附一份「当前榜单的计分快照」，2000 条也就几百 KB。
 */
export interface RepoRankRow {
  fullName: string;
  /** 综合分，已 round1 */
  score: number;
  stars: number;
  grade: string;
  /** 加工空间 0-10；未评估为 null */
  dv: number | null;
}

export function toRepoRankRow(r: GitHubRepo): RepoRankRow {
  const s = r.productScore ?? computeProductScore(r);
  return {
    fullName: r.fullName,
    score: s.score,
    stars: r.stars,
    grade: s.grade,
    dv: typeof r.derivative?.space === "number" ? r.derivative.space : null,
  };
}

/** 名次表：1 起，与 compareByScore 同口径 */
export function rankRepos(rows: RepoRankRow[]): Map<string, number> {
  const ordered = [...rows].sort(
    (a, b) => b.score - a.score || b.stars - a.stars || a.fullName.localeCompare(b.fullName),
  );
  return new Map(ordered.map((r, i) => [r.fullName, i + 1]));
}

/** 按排名口径排序后的列表 */
export function sortRepoRows(rows: RepoRankRow[]): RepoRankRow[] {
  return [...rows].sort(
    (a, b) => b.score - a.score || b.stars - a.stars || a.fullName.localeCompare(b.fullName),
  );
}

/** 取前 N 名（榜单容量上限就是靠这个兜住的） */
export function pickTopRepoRows(rows: RepoRankRow[], limit: number): RepoRankRow[] {
  const sorted = sortRepoRows(rows);
  return limit > 0 ? sorted.slice(0, limit) : sorted;
}

export interface RepoRankChange {
  fullName: string;
  /** 发布前名次，null = 新进榜 */
  from: number | null;
  /** 发布后名次，null = 出榜（被挤出容量上限也算出榜） */
  to: number | null;
  /** 正数上升、负数下降；新进/出榜为 0 */
  delta: number;
  /** 综合分变化（发布后 − 发布前），用于区分「自己变强了」和「被别人挤下去」 */
  scoreDelta: number;
  /** 是否值得提醒：新进/出榜、涉及前 50、或自身分数变化 >= 0.5 */
  significant: boolean;
}

export interface RepoRankReport {
  boardBefore: number;
  boardAfter: number;
  entered: RepoRankChange[];
  exited: RepoRankChange[];
  ups: RepoRankChange[];
  downs: RepoRankChange[];
  /** 涉及前 TOP_N 的变动 */
  top: RepoRankChange[];
  /** 显著变动 */
  significant: RepoRankChange[];
  /** 仅顺延、不值得提醒的条数 */
  shifted: number;
  changes: RepoRankChange[];
}

/** 对比两份榜单快照，算出每个仓库的位次变化 */
export function diffRepoRanks(before: RepoRankRow[], after: RepoRankRow[]): RepoRankReport {
  const beforeRanks = rankRepos(before);
  const afterRanks = rankRepos(after);
  const beforeScore = new Map(before.map((r) => [r.fullName, r.score]));
  const afterScore = new Map(after.map((r) => [r.fullName, r.score]));

  const changes: RepoRankChange[] = [];
  const push = (fullName: string, from: number | null, to: number | null): void => {
    const delta = from !== null && to !== null ? from - to : 0;
    const b = beforeScore.get(fullName);
    const a = afterScore.get(fullName);
    const scoreDelta = b === undefined || a === undefined ? 0 : Math.round((a - b) * 10) / 10;
    const significant =
      from === null ||
      to === null ||
      (from <= REPO_TOP_N && from !== to) ||
      (to <= REPO_TOP_N && from !== to) ||
      Math.abs(scoreDelta) >= REPO_SIGNIFICANT_SCORE_DELTA;
    changes.push({ fullName, from, to, delta, scoreDelta, significant });
  };

  for (const [fullName, to] of afterRanks) {
    const from = beforeRanks.get(fullName) ?? null;
    if (from !== to) push(fullName, from, to);
  }
  for (const [fullName, from] of beforeRanks) {
    if (!afterRanks.has(fullName)) push(fullName, from, null);
  }

  const entered = changes.filter((c) => c.from === null).sort((a, b) => (a.to ?? 0) - (b.to ?? 0));
  const exited = changes.filter((c) => c.to === null).sort((a, b) => (a.from ?? 0) - (b.from ?? 0));
  /* 只列值得提醒的升降：单纯被顺延上千条，列出来只会淹没真正的变化 */
  const ups = changes
    .filter((c) => c.delta > 0 && c.significant)
    .sort((a, b) => b.delta - a.delta);
  const downs = changes
    .filter((c) => c.delta < 0 && c.significant)
    .sort((a, b) => a.delta - b.delta);
  const top = changes.filter(
    (c) => (c.from !== null && c.from <= REPO_TOP_N) || (c.to !== null && c.to <= REPO_TOP_N),
  );
  const significant = changes.filter((c) => c.significant);

  return {
    boardBefore: beforeRanks.size,
    boardAfter: afterRanks.size,
    entered,
    exited,
    ups,
    downs,
    top,
    significant,
    shifted: changes.length - significant.length,
    changes,
  };
}

/** 便捷包装：直接拿完整仓库对象算 */
export function diffGitHubRepos(before: GitHubRepo[], after: GitHubRepo[]): RepoRankReport {
  return diffRepoRanks(before.map(toRepoRankRow), after.map(toRepoRankRow));
}

/* ------------------------------ 候选池格式 ------------------------------ */
/*
 * content/github-staging.json 的形状。
 *
 * 放在 shared 里而不是脚本里，是因为有三个消费者：采集脚本写它、发布脚本读它、
 * 后台 API 读它。三处各定义一份的话，改一个字段就会静默错位。
 *
 * 为什么候选池里不存 README 全文：正式榜 2000 条的 README 有几十 MB，
 * 而 GitHub contents API 单文件上限 1MB —— 存了后台根本写不进去。
 * 所以候选池只存摘要，发布时再补全文。
 */

/** 待审核的新候选 */
export interface StagingCandidate {
  repo: GitHubRepo;
  score: number;
  grade: string;
  /** 预计进入榜单的名次（1 起）；null = 挤不进容量上限 */
  estimatedRank: number | null;
  /** 采集时的判定结论，便于后台解释「它为什么在/不在候选里」 */
  check: { ok: boolean; reason: string };
}

/** 现榜条目本次采集到的新数值：只覆盖这些字段，README 与情报一律保留 */
export interface StagingUpdate {
  fullName: string;
  stars: number;
  forks: number;
  openIssues: number;
  pushedAt?: string;
  description?: string;
  homepage?: string;
  /**
   * 这次真的打到 GitHub 了，是什么时候。
   *
   * 必须带上：发布时 `board_listed.last_crawled_at` 就取 `card.lastCrawledAt`，
   * 少了它，刷新过的条目线上还写着上次采集日 —— 后台「7 天未更新」永远
   * 是满榜 1500，按数据日分组也永远只有旧的那一天。
   */
  lastCrawledAt?: string;
  score: number;
  grade: string;
}

/** content/github-staging.json */
export interface RepoStagingFile {
  updatedAt: string;
  ruleVersion: string;
  scoreModel: string;
  /** 榜单容量上限 */
  target: number;
  /** 当前正式榜的计分快照，后台预览不必拉 59MB 的 github.json */
  board: { updatedAt?: string; rows: RepoRankRow[] };
  candidates: StagingCandidate[];
  updates: StagingUpdate[];
  /** 永久拒绝的仓库全名（小写） */
  rejected: string[];
  /** 预计发布后的变化；发布时会用真实合并结果重算 */
  preview: RepoRankReport | null;
  lastRun?: {
    at: string;
    candidates: number;
    qualified: number;
    fresh: number;
    entered: number;
    exited: number;
    shortfall: number;
    elapsedMs: number;
  };
  lastPublish?: {
    at: string;
    total: number;
    source: string;
    report: { entered: number; exited: number; ups: number; downs: number; significant: number };
  };
}