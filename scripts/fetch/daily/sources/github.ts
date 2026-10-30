// GitHub：公开 Search API。
// 匿名可用，但额度很低（搜索 10 次/分钟）；配一个免费个人 PAT 可提到 5000 次/小时。

import { dailyConfig, githubToken } from "../config";
import { getJson, sleep } from "../http";
import { makeItem, toIso } from "../normalize";
import type { RawItem } from "../types";

const SEARCH = "https://api.github.com/search/repositories";

interface GhRepo {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  pushed_at: string;
  created_at: string;
  topics?: string[];
  license?: { spdx_id: string | null } | null;
  owner?: { login: string };
}

export interface GitHubResult {
  items: RawItem[];
  /** full_name -> 当前 Star 数，交给 store 采样后算增量 */
  stars: Record<string, number>;
  note: string;
}

export async function collectGitHub(): Promise<GitHubResult> {
  const cfg = dailyConfig.github;
  const token = githubToken();
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const day = (n: number): string =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  const byRepo = new Map<string, RawItem>();
  const stars: Record<string, number> = {};
  const notes: string[] = [];
  let requests = 0;

  /**
   * 两种排序各有用处：
   * - 活跃榜 sort=updated：今天真的在动的项目
   * - 新星榜 created 限定 + sort=stars：新项目里涨得快的
   * 只按累计 Star 排会永远被巨型老项目占满，这正是要避开的坑。
   */
  const passes: Array<{ tag: string; q: (topic: string) => string; sort: string; per: number }> = [
    {
      tag: "active",
      sort: "updated",
      per: cfg.active.perQuery,
      q: (t) => `topic:${t} stars:>=${cfg.active.minStars} pushed:>${day(cfg.active.pushedWithinDays)}`,
    },
    {
      tag: "fresh",
      sort: "stars",
      per: cfg.fresh.perQuery,
      q: (t) => `topic:${t} stars:>=${cfg.fresh.minStars} created:>${day(cfg.fresh.createdWithinDays)}`,
    },
  ];

  for (const pass of passes) {
    for (const topic of cfg.topics) {
      const q = pass.q(topic);
      const url = `${SEARCH}?q=${encodeURIComponent(q)}&sort=${pass.sort}&order=desc&per_page=${pass.per}`;
      requests++;
      try {
        const res = await getJson<{ items: GhRepo[] }>(url, { headers, timeoutMs: 20_000 });
        for (const repo of res.items ?? []) {
          const name = repo.full_name;
          if (!name) continue;
          stars[name] = repo.stargazers_count;
          if (byRepo.has(name)) continue;
          const topics = (repo.topics ?? []).slice(0, 8);
          // 平均每日得星 = 累计 Star / 存活天数。第一天没有 delta 时，
          // 这个口径至少能区分「新项目涨得快」和「老项目存量高」。
          const ageDays = Math.max(1, (Date.now() - Date.parse(repo.created_at)) / 86_400_000);
          const starPerDay = Math.round((repo.stargazers_count / ageDays) * 10) / 10;
          byRepo.set(
            name,
            makeItem({
              source: "github",
              sourceItemId: name,
              title: name,
              url: repo.html_url,
              author: repo.owner?.login ?? name.split("/")[0],
              publishedAt: toIso(repo.pushed_at),
              signals: {
                stars: repo.stargazers_count,
                forks: repo.forks_count,
                issues: repo.open_issues_count,
                starPerDay,
              },
              // 仓库本身是官方一手材料
              firstHand: true,
              categoryText: `${repo.description ?? ""} ${topics.join(" ")}`,
              raw: {
                description: repo.description ?? "",
                language: repo.language ?? "",
                license: repo.license?.spdx_id ?? "",
                createdAt: repo.created_at,
                pushedAt: repo.pushed_at,
                topics,
                origin: pass.tag,
                query: topic,
              },
            }),
          );
        }
      } catch (e) {
        notes.push(`「${q}」失败：${e instanceof Error ? e.message : String(e)}`);
      }
      // 匿名 10 次/分钟：串行 + 间隔，避免触发 403
      await sleep(token ? 1200 : 6500);
    }
  }

  const note =
    `${byRepo.size} 个仓库 / ${requests} 次请求` +
    (token ? "（已用 PAT）" : "（匿名额度，较慢）") +
    (notes.length ? `；${notes.slice(0, 2).join("；")}` : "");
  return { items: [...byRepo.values()], stars, note };
}