import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { GitHubRepo, GitHubSnapshot } from "@horizons/shared";
import "./config";
import { config } from "./config";
import { backfillHistory, heatFromStars, mapCategories, readmeSummary } from "./github-utils";

/**
 * GitHub 榜单采集：从 GitHub 官方 API 拉取开源 AI 项目的真实元数据（stars/forks/语言/license/topics/readme），
 * 并用本地启发式生成「能用来创业什么」等解读（后续接入 LLM 可替换为更精准版本）。
 *
 * 入库门槛（榜单收录要求）：
 *  1) 与 AI / 大模型 / 技术相关（topic 或描述命中 AI 关键词）
 *  2) 能被用于开发、有产品化可能（排除 awesome / 教程 / 书单 / 面试题等清单型仓库）
 *  3) 排除归档仓库与 Fork
 *  4) 不要求有官网：无官网只会少拿商业化的 6 分，不影响入库
 *
 * 日维度设计：
 *  - 每次运行刷新所有种子仓库的标量（stars/forks/...）并往 history 追加「当日真实快照」。
 *  - 首次（history < 30 点）做一次「首日回填」：以当日真实 stars 为终点，反推近 30 天估算序列，
 *    让 Star 趋势图立刻有形状；之后每日真实累积，回填不再触发。
 *  - REFRESH=owner/repo,owner/repo 指定需要「重度刷新」的仓库（额外拉 languages / contributors / commitActivity）。
 *  - --discover：用 GitHub 搜索接口按主题扩充候选池（未认证 10 次/分钟，脚本已限速）。
 *
 * 用法：
 *  pnpm tsx scripts/fetch/enrich-github.ts
 *  pnpm tsx scripts/fetch/enrich-github.ts --discover          # 扩充到 MAX_REPOS（默认 150）
 *  MAX_REPOS=200 HEAVY_TOP=10 pnpm tsx scripts/fetch/enrich-github.ts --discover
 *  REFRESH=n8n-io/n8n pnpm tsx scripts/fetch/enrich-github.ts
 */

const OUT = path.resolve(process.cwd(), "content/github.json");
const TOKEN = process.env.GITHUB_TOKEN;

// 种子：知名 AI 开源项目，覆盖多类别
const SEEDS = [
  "ollama/ollama",
  "langchain-ai/langchain",
  "vllm-project/vllm",
  "run-llama/llama_index",
  "huggingface/transformers",
  "Comfy-Org/ComfyUI",
  "Significant-Gravitas/AutoGPT",
  "microsoft/autogen",
  "langgenius/dify",
  "openinterpreter/openinterpreter",
  "e2b-dev/E2B",
  "janhq/jan",
  "mudler/LocalAI",
  "Sanster/IOPaint",
  "myshell-ai/OpenVoice",
  "RVC-Project/Retrieval-based-Voice-Conversion-WebUI",
  "exo-explore/exo",
  "BerriAI/litellm",
  "FlowiseAI/Flowise",
  "khoj-ai/khoj",
  "browser-use/browser-use",
  "n8n-io/n8n",
  "harry0703/MoneyPrinterTurbo",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": config.userAgent,
    Accept: "application/vnd.github+json",
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  return headers;
}

/* ------------------------------- 发现扩充 ------------------------------- */

/** 搜索词：按 AI 主题 + 星标门槛，尽量覆盖「能做成产品」的方向 */
const DISCOVER_QUERIES = [
  "topic:llm stars:>=2000",
  "topic:ai-agents stars:>=800",
  "topic:rag stars:>=800",
  "topic:text-to-image stars:>=1000",
  "topic:text-to-speech stars:>=500",
  "topic:speech-to-text stars:>=500",
  "topic:ai-coding stars:>=800",
  "topic:llm-inference stars:>=1000",
  "topic:vector-database stars:>=800",
  "topic:workflow-automation stars:>=1000",
  "topic:generative-ai stars:>=2000",
  "topic:model-context-protocol stars:>=500",
  "topic:ai-assistant stars:>=1000",
  "topic:multimodal stars:>=800",
];

/** 清单 / 教程 / 书单 / 学习笔记型仓库：不能被开发成产品，直接排除 */
const EXCLUDE_HINT =
  /\b(awesome|tutorial|tutorials|course|courses|book|books|cheatsheet|cheat-sheet|interview|papers?|survey|roadmap|handbook|guide|examples?|dotfiles|configs?|boilerplate|starter|portfolio|prompt-collection|notes?|principles?|playground|learn)\b|from scratch|(笔记|教程|学习|入门|课程|已完结|从零|面试|原理)/i;

/** AI / 大模型相关信号 */
const AI_HINT =
  /\b(ai|llm|llms|agent|agents|rag|gpt|chatbot|diffusion|model|models|inference|embedding|embeddings|vector|speech|tts|asr|vision|transformer|transformers|mcp|prompt|prompts|generative|multimodal|text-to-image|text-to-video|text-to-speech|machine-learning|deep-learning|fine-tuning|finetune|openai|anthropic|claude|gemini|ollama|stable-diffusion|comfyui|langchain)\b/i;

interface SearchRepo {
  full_name: string;
  name: string;
  owner?: { login?: string; avatar_url?: string };
  description?: string | null;
  html_url: string;
  homepage?: string | null;
  language?: string | null;
  topics?: string[];
  license?: { spdx_id?: string | null; name?: string | null } | null;
  created_at?: string;
  pushed_at?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  watchers_count?: number;
  archived?: boolean;
  fork?: boolean;
}

/** 榜单收录门槛：AI 相关 + 可开发 + 非清单 + 非归档/Fork */
function isEligible(it: SearchRepo): boolean {
  if (it.archived || it.fork) return false;
  if ((it.stargazers_count ?? 0) < 500) return false;
  if (!it.description || it.description.trim().length < 12) return false;
  if (EXCLUDE_HINT.test(`${it.name} ${it.description}`)) return false;
  const topics = (it.topics ?? []).join(" ");
  return AI_HINT.test(`${topics} ${it.description}`);
}

/** 搜索结果 → 榜单条目（README / 语言占比 / 贡献者等可稍后补全） */
function fromSearchItem(d: SearchRepo): GitHubRepo {
  const fullName = d.full_name;
  const [owner, repo] = fullName.split("/");
  const topics = d.topics ?? [];
  const stars = d.stargazers_count ?? 0;
  return {
    fullName,
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

/** 逐词搜索候选池；搜索接口未认证 10 次/分钟，按 6.8s 间隔限速 */
async function discover(max: number, have: Set<string>): Promise<GitHubRepo[]> {
  const out: GitHubRepo[] = [];
  const seen = new Set<string>();
  for (const q of DISCOVER_QUERIES) {
    if (out.length >= max) break;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`;
    try {
      const res = await fetch(url, { headers: buildHeaders() });
      if (!res.ok) {
        console.warn(`[github] 发现失败（${res.status}）${q}`);
        await sleep(7000);
        continue;
      }
      const data = (await res.json()) as { items?: SearchRepo[] };
      for (const it of data.items ?? []) {
        if (out.length >= max) break;
        const full = it.full_name;
        if (!full) continue;
        const key = full.toLowerCase();
        if (have.has(full) || seen.has(key)) continue;
        if (!isEligible(it)) continue;
        seen.add(key);
        out.push(fromSearchItem(it));
      }
    } catch (e) {
      console.warn(`[github] 发现异常 ${q}:`, e instanceof Error ? e.message : e);
    }
    await sleep(6800);
  }
  return out;
}



/** 本地启发式解读（无 LLM 时兜底；后续可被 LLM 覆盖） */
function localInsight(r: {
  categories: string[];
  description?: string;
  language?: string;
  license?: { name?: string };
}): Pick<
  GitHubRepo,
  "what" | "useCases" | "risks" | "focusOpportunity" | "buildBlueprint" | "ideaSparks"
> {
  const cats = r.categories;
  const desc = r.description ?? "";
  const useCases: { title: string; how: string }[] = [
    {
      title: "垂直场景托管版 SaaS",
      how: "把该项目封装成开箱即用的云服务，面向不会自建的非技术用户按订阅收费。",
    },
  ];
  const push = (cond: boolean, title: string, how: string) => {
    if (cond) useCases.push({ title, how });
  };
  push(cats.includes("Image Gen"), "AI 写真 / 电商图定制", "基于项目能力做头像、商品图、营销图的垂直生成服务。");
  push(cats.includes("Voice & Audio"), "配音 / 语音克隆服务", "做有声书、短视频配音、角色语音克隆的轻量付费服务。");
  push(cats.includes("Agent") || cats.includes("Automation"), "行业自动化 Agent", "用项目搭特定行业的自动化工作流，按任务量或坐席计费。");
  push(cats.includes("Coding"), "私有化代码助手", "面向企业做合规、私有化部署的代码 / 开发提效服务。");
  push(cats.includes("RAG") || cats.includes("AI Chat"), "企业知识库问答", "基于项目做企业文档 / 客服知识库 RAG 系统。");
  push(cats.includes("Inference"), "推理 API / 一体机", "把模型推理能力打包成 API 或本地一体机卖给中小团队。");

  const risks = `采用 ${r.license?.name ?? "开源"} 协议，需先确认商业化约束；上游社区活跃度与维护方变动是主要风险，建议做差异化而非直接复制。`;
  const focusOpportunity = `聚焦「${cats[0] ?? "AI"} + 某一垂直人群 / 小语种市场」的轻量 SaaS，用项目做技术底座，靠场景与运营建立壁垒。`;
  const buildBlueprint = {
    techStack: r.language ? [r.language] : [],
    thirdParty: ["开源模型 / API"],
    mvpScope: "基于项目封装一层行业 UI + 鉴权 + 计费",
    devTime: "2-4 周",
    monthlyCost: "取决于推理 / 算力消耗",
  };
  const ideaSparks = [
    { title: `${cats[0] ?? "AI"} + 出海小语种`, angle: "换语区", why: "海外垂直市场竞品少、付费意愿强。" },
    { title: `${cats[0] ?? "AI"} + 某行业工作流`, angle: "换场景", why: "把通用能力嵌入具体行业的既有流程。" },
  ];
  return {
    what: desc ? `开源项目：${desc.slice(0, 90)}` : undefined,
    useCases: useCases.slice(0, 4),
    risks,
    focusOpportunity,
    buildBlueprint,
    ideaSparks,
  };
}

/* ------------------------------- 日历史回填 ------------------------------- */

/* ------------------------------- 采集函数 ------------------------------- */

async function fetchStats(
  owner: string,
  repo: string,
  headers: Record<string, string>,
): Promise<{ languages?: Record<string, number>; contributorsCount?: number; commitActivity?: number[] }> {
  const out: { languages?: Record<string, number>; contributorsCount?: number; commitActivity?: number[] } = {};

  // 语言占比
  try {
    const lr = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, { headers });
    if (lr.ok) {
      const j = (await lr.json()) as Record<string, number>;
      const total = Object.values(j).reduce((a, b) => a + b, 0) || 1;
      const rec: Record<string, number> = {};
      for (const [k, v] of Object.entries(j)) rec[k] = Math.round((v / total) * 100);
      out.languages = rec;
    }
  } catch {
    /* ignore */
  }

  // 贡献者总数（从 Link 头解析 last page）
  try {
    let cr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=false`, {
      headers,
    });
    let tries = 0;
    while (cr.status === 202 && tries < 5) {
      await sleep(2000);
      cr = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=1&anon=false`, {
        headers,
      });
      tries++;
    }
    if (cr.ok) {
      const link = cr.headers.get("link") ?? "";
      const m = link.match(/page=(\d+)>;\s*rel="last"/);
      if (m) out.contributorsCount = parseInt(m[1], 10);
    }
  } catch {
    /* ignore */
  }

  // 近 52 周提交活跃
  try {
    let ca = await fetch(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`, { headers });
    let tries = 0;
    while (ca.status === 202 && tries < 5) {
      await sleep(2000);
      ca = await fetch(`https://api.github.com/repos/${owner}/${repo}/stats/commit_activity`, { headers });
      tries++;
    }
    if (ca.ok) {
      const j = (await ca.json()) as { total: number }[];
      out.commitActivity = j.map((w) => w.total);
    }
  } catch {
    /* ignore */
  }

  return out;
}

async function fetchReadme(owner: string, repo: string, headers: Record<string, string>): Promise<string> {
  try {
    const rr = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
      headers: { ...headers, Accept: "application/vnd.github.raw+json" },
    });
    if (rr.ok) return await rr.text();
  } catch {
    /* ignore */
  }
  return "";
}

/** 完整拉取（含 readme；heavy 时额外拉取 languages/contributors/commitActivity） */
async function fetchRepo(full: string, heavy = false): Promise<GitHubRepo | null> {
  const [owner, repo] = full.split("/");
  const headers = buildHeaders();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!res.ok) {
    console.warn(`[github] 跳过 ${full}：${res.status}`);
    return null;
  }
  const d = (await res.json()) as Record<string, any>;

  const readme = heavy ? await fetchReadme(owner, repo, headers) : "";
  const stats = heavy ? await fetchStats(owner, repo, headers) : {};
  const topics: string[] = d.topics ?? [];
  const cats = mapCategories(topics);
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const snapshot: GitHubSnapshot = {
    date: today,
    stars: d.stargazers_count ?? 0,
    forks: d.forks_count ?? 0,
    openIssues: d.open_issues_count ?? 0,
  };

  return {
    fullName: d.full_name ?? full,
    owner: d.owner?.login ?? owner,
    repo: d.name ?? repo,
    name: d.name ?? repo,
    description: d.description ?? undefined,
    htmlUrl: d.html_url,
    homepage: d.homepage || undefined,
    avatarUrl: d.owner?.avatar_url,
    language: d.language ?? undefined,
    languages: stats.languages,
    topics,
    license: d.license ? { spdx: d.license.spdx_id ?? undefined, name: d.license.name ?? undefined } : undefined,
    createdAt: d.created_at,
    pushedAt: d.pushed_at,
    stars: d.stargazers_count ?? 0,
    forks: d.forks_count ?? 0,
    openIssues: d.open_issues_count ?? 0,
    watchers: d.subscribers_count ?? 0,
    contributorsCount: stats.contributorsCount,
    commitActivity: stats.commitActivity,
    readme,
    readmeSummary: readme ? readmeSummary(readme) : undefined,
    categories: cats,
    heatScore: heatFromStars(d.stargazers_count ?? 0),
    history: [snapshot],
    lastCrawledAt: now,
    ...localInsight({
      categories: cats,
      description: d.description,
      language: d.language,
      license: { name: d.license?.name },
    }),
  };
}

/** 轻量刷新：仅拉 /repos 更新标量并追加当日真实快照（不覆盖解读/重指标/history） */
async function refreshScalars(
  full: string,
  prev: GitHubRepo,
): Promise<GitHubRepo> {
  const [owner, repo] = full.split("/");
  const headers = buildHeaders();
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!res.ok) {
    console.warn(`[github] 刷新标量失败 ${full}：${res.status}，保留旧值`);
    return prev;
  }
  const d = (await res.json()) as Record<string, any>;
  const today = new Date().toISOString().slice(0, 10);
  const snapshot: GitHubSnapshot = {
    date: today,
    stars: d.stargazers_count ?? prev.stars,
    forks: d.forks_count ?? prev.forks,
    openIssues: d.open_issues_count ?? prev.openIssues,
  };
  const history = [...(prev.history ?? [])];
  const idx = history.findIndex((h) => h.date === today);
  if (idx >= 0) history[idx] = snapshot;
  else history.push(snapshot);

  const topics: string[] = d.topics ?? prev.topics ?? [];
  return {
    ...prev,
    description: d.description ?? prev.description,
    htmlUrl: d.html_url,
    homepage: d.homepage || prev.homepage,
    avatarUrl: d.owner?.avatar_url ?? prev.avatarUrl,
    language: d.language ?? prev.language,
    topics,
    license: d.license
      ? { spdx: d.license.spdx_id ?? undefined, name: d.license.name ?? undefined }
      : prev.license,
    createdAt: d.created_at ?? prev.createdAt,
    pushedAt: d.pushed_at ?? prev.pushedAt,
    stars: d.stargazers_count ?? prev.stars,
    forks: d.forks_count ?? prev.forks,
    openIssues: d.open_issues_count ?? prev.openIssues,
    watchers: d.subscribers_count ?? prev.watchers,
    heatScore: heatFromStars(d.stargazers_count ?? prev.stars),
    categories: mapCategories(topics),
    history,
    lastCrawledAt: new Date().toISOString(),
  };
}

async function main() {
  const refreshList = (process.env.REFRESH ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const refreshSet = new Set(refreshList);

  let existing: GitHubRepo[] = [];
  try {
    existing = (JSON.parse(fs.readFileSync(OUT, "utf-8")) as { repos?: GitHubRepo[] }).repos ?? [];
  } catch {
    existing = [];
  }
  const have = new Set(existing.map((r) => r.fullName));
  const byName = new Map(existing.map((r) => [r.fullName, r]));

  // 1) REFRESH：重度全量重建（覆盖）
  const refreshed: GitHubRepo[] = [];
  for (const full of refreshList) {
    const r = await fetchRepo(full, true);
    if (r) refreshed.push(r);
    await sleep(1500);
  }

  // 2) 其余种子：轻量刷新标量 + 追加真实快照；缺失的首次完整拉取
  const fresh: GitHubRepo[] = [];
  for (const s of SEEDS) {
    if (refreshSet.has(s)) continue;
    const prev = byName.get(s);
    if (prev) {
      const updated = await refreshScalars(s, prev);
      byName.set(s, updated);
    } else {
      const r = await fetchRepo(s, false);
      if (r) fresh.push(r);
    }
    await sleep(1200);
  }

  // 3) 发现扩充：按 AI 主题搜索候选并入库
  const doDiscover = process.argv.includes("--discover") || process.env.DISCOVER === "1";
  const maxRepos = parseInt(process.env.MAX_REPOS ?? "150", 10) || 150;
  const heavyTop = parseInt(process.env.HEAVY_TOP ?? "5", 10) || 0;
  const discovered: GitHubRepo[] = [];
  if (doDiscover) {
    const remain = Math.max(0, maxRepos - (byName.size + fresh.length));
    if (remain > 0) {
      console.log(`[github] 开始发现：剩余名额 ${remain}`);
      const found = await discover(remain, new Set([...have, ...fresh.map((r) => r.fullName)]));
      discovered.push(...found);
      console.log(`[github] 新增候选 ${found.length} 个`);
      // 星标最高的前 N 个补全 README / 语言 / 贡献者 / 提交，避免详情页缺数据
      const top = [...discovered].sort((a, b) => b.stars - a.stars).slice(0, heavyTop);
      for (const d of top) {
        const full = await fetchRepo(d.fullName, true);
        if (full) {
          Object.assign(d, full, { history: [] });
          console.log(`[github] ↳ 补全 ${d.fullName}`);
        }
        await sleep(1500);
      }
    } else {
      console.log(`[github] 已达上限 ${maxRepos}，跳过发现`);
    }
  }

  // 4) 合并（按 fullName 去重，refreshed/fresh/discovered 优先于已有，避免 seed 大小写导致重复）
  const finalMap = new Map<string, GitHubRepo>();
  for (const r of byName.values()) finalMap.set(r.fullName, r);
  for (const r of fresh) finalMap.set(r.fullName, r);
  for (const r of discovered) finalMap.set(r.fullName, r);
  for (const r of refreshed) finalMap.set(r.fullName, r);
  let merged = [...finalMap.values()];

  // 5) 首日回填（history < 30 才补，已累积真实点的不覆盖）
  merged = merged.map((r) => ({ ...r, history: backfillHistory(r) }));

  // 6) 综合得分 + 按得分排序（insight 生成后会再算一次，以纳入「上手难度」）
  merged = merged.map((r) => ({ ...r, productScore: computeProductScore(r) }));
  merged.sort(compareByScore);

  fs.writeFileSync(
    OUT,
    JSON.stringify({ updatedAt: new Date().toISOString(), repos: merged }, null, 2) + "\n",
    "utf-8",
  );

  const minHist = Math.min(...merged.map((r) => r.history.length));
  const maxHist = Math.max(...merged.map((r) => r.history.length));
  const avgScore =
    merged.reduce((s, r) => s + (r.productScore?.score ?? 0), 0) / (merged.length || 1);
  console.log(
    `[github] 完成，总计 ${merged.length} 个仓库；平均综合得分 ${avgScore.toFixed(1)}；history ${minHist}~${maxHist}（${
      TOKEN ? "已带 token" : "无 token，60/h"
    }）`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
