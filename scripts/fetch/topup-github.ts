import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { GitHubRepo } from "@horizons/shared";
import "./config"; // 副作用导入：加载 .env.local
import { config } from "./config";
import { backfillHistory, heatFromStars, mapCategories, readmeSummary } from "./github-utils";
import { RANKING_RULES, RANKING_RULE_VERSION, checkRankable, type RankItem } from "./github-ranking-rules";

/**
 * GitHub 榜「补量」：在不改动现有榜单条目的前提下，按收录原则再纳入 N 个新项目。
 *
 * 与 rebuild-github.ts 的区别：rebuild 会重建整张榜（可能把已入榜的挤出前 N）；
 * 本脚本只做增量——现有条目原样保留（连 history / insight 都不动），只把
 * 「通过原则 + 未入榜」的候选按综合得分择优补进来。
 *
 * 用法：
 *   TOPUP=50 pnpm tsx scripts/fetch/topup-github.ts
 *   TOPUP=50 REFRESH=1 pnpm tsx scripts/fetch/topup-github.ts   # 重新跑搜索（默认复用候选缓存）
 *   TOPUP=50 DRY=1 pnpm tsx scripts/fetch/topup-github.ts       # 只看会补哪些，不写文件
 *
 * 补完之后跑：
 *   pnpm tsx scripts/fetch/enrich-github-insight.ts   # 给新条目生成中文情报并重算得分
 *   pnpm tsx scripts/build/web-data.mjs               # github.json → github-web.json
 */

const OUT = path.resolve(process.cwd(), "content/github.json");
const BACKUP_DIR = path.resolve(process.cwd(), "content/backup");
const BASE_CACHE = path.resolve(process.cwd(), "content/cache/github-candidates.json");
const TOPUP_CACHE = path.resolve(process.cwd(), "content/cache/github-topup-candidates.json");

const TOPUP = Math.max(1, parseInt(process.env.TOPUP ?? "50", 10) || 50);
const DRY = process.env.DRY === "1";
const REFRESH = process.env.REFRESH === "1";
/** 深抓（README/贡献者/提交曲线）的候选数：取补齐量的 3 倍，筛掉"数据不全、得分虚高"的 */
const DEEP_POOL = Math.max(TOPUP * 3, 60);
const PER_PAGE = 100;
const SEARCH_PAGES = 2;
const TOKEN = process.env.GITHUB_TOKEN;

/**
 * 专项搜索词：面向「有潜力、有前景」的方向（2026 年增量最大的 AI 应用层），
 * 与 rebuild 的通用词互补，专门去找还没进榜但正在起量的项目。
 */
const TOPUP_QUERIES = [
  /* 智能体工程化：MCP / 沙箱 / 记忆 / 评测 */
  "topic:mcp-server stars:>=800",
  "topic:model-context-protocol stars:>=500",
  "topic:agentic-workflows stars:>=200",
  "topic:ai-sandbox stars:>=300",
  "topic:code-interpreter stars:>=300",
  "topic:agent-memory stars:>=200",
  "topic:llm-evaluation stars:>=300",
  "topic:llm-observability stars:>=300",
  /* 浏览器 / 电脑操作类智能体 */
  "topic:computer-use stars:>=300",
  "topic:browser-agent stars:>=500",
  "topic:deep-research stars:>=200",
  /* 生成：视频 / 数字人 / 试穿 / 语音 */
  "topic:ai-video stars:>=500",
  "topic:digital-human stars:>=300",
  "topic:virtual-try-on stars:>=200",
  "topic:realtime-voice stars:>=200",
  "topic:voice-agent stars:>=300",
  "topic:ai-podcast stars:>=200",
  /* 交付形态：设计稿转代码 / 演示文稿 / 表格 / 翻译 */
  "topic:ui-generation stars:>=200",
  "topic:vibe-coding stars:>=300",
  "topic:ai-presentation stars:>=200",
  "topic:ai-spreadsheet stars:>=200",
  "topic:ai-translation stars:>=300",
  /* 增长与经营：SEO / 客服 / 销售线索 */
  "topic:generative-engine-optimization stars:>=100",
  "topic:ai-customer-support stars:>=200",
  "topic:ai-sdr stars:>=100",
];

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

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 专项搜索（结果缓存，避免重复消耗搜索配额） */
async function searchExtras(): Promise<SearchItem[]> {
  const cached = readJson<{ fetchedAt?: string; items?: SearchItem[] }>(TOPUP_CACHE);
  if (!REFRESH && cached?.items?.length) {
    const age = Date.now() - Date.parse(cached.fetchedAt ?? "");
    if (age < 12 * 3600_000) {
      console.log(`[topup] 复用专项候选缓存（${cached.items.length} 个，${Math.round(age / 60000)} 分钟前）`);
      return cached.items;
    }
  }

  const found = new Map<string, SearchItem>();
  for (const [i, q] of TOPUP_QUERIES.entries()) {
    let added = 0;
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const url =
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}` +
        `&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`;
      try {
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) {
          console.warn(`[topup] 搜索失败 ${res.status}：${q}（第 ${page} 页）`);
          break;
        }
        const data = (await res.json()) as { items?: SearchItem[] };
        if (!data.items?.length) break;
        for (const it of data.items) {
          const key = it.full_name.toLowerCase();
          if (found.has(key)) continue;
          found.set(key, it);
          added++;
        }
        if (data.items.length < PER_PAGE) break;
      } catch (e) {
        console.warn(`[topup] 搜索异常 ${q}：`, e instanceof Error ? e.message : e);
        break;
      }
      await sleep(2400);
    }
    console.log(`[topup] (${i + 1}/${TOPUP_QUERIES.length}) ${q} → +${added}，累计 ${found.size}`);
  }

  try {
    fs.mkdirSync(path.dirname(TOPUP_CACHE), { recursive: true });
    fs.writeFileSync(
      TOPUP_CACHE,
      JSON.stringify({ fetchedAt: new Date().toISOString(), items: [...found.values()] }, null, 2) + "\n",
      "utf-8",
    );
  } catch (e) {
    console.warn("[topup] 专项候选缓存写入失败：", e instanceof Error ? e.message : e);
  }
  return [...found.values()];
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
    license: d.license?.spdx_id ? { spdx: d.license.spdx_id, name: d.license.name ?? undefined } : undefined,
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
  if (budget.left <= 1) return "";
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
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=false`, {
      headers: headers(),
    });
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
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`, {
      headers: headers(),
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { total?: number }[];
    return Array.isArray(j) ? j.map((w) => w.total ?? 0) : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  console.log(
    `[topup] 原则 ${RANKING_RULE_VERSION}：补 ${TOPUP} 个 · 深抓池 ${DEEP_POOL} 个` +
      `${TOKEN ? "（带 token）" : "（无 token，匿名限流）"}${DRY ? " · DRY RUN" : ""}`,
  );

  /* 0. 读现有榜单 */
  const data = readJson<{ updatedAt: string; ruleVersion: string; repos: GitHubRepo[] }>(OUT);
  if (!data?.repos?.length) throw new Error(`读不到现有榜单：${OUT}`);
  const existing = data.repos;
  const have = new Set(existing.map((r) => r.fullName.toLowerCase()));
  console.log(`[topup] 现有 ${existing.length} 个`);

  if (!DRY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backup = path.join(BACKUP_DIR, `github-${stamp}.json`);
    fs.copyFileSync(OUT, backup);
    console.log(`[topup] 已备份 → ${backup}`);
  }

  /* 1. 候选池：rebuild 的通用候选缓存 + 专项搜索 */
  const baseItems = readJson<{ items?: SearchItem[] }>(BASE_CACHE)?.items ?? [];
  const extraItems = await searchExtras();

  const candidates = new Map<string, SearchItem>();
  for (const it of [...baseItems, ...extraItems]) {
    const key = it.full_name.toLowerCase();
    if (!have.has(key) && !candidates.has(key)) candidates.set(key, it);
  }
  console.log(`[topup] 未入榜候选 ${candidates.size} 个（通用缓存 ${baseItems.length} · 专项 ${extraItems.length}）`);

  /* 2. 原则判定 */
  const rejected: Record<string, number> = {};
  const passed: GitHubRepo[] = [];
  for (const it of candidates.values()) {
    const check = checkRankable(it);
    if (!check.ok) {
      rejected[check.reason ?? "其他"] = (rejected[check.reason ?? "其他"] ?? 0) + 1;
      continue;
    }
    passed.push(toRepo(it));
  }
  console.log(
    `[topup] 通过原则 ${passed.length} 个 · 淘汰：` +
      Object.entries(rejected)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  );
  if (!passed.length) throw new Error("没有通过原则的新候选，无需补量");

  /* 3. 粗排（尚无 README）：先削到深抓池 */
  const rough = passed
    .map((r) => ({ ...r, history: backfillHistory(r), productScore: computeProductScore(r) }))
    .sort(compareByScore);
  const pool = rough.slice(0, DEEP_POOL);
  console.log(`[topup] 深抓池 ${pool.length} 个（最高分 ${pool[0]?.productScore?.score}）`);

  /* 4. 深抓 README / 贡献者 / 提交曲线 */
  const budget = { left: await coreRemaining() };
  console.log(`[topup] core 剩余 ${budget.left}`);
  for (const [i, r] of pool.entries()) {
    r.readme = await fetchReadme(r.fullName, budget);
    if (r.readme) r.readmeSummary = readmeSummary(r.readme);
    r.contributorsCount = await fetchContributors(r.fullName);
    r.commitActivity = await fetchCommitActivity(r.fullName);
    console.log(
      `[topup] (${i + 1}/${pool.length}) ${r.fullName} · README ${r.readme ? "✓" : "×"} · 贡献者 ${
        r.contributorsCount ?? "—"
      }`,
    );
    await sleep(180);
  }

  /* 5. 精排：带上 README 后再算一次分，取前 TOPUP */
  const ranked = pool
    .map((r) => ({ ...r, history: backfillHistory(r), productScore: computeProductScore(r) }))
    .sort(compareByScore);
  const picked = ranked.slice(0, TOPUP);
  console.log(`[topup] 入选 ${picked.length} 个（最低分 ${picked[picked.length - 1]?.productScore?.score}）`);

  /* 6. 合并 + 全量重排（现有条目不增不减） */
  const merged = [...existing, ...picked].sort(compareByScore);
  if (!DRY) {
    fs.writeFileSync(
      OUT,
      JSON.stringify({ ...data, updatedAt: new Date().toISOString(), ruleVersion: RANKING_RULE_VERSION, repos: merged }, null, 2) +
        "\n",
      "utf-8",
    );
  }
  console.log(`[topup] ${DRY ? "预演" : "写入"}完成：${existing.length} → ${merged.length} 个`);

  const byCat: Record<string, number> = {};
  for (const r of picked) byCat[r.categories[0] ?? "Other"] = (byCat[r.categories[0] ?? "Other"] ?? 0) + 1;
  console.log("[topup] 新增方向分布：" + Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · "));

  console.log("[topup] 新增清单：");
  for (const r of picked) {
    console.log(
      `  ${r.fullName} · ★${r.stars} · 得分 ${r.productScore?.score} · ${r.categories.join("/")} · ${r.language ?? "—"}`,
    );
  }
  console.log("[topup] 下一步：pnpm tsx scripts/fetch/enrich-github-insight.ts（生成中文情报并重算得分）");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});