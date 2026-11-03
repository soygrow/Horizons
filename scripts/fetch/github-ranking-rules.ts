import type { GitHubInsight, GitHubRepo } from "@horizons/shared";

/**
 * 【GitHub 榜收录原则 · gh-rank-v1.6】
 * 唯一事实来源：脚本与文档（docs/10-GitHub榜单收录原则.md）以本文件为准。
 * 任何一次重新拉取都必须走这里的判定，保证「同一原则、同一结果」。
 *
 * 一句话原则：
 *   一个项目能进榜，必须同时满足「AI 相关且可被二次开发」「真实活跃」「允许商业化」
 *   三个条件，并且**能为读者产出一个可落地的产品点子**；总量不设上限，合格即收录。
 *   排序按 pps-v3：**轻启动 25 > 商业化 22 > 落地门槛 15 > 需求验证 14 > 可开发性 8 > 活跃度 8 > 增长 8**，
 *   即「一个人、很少的钱就能做出小而美产品」的项目排在前面，重型基础设施项目靠后。
 *
 *   硬门槛本身未变（星标/复刻/活跃/AI 信号/许可证），v1.6 只改排序与计分口径。
 */
export const RANKING_RULE_VERSION = "gh-rank-v1.6";

/**
 * 方向配额：仅在「显式限定总量」（LIMIT > 0）时作为单方向上限生效，
 * 用于临时试点或对比测试；默认不限总量时不参与筛选。
 */
export const CATEGORY_CAP: Record<string, number> = {
  Agent: 12,
  Coding: 7,
  "AI Chat": 5,
  RAG: 5,
  Inference: 5,
  "Image Gen": 5,
  Video: 4,
  "Voice & Audio": 4,
  Automation: 4,
  Writing: 3,
  Productivity: 3,
  "Data & Analytics": 2,
  Marketing: 2,
  Other: 2,
};

export const RANKING_RULES = {
  version: RANKING_RULE_VERSION,

  /* ---------- 硬门槛（缺一不可） ---------- */
  /** 星标下限：低于此数说明还没被验证过，做出来也没人接盘 */
  minStars: 800,
  /** 复刻下限：有人真的拿去用了，而不只是收藏 */
  minForks: 40,
  /** 最后提交距今天数上限：超过就是「停更项目」，不适合当产品底座 */
  maxDaysSincePush: 120,
  /** 仓库年龄下限（天）：太新的项目接口/定位不稳，等它跑半年 */
  minRepoAgeDays: 150,
  /** 官方简介最少字数：没有一句说清自己是什么，无法判断用途 */
  minDescriptionChars: 20,
  /** 必须声明开源许可证（无许可证 = 法律上不可商用） */
  requireLicense: true,
  /** 以下许可证视为「未有效声明」 */
  deniedLicenses: ["NOASSERTION", "OTHER"],

  /* ---------- 排除项（命中即淘汰） ---------- */
  /** 清单 / 教程 / 论文合集 / 目录索引 / 转行路线图：没有可复用代码 */
  excludeHints:
    /\b(awesome|tutorial|tutorials|course|courses|book|books|cheatsheet|cheat-sheet|interview|papers?|survey|roadmap|handbook|guide|examples?|dotfiles|configs?|boilerplate|starter|portfolio|prompt-collection|notes?|principles?|playground|learn|directory|registry|catalog|collection|list of|index of)\b|from scratch|(笔记|教程|学习|入门|课程|已完结|从零|面试|原理|目录)/i,
  /** 数据集 / 纯模型权重 / 论文实现集合：不是产品底座 */
  excludeTopics: ["dataset", "datasets", "model-weights", "paper", "papers", "awesome", "tutorial", "course", "curated-list"],

  /* ---------- 规模 ---------- */
  /** 入榜总量上限：0 = 不限（合格即收录，榜单可持续扩张到上千条） */
  totalLimit: 0,
};

/** 候选池里需要的字段（GitHub search 接口即可返回，省限流） */
export interface RankItem {
  full_name: string;
  name: string;
  description?: string | null;
  topics?: string[];
  language?: string | null;
  license?: { spdx_id?: string | null; name?: string | null } | null;
  stargazers_count?: number;
  forks_count?: number;
  created_at?: string;
  pushed_at?: string;
  archived?: boolean;
  fork?: boolean;
}

/**
 * AI 强信号（高置信，描述里出现即视为「AI 是主业」）。
 * 注意不要放 `multimodal`、`agent` 这类宽泛词——否则 vortex、rerun 这种
 * 「multimodal 数据」项目会被误判成 AI 项目。
 */
const AI_CORE =
  /\b(llm|llms|large language model|ai agent|ai agents|agentic|multi-agent|rag|retrieval-augmented|text-to-image|text-to-video|text-to-speech|speech-to-text|asr|tts|diffusion|fine-tuning|finetun|embeddings?|chatbot|chat completion|completion api|model serving|llm inference|vision-language|vlm|stable-diffusion|comfyui|langchain|llamaindex|openai|anthropic|claude|gemini|ollama|vllm|whisper|prompt engineering|prompt optimization|generative ai|genai)\b/i;

/** 宽泛 AI 词：单独出现不够（netdata 也说自己 "AI-powered"），必须配合 topics 里的强信号 */
const AI_BROAD = /\b(ai|artificial intelligence|machine learning|deep learning|neural|nlp|ml|agents?|computer vision|generative)\b/i;

const daysSince = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
};

export interface RankCheck {
  ok: boolean;
  /** 未通过时的原因（写进日志，便于解释「为什么它没进榜」） */
  reason?: string;
}

/** 按收录原则判定一个候选项目能否进入榜单 */
export function checkRankable(it: RankItem): RankCheck {
  const r = RANKING_RULES;
  const stars = it.stargazers_count ?? 0;
  const desc = (it.description ?? "").trim();
  const topics = (it.topics ?? []).map((t) => t.toLowerCase());

  /* 0. 基础资格 */
  if (it.archived) return { ok: false, reason: "已归档" };
  if (it.fork) return { ok: false, reason: "Fork 仓库" };

  /* 1. 与 AI / 大模型能力相关：描述本身命中强信号，或「topics 强信号 + 描述宽泛 AI 词」，
      杜绝 gitleaks 这类在 topics 里堆砌 llm 标签但没有 AI 主业的情况 */
  const coreInDesc = AI_CORE.test(desc);
  const coreInTopics = AI_CORE.test(topics.join(" "));
  const broadInDesc = AI_BROAD.test(`${desc} ${it.name}`);
  if (!coreInDesc && !(coreInTopics && broadInDesc)) return { ok: false, reason: "AI 信号弱" };

  /* 2. 可被二次开发（不是清单、教程、数据集） */
  if (r.excludeHints.test(`${it.name} ${desc}`)) return { ok: false, reason: "清单/教程型" };
  const dupTopic = topics.find((t) => r.excludeTopics.includes(t));
  if (dupTopic) return { ok: false, reason: `数据集/文献型（${dupTopic}）` };
  if (desc.length < r.minDescriptionChars) return { ok: false, reason: "缺少可用简介" };

  /* 3. 已被验证 */
  if (stars < r.minStars) return { ok: false, reason: `星标不足 ${r.minStars}` };
  if ((it.forks_count ?? 0) < r.minForks) return { ok: false, reason: `复刻不足 ${r.minForks}` };

  /* 4. 仍在维护 */
  const pushed = daysSince(it.pushed_at);
  if (pushed === null) return { ok: false, reason: "无提交时间" };
  if (pushed > r.maxDaysSincePush) return { ok: false, reason: `停更 ${pushed} 天` };

  /* 5. 不是刚上线的新项目 */
  const age = daysSince(it.created_at);
  if (age !== null && age < r.minRepoAgeDays) return { ok: false, reason: `上线仅 ${age} 天` };

  /* 6. 允许商业化 */
  const spdx = it.license?.spdx_id ?? "";
  if (r.requireLicense && !spdx) return { ok: false, reason: "未声明许可证" };
  if (r.deniedLicenses.includes(spdx)) return { ok: false, reason: `许可证无效（${spdx}）` };

  return { ok: true };
}

/** 主分类：榜单行里「用途」列展示的第一个类别 */
export function primaryCategory(repo: GitHubRepo): string {
  return repo.categories[0] ?? "Other";
}

/**
 * v1.4 新增：读者价值门槛（情报层的「第四条硬门槛」）。
 *
 * 榜单服务的是「想做点事的人」——创业者、AI 工具重度使用者、互联网/科技从业者。
 * 他们读完一条，必须能回答三个问题：
 *   ① 能做成什么产品（buildIdeas 里有明确产品形态）
 *   ② 卖给谁、怎么收钱（audience + monetization 不能是空话）
 *   ③ 值不值得动手（buildSteps 至少给出可执行的起手三步 + 一句护城河判断）
 * 三个问题答不上来的情报，即使项目本身合格，也不该算「合格条目」——
 * 因为它对这个榜单的读者没有任何增值。
 */
export const IDEA_RULES = {
  /** 至少 3 个可落地点子（含目标用户 + 收费方式） */
  minBuildIdeas: 3,
  /** 至少 3 步落地动作 */
  minBuildSteps: 3,
  /** 必须有护城河判断，否则等于「谁都能做」，没有价值 */
  requireMoat: true,
} as const;

export interface IdeaCheck {
  ok: boolean;
  reason?: string;
}

/** 判定一条情报是否真的能给读者「一个新想法」 */
export function checkIdeaValue(insight?: GitHubInsight | null): IdeaCheck {
  if (!insight) return { ok: false, reason: "无情报" };

  const ideas = (insight.buildIdeas ?? []).filter(
    (i) => i.title?.trim() && i.product?.trim() && i.audience?.trim() && i.monetization?.trim(),
  );
  if (ideas.length < IDEA_RULES.minBuildIdeas) {
    return { ok: false, reason: `可落地点子不足（${ideas.length}/${IDEA_RULES.minBuildIdeas}）` };
  }

  if ((insight.buildSteps ?? []).length < IDEA_RULES.minBuildSteps) {
    return { ok: false, reason: `落地步骤不足（${(insight.buildSteps ?? []).length}）` };
  }

  if (IDEA_RULES.requireMoat && !insight.moat?.trim()) {
    return { ok: false, reason: "缺少护城河判断" };
  }

  return { ok: true };
}

/**
 * 挑选最终入榜项目：
 * - limit <= 0（默认）：不限总量，通过硬门槛的项目全部入榜，直接按综合得分排序；
 * - limit > 0 且 useQuota=false：按综合得分截断前 limit 个（"扩到 N 个"的常规做法）；
 * - limit > 0 且 useQuota=true：按方向配额两轮挑选（配额优先 + 分数补位），
 *   仅用于小规模试点，避免 Agent 一个方向吃掉全部名额。
 */
export function pickTopRepos(
  list: GitHubRepo[],
  limit = RANKING_RULES.totalLimit,
  useQuota = false,
): GitHubRepo[] {
  if (limit <= 0) return [...list];
  if (!useQuota) return list.slice(0, limit);

  const used: Record<string, number> = {};
  const picked: GitHubRepo[] = [];
  const overflow: GitHubRepo[] = [];

  for (const repo of list) {
    const cat = primaryCategory(repo);
    const cap = CATEGORY_CAP[cat] ?? 3;
    if ((used[cat] ?? 0) >= cap) {
      overflow.push(repo);
      continue;
    }
    used[cat] = (used[cat] ?? 0) + 1;
    picked.push(repo);
  }

  /* 配额内不足 50 个时，按分数补位（list 已按分数降序） */
  for (const repo of overflow) {
    if (picked.length >= limit) break;
    picked.push(repo);
  }

  return picked.slice(0, limit);
}