import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { GitHubRepo } from "@horizons/shared";
import "./config"; // 副作用导入：加载 .env.local
import { config } from "./config";
import { backfillHistory, heatFromStars, mapCategories, readmeSummary } from "./github-utils";
import {
  RANKING_RULES,
  RANKING_RULE_VERSION,
  checkRankable,
  pickTopRepos,
  primaryCategory,
  type RankItem,
} from "./github-ranking-rules";

/**
 * 按「GitHub 榜收录原则」重建榜单（原则见 github-ranking-rules.ts / docs/10-GitHub榜单收录原则.md）。
 *
 * 流程：搜索候选 → 原则判定 → 补 README → 回填历史 → 计分 → 写 content/github.json
 *
 * 用法：
 *   pnpm tsx scripts/fetch/rebuild-github.ts                # 不限总量（默认，合格即收录）
 *   LIMIT=100 pnpm tsx scripts/fetch/rebuild-github.ts      # 限定总量（按方向配额择优）
 *   GITHUB_TOKEN=ghp_xxx pnpm tsx scripts/fetch/rebuild-github.ts   # 提高限流（推荐）
 */

const OUT = path.resolve(process.cwd(), "content/github.json");
const BACKUP_DIR = path.resolve(process.cwd(), "content/backup");
const TOKEN = process.env.GITHUB_TOKEN;
/** 0 = 不限总量：通过原则的项目全部入榜，榜单随候选池持续扩张 */
const LIMIT = Math.max(0, parseInt(process.env.LIMIT ?? "0", 10) || 0);
/** 每条搜索词取多少个 / 取几页（GitHub 单页上限 100；页数越多候选池越大） */
const PER_PAGE = Math.min(100, Math.max(1, parseInt(process.env.PER_PAGE ?? "100", 10) || 100));
const SEARCH_PAGES = Math.min(5, Math.max(1, parseInt(process.env.SEARCH_PAGES ?? "2", 10) || 2));
/** QUOTA=1 时，限定总量会先按方向配额再补位；默认按综合得分直接截断前 N 个 */
const QUOTA = process.env.QUOTA === "1";

/**
 * 覆盖各方向的搜索词：门槛写进查询，减少无效结果，也保证候选池的多样性。
 * 门槛略低于收录原则里的硬门槛（星标 800），让「刚够格」的项目也能进入候选池。
 */
const QUERIES = [
  /* ---------- 核心：大模型 / 智能体 / 检索 / 推理 ---------- */
  "topic:llm stars:>=2000",
  "topic:generative-ai stars:>=2000",
  "topic:ai-agents stars:>=800",
  "topic:agent stars:>=800",
  "topic:agents stars:>=800",
  "topic:ai-agent stars:>=500",
  "topic:autonomous-agents stars:>=500",
  "topic:agentic-ai stars:>=300",
  "topic:rag stars:>=800",
  "topic:llm-inference stars:>=800",
  "topic:vector-database stars:>=800",
  "topic:ai-assistant stars:>=1000",
  "topic:chatbot stars:>=1500",
  "topic:ai-chat stars:>=500",
  "topic:mcp stars:>=800",
  "topic:mcp-server stars:>=500",
  "topic:multimodal stars:>=800",
  "topic:fine-tuning stars:>=800",
  "topic:llmops stars:>=300",
  "topic:prompt-engineering stars:>=500",

  /* ---------- 编程 / 自动化 ---------- */
  "topic:ai-coding stars:>=800",
  "topic:coding-assistant stars:>=800",
  "topic:code-generation stars:>=800",
  "topic:code-review stars:>=1000",
  "topic:web-automation stars:>=1000",
  "topic:browser-automation stars:>=1000",
  "topic:workflow-automation stars:>=1500",
  "topic:ai-workflow stars:>=200",

  /* ---------- 生成：图像 / 视频 / 语音 / 音乐 ---------- */
  "topic:text-to-image stars:>=1000",
  "topic:image-generation stars:>=800",
  "topic:stable-diffusion stars:>=1000",
  "topic:image-editing stars:>=300",
  "topic:inpainting stars:>=300",
  "topic:text-to-video stars:>=800",
  "topic:ai-video stars:>=300",
  "topic:digital-human stars:>=200",
  "topic:text-to-speech stars:>=800",
  "topic:tts stars:>=800",
  "topic:speech-to-text stars:>=800",
  "topic:asr stars:>=500",
  "topic:whisper stars:>=500",
  "topic:voice-cloning stars:>=300",
  "topic:music-generation stars:>=500",

  /* ---------- 推理服务 / 本地部署 ---------- */
  "topic:local-llm stars:>=500",
  "topic:ollama stars:>=1000",
  "topic:llm-serving stars:>=200",
  "topic:model-serving stars:>=300",
  "topic:quantization stars:>=300",
  "topic:inference-engine stars:>=300",
  "topic:mlops stars:>=1500",

  /* ---------- 检索 / 知识 ---------- */
  "topic:embedding stars:>=500",
  "topic:semantic-search stars:>=500",
  "topic:knowledge-graph stars:>=1000",
  "topic:document-ai stars:>=200",
  "topic:ocr stars:>=1500",
  "topic:ai-search stars:>=200",

  /* ---------- 垂直应用：写作 / 营销 / 数据 / 效率 / 客服 / 教育 ---------- */
  "topic:ai-tools stars:>=1000",
  "topic:chatgpt stars:>=2000",
  "topic:openai stars:>=2000",
  "topic:copywriting stars:>=200",
  "topic:writing stars:>=2000",
  "topic:seo stars:>=500",
  "topic:marketing-automation stars:>=200",
  "topic:productivity stars:>=2000",
  "topic:text-to-sql stars:>=500",
  "topic:data-analysis stars:>=1000",
  "topic:ai-analytics stars:>=200",
  "topic:ai-customer-service stars:>=200",
  "topic:ai-education stars:>=200",
  "topic:ai-translation stars:>=200",
  "topic:meeting-notes stars:>=200",

  /* ---------- 视觉 / 安全 ---------- */
  "topic:computer-vision stars:>=2000",
  "topic:vlm stars:>=300",
  "topic:object-detection stars:>=2000",
  "topic:ai-safety stars:>=200",
  "topic:guardrails stars:>=200",
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

/** 当前剩余的 core 配额（README / 贡献者等接口共用） */
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

/**
 * 搜索候选池：每条查询取 PER_PAGE 个 × SEARCH_PAGES 页。
 * 限速：带 token 30 次/分钟、匿名 10 次/分钟，这里按 2.3s 串行（≈26 次/分钟）稳妥推进。
 */
async function collectCandidates(): Promise<Map<string, SearchItem>> {
  /* 候选池缓存 6 小时：调原则时反复重跑不必再打上百次搜索接口 */
  const cacheFile = path.resolve(process.cwd(), "content/cache/github-candidates.json");
  const refresh = process.argv.includes("--refresh-cache");
  if (!refresh && fs.existsSync(cacheFile)) {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf-8")) as {
        fetchedAt?: string;
        items?: SearchItem[];
      };
      const age = Date.now() - Date.parse(c.fetchedAt ?? "");
      if (c.items?.length && age < 6 * 3600_000) {
        console.log(`[rebuild] 复用候选池缓存（${c.items.length} 个，${Math.round(age / 60000)} 分钟前）`);
        return new Map(c.items.map((it) => [it.full_name.toLowerCase(), it]));
      }
    } catch {
      /* 缓存损坏则重新拉取 */
    }
  }

  const found = new Map<string, SearchItem>();
  for (const [i, q] of QUERIES.entries()) {
    let addedTotal = 0;
    for (let page = 1; page <= SEARCH_PAGES; page++) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${PER_PAGE}&page=${page}`;
      try {
        const res = await fetch(url, { headers: headers() });
        if (!res.ok) {
          console.warn(`[rebuild] 搜索失败 ${res.status}：${q}（第 ${page} 页）`);
          break;
        }
        const data = (await res.json()) as { items?: SearchItem[] };
        if (!data.items?.length) break;
        for (const it of data.items) {
          const key = it.full_name.toLowerCase();
          if (found.has(key)) continue;
          found.set(key, it);
          addedTotal++;
        }
        if (data.items.length < PER_PAGE) break;
      } catch (e) {
        console.warn(`[rebuild] 搜索异常 ${q}：`, e instanceof Error ? e.message : e);
        break;
      }
      await sleep(2300);
    }
    console.log(`[rebuild] (${i + 1}/${QUERIES.length}) ${q} → 新增候选 ${addedTotal}，累计 ${found.size}`);
    }

  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(
      cacheFile,
      JSON.stringify({ fetchedAt: new Date().toISOString(), items: [...found.values()] }, null, 2) + "\n",
      "utf-8",
    );
    console.log(`[rebuild] 候选池已缓存 → ${cacheFile}`);
  } catch (e) {
    console.warn("[rebuild] 候选池缓存失败：", e instanceof Error ? e.message : e);
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

/** README（供中文情报生成用；走 API，受 core 配额约束） */
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

/** 贡献者数（需要 token，否则 50 个项目会吃掉全部匿名配额） */
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

/** 近 52 周每周提交数（需要 token） */
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
  const startedAt = new Date();
  console.log(
    `[rebuild] 原则 ${RANKING_RULE_VERSION}：星标≥${RANKING_RULES.minStars} · 复刻≥${RANKING_RULES.minForks} · ` +
      `最后提交≤${RANKING_RULES.maxDaysSincePush}天 · 必须有许可证 · 目标 ${
        LIMIT > 0 ? `${LIMIT} 个` : "不限总量（合格即收录）"
      }` +
      `${TOKEN ? "（带 token）" : "（无 token，匿名限流）"}`,
  );

  /* 0. 读旧榜单（复用已抓过的 README，省配额）并备份，方便回滚 */
  const prev = new Map<string, GitHubRepo>();
  if (fs.existsSync(OUT)) {
    try {
      const old = JSON.parse(fs.readFileSync(OUT, "utf-8")) as { repos?: GitHubRepo[] };
      for (const r of old.repos ?? []) prev.set(r.fullName, r);
    } catch {
      /* 旧数据损坏则忽略 */
    }
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const backup = path.join(BACKUP_DIR, `github-${stamp}.json`);
    fs.copyFileSync(OUT, backup);
    console.log(`[rebuild] 已备份旧数据 → ${backup}（可复用 ${prev.size} 条记录）`);
  }

  /* 1. 候选池 */
  const candidates = await collectCandidates();

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
  console.log(`[rebuild] 候选 ${candidates.size} 个，通过原则 ${passed.length} 个`);
  console.log(
    "[rebuild] 淘汰原因：" +
      Object.entries(rejected)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  );
  if (LIMIT > 0 && passed.length < LIMIT) {
    console.warn(`[rebuild] 通过原则的只有 ${passed.length} 个，不足 ${LIMIT}，将按实际数量入库`);
  }

  /* 3. 挑选入榜项目（不限总量时 = 全部合格项目，按综合得分排序） */
  const sorted = passed
    .map((r) => ({ ...r, productScore: computeProductScore(r) }))
    .sort(compareByScore);

  /* --count：只看候选池规模，不写数据、不消耗 README/情报配额 */
  if (process.argv.includes("--count")) {
    const byCat: Record<string, number> = {};
    for (const r of sorted) byCat[primaryCategory(r)] = (byCat[primaryCategory(r)] ?? 0) + 1;
    console.log(
      `[rebuild] 通过原则的合格项目 ${sorted.length} 个，分布：` +
        Object.entries(byCat)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`)
          .join(" · "),
    );
    return;
  }

  const picked = pickTopRepos(sorted, LIMIT, QUOTA);
  console.log(
    `[rebuild] 入榜 ${picked.length} 个${LIMIT > 0 ? `（上限 ${LIMIT}${QUOTA ? "，方向配额" : "，按得分截断"}）` : "（不限总量）"}`,
  );

  /* 4. 补 README / 贡献者（受配额约束，失败不影响入库） */
  const budget = { left: await coreRemaining() };
  const needReadme = picked.length;
  console.log(`[rebuild] core 剩余 ${budget.left}，README 需要 ${needReadme}`);
  const deep = !!TOKEN && budget.left > needReadme * 2 + 5;

  for (const [i, r] of picked.entries()) {
    const old = prev.get(r.fullName);
    /* 已有中文情报直接复用，避免对同一项目重复调用大模型 */
    if (old?.insight) r.insight = old.insight;
    if (old?.readme) {
      r.readme = old.readme;
      r.readmeSummary = old.readmeSummary ?? readmeSummary(old.readme);
      r.contributorsCount = old.contributorsCount;
      r.commitActivity = old.commitActivity;
      r.languages = old.languages;
    } else {
      r.readme = await fetchReadme(r.fullName, budget);
      if (r.readme) r.readmeSummary = readmeSummary(r.readme);
      if (deep) {
        r.contributorsCount = await fetchContributors(r.fullName);
        r.commitActivity = await fetchCommitActivity(r.fullName);
      }
    }
    console.log(
      `[rebuild] (${i + 1}/${picked.length}) ${r.fullName} · README ${r.readme ? "✓" : "×"}` +
        `${deep ? ` · 贡献者 ${r.contributorsCount ?? "—"}` : ""}`,
    );
    await sleep(350);
  }

  /* 5. 历史回填 + 计分 + 排序 */
  const final = picked
    .map((r) => ({ ...r, history: backfillHistory(r), productScore: computeProductScore(r) }))
    .sort(compareByScore);

  fs.writeFileSync(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), ruleVersion: RANKING_RULE_VERSION, repos: final }, null, 2) +
      "\n",
    "utf-8",
  );

  const avg = final.reduce((s, r) => s + (r.productScore?.score ?? 0), 0) / (final.length || 1);
  const byCat: Record<string, number> = {};
  for (const r of final) byCat[r.categories[0] ?? "Other"] = (byCat[r.categories[0] ?? "Other"] ?? 0) + 1;
  console.log(
    `[rebuild] 完成：${final.length} 个仓库，平均综合得分 ${avg.toFixed(1)}，读完 README ${
      final.filter((r) => r.readme).length
    } 个`,
  );
  console.log(
    "[rebuild] 分类分布：" +
      Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(" · "),
  );
  console.log(`[rebuild] 下一步：pnpm tsx scripts/fetch/enrich-github-insight.ts --force 生成中文情报`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});