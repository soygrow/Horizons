import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { GitHubRepo } from "@horizons/shared";
import "./config";
import { config } from "./config";

/**
 * 补全 GitHub 榜缺失的统计字段（贡献者数、近 52 周提交活跃）。
 *
 * 匿名调用只有 60 次/小时，所以脚本会：读当前配额 → 只做到配额用完为止 →
 * 下次再跑会自动跳过已补齐的项目，直到全部补完。
 *
 *   pnpm tsx scripts/fetch/fill-github-stats.ts
 *   GITHUB_TOKEN=ghp_xxx pnpm tsx scripts/fetch/fill-github-stats.ts   # 一次补完
 */

const JSON_PATH = path.resolve(process.cwd(), "content/github.json");
const TOKEN = process.env.GITHUB_TOKEN;

const headers = (extra?: Record<string, string>) => {
  const h: Record<string, string> = {
    "User-Agent": config.userAgent,
    Accept: "application/vnd.github+json",
    ...extra,
  };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function remaining(): Promise<number> {
  const res = await fetch("https://api.github.com/rate_limit", { headers: headers() });
  if (!res.ok) return 0;
  const d = (await res.json()) as { resources?: { core?: { remaining?: number } } };
  return d.resources?.core?.remaining ?? 0;
}

async function contributors(full: string): Promise<number | undefined> {
  const [owner, repo] = full.split("/");
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
}

async function commitActivity(full: string): Promise<number[] | undefined> {
  const [owner, repo] = full.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`, {
    headers: headers(),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as { total?: number }[];
  return Array.isArray(j) ? j.map((w) => w.total ?? 0) : undefined;
}

async function languages(full: string): Promise<Record<string, number> | undefined> {
  const [owner, repo] = full.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
    headers: headers(),
  });
  if (!res.ok) return undefined;
  const j = (await res.json()) as Record<string, number>;
  return Object.keys(j).length ? j : undefined;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf-8")) as { repos: GitHubRepo[] };
  const repos = data.repos ?? [];
  const todo = repos.filter(
    (r) => r.contributorsCount === undefined || !r.commitActivity?.length || !r.languages,
  );
  console.log(`[stats] 待补 ${todo.length} 个 / 共 ${repos.length} 个`);

  let left = await remaining();
  console.log(`[stats] 当前配额剩余 ${left}${TOKEN ? "（带 token）" : "（匿名 60/小时）"}`);

  let done = 0;
  for (const r of todo) {
    if (left <= 2) {
      console.log(`[stats] 配额即将用尽，停在 ${done} 个，稍后重跑本脚本继续`);
      break;
    }
    if (r.contributorsCount === undefined) {
      r.contributorsCount = await contributors(r.fullName);
      left--;
    }
    if (!r.commitActivity?.length && left > 2) {
      r.commitActivity = await commitActivity(r.fullName);
      left--;
    }
    if (!r.languages && left > 2) {
      r.languages = await languages(r.fullName);
      left--;
    }
    done++;
    console.log(
      `[stats] (${done}/${todo.length}) ${r.fullName} · 贡献者 ${r.contributorsCount ?? "—"} · 提交周数 ${
        r.commitActivity?.length ?? 0
      } · 语言 ${Object.keys(r.languages ?? {}).length}`,
    );
    await sleep(250);
  }

  const scored = repos
    .map((r) => ({ ...r, productScore: computeProductScore(r) }))
    .sort(compareByScore);
  fs.writeFileSync(JSON_PATH, JSON.stringify({ ...data, repos: scored }, null, 2) + "\n", "utf-8");

  const stillMissing = scored.filter((r) => r.contributorsCount === undefined).length;
  console.log(`[stats] 已补 ${done} 个，剩余未补 ${stillMissing} 个`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});