import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { BuildPhase, BuildStep, GitHubInsight, GitHubRepo } from "@horizons/shared";
import "./config"; // 副作用导入：加载 .env.local
import { chatJSON, hasLLM } from "./sources/llm";
import { CURATED_INSIGHTS } from "./curated-github-insights";

/**
 * GitHub 榜单「中文创业情报」生成：
 * 基于 GitHub 真实数据（简介/标签/语言/星标/README），让 DeepSeek 产出
 * 「这个项目能被用来做出什么产品、怎么做、能有什么效果」的中文结构化情报，
 * 面向想低成本做一个能赚钱产品的个人 / 小团队。
 *
 * 用法：
 *  pnpm tsx scripts/fetch/enrich-github-insight.ts            # 生成所有缺失的
 *  pnpm tsx scripts/fetch/enrich-github-insight.ts --all      # 同上
 *  pnpm tsx scripts/fetch/enrich-github-insight.ts --only harry0703/MoneyPrinterTurbo
 *  pnpm tsx scripts/fetch/enrich-github-insight.ts --force    # 覆盖已有
 */

const JSON_PATH = path.resolve(process.cwd(), "content/github.json");

const SYSTEM = `你是「独立开发者 / 小团队创业」的产品顾问。读者是想做一个能赚钱的产品、但不知道做什么的个人或 3 人以内小团队。
根据给定开源项目的信息，输出中文 JSON（不要英文、不要复述原文），帮助读者判断「我能用它做出什么产品、怎么做、能有什么效果」。

要求：
1) 要具体、可执行、有数字（成本/周期/定价），拒绝「赋能、闭环、生态」这类空话。
2) 不是把项目本身包装成 SaaS，而是把它的能力迁移到新的场景、人群或商业模式。
3) 诚实评估难度与风险，不夸大。
4) 「怎么做」必须绑定这个项目独有的能力、集成方式或数据类型，禁止套用「跑通→选场景→封装→沉淀→先卖」这类通用模板；步骤数可在 3-6 之间变化。

严格输出如下 JSON 结构（所有字段必填，competitors/differentiators 可省略）：
{
  "taglineZh": "不超过 18 字的一句话定位，说清它能帮读者做出什么",
  "whatZh": "80-130 字：它是什么、核心能力、技术特征（中文，替代英文原描述）",
  "capabilities": ["能力1", "能力2", "能力3", "能力4"],
  "buildIdeas": [
    {
      "title": "产品方向名（不超过 12 字）",
      "audience": "目标用户（具体人群/行业）",
      "product": "具体做成什么产品，一句话",
      "monetization": "怎么赚钱（定价/收费方式，给数字）",
      "effort": "工作量（如 1 人 / 2 周）",
      "stackHint": "技术要点（可选，一句话）"
    }
  ],
  "buildSteps": [
    { "step": "步骤标题（不超过 14 字）", "detail": "具体动作", "phase": "验证|起步|变现|增长", "output": "该步产出物", "duration": "预计耗时，如 2-3 天" }
  ],
  "effects": [
    { "metric": "效果指标（如 单条视频耗时）", "value": "预期值（如 5 分钟）" }
  ],
  "moat": "护城河 / 差异化一句话",
  "risks": ["风险1（真实、具体）", "风险2", "风险3"],
  "techNotes": "技术要点或集成方式一句话",
  "difficulty": "低|中|高",
  "timeToMvp": "做出 MVP 的周期（如 1-2 周）",
  "costToMvp": "MVP 阶段月成本（如 ¥0-200/月）",
  "competitors": ["竞品或参考产品1", "竞品2"],
  "differentiators": ["差异化切入点1", "差异化切入点2"]
}
buildIdeas 给 3-4 个，buildSteps 给 3-6 步且 phase 按「验证→起步→变现→增长」推进，effects 给 3-5 个，risks 给 3 个。`;

function cleanReadme(readme: string): string {
  return readme
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*`_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3500);
}

function buildPayload(r: GitHubRepo): string {
  const brief = {
    fullName: r.fullName,
    description: r.description ?? "",
    topics: r.topics ?? [],
    language: r.language ?? "",
    license: r.license?.spdx ?? "",
    stars: r.stars,
    forks: r.forks,
    homepage: r.homepage ?? "",
    readmeExcerpt: cleanReadme(r.readme ?? ""),
  };
  return JSON.stringify(brief);
}

function strArray(v: unknown, max = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim()).slice(0, max);
}

/**
 * 缩写 → 中文。一律带 \b 词边界，避免把产品名改坏
 * （此前 `LLM` 无边界，把 OpenLLM 洗成了「Open大模型」）。
 */
const ZH_FIX: [RegExp, string][] = [
  [/\bSaaS\b/g, "订阅服务"],
  [/\bMVP\b/g, "首版"],
  [/\bWebUI\b/g, "网页界面"],
  [/\bLLM\b/g, "大模型"],
  [/\bTTS\b/g, "语音合成"],
  [/\bAPI\b/g, "接口"],
  [/\bBGM\b/g, "背景音乐"],
  [/\bDemo\b/gi, "演示"],
];

function zhText(s: string): string {
  return ZH_FIX.reduce((acc, [re, to]) => acc.replace(re, to), s);
}

/** 递归把情报里残留的英文缩写替换为中文 */
function zhWalk(o: unknown): unknown {
  if (typeof o === "string") return zhText(o);
  if (Array.isArray(o)) return o.map(zhWalk);
  if (o && typeof o === "object") {
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, zhWalk(v)]));
  }
  return o;
}

const PHASES: BuildPhase[] = ["验证", "起步", "变现", "增长"];

function phaseOf(v: unknown): BuildPhase | undefined {
  return PHASES.includes(v as BuildPhase) ? (v as BuildPhase) : undefined;
}

function normalize(out: Partial<GitHubInsight>, repoName: string): GitHubInsight {
  const difficulty =
    out.difficulty === "低" || out.difficulty === "中" || out.difficulty === "高" ? out.difficulty : "中";
  const buildIdeas = Array.isArray(out.buildIdeas)
    ? out.buildIdeas
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          title: String(x.title ?? "").trim(),
          audience: String(x.audience ?? "").trim(),
          product: String(x.product ?? "").trim(),
          monetization: String(x.monetization ?? "").trim(),
          effort: String(x.effort ?? "").trim(),
          stackHint: x.stackHint ? String(x.stackHint).trim() : undefined,
        }))
        .filter((x) => x.title && x.product)
        .slice(0, 4)
    : [];
  const buildSteps = Array.isArray(out.buildSteps)
    ? out.buildSteps
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          step: String(x.step ?? "").trim(),
          detail: String(x.detail ?? "").trim(),
          phase: phaseOf(x.phase),
          output: x.output ? String(x.output).trim() : undefined,
          duration: x.duration ? String(x.duration).trim() : undefined,
        }))
        .filter((x) => x.step && x.detail)
        .slice(0, 6)
    : [];
  const effects = Array.isArray(out.effects)
    ? out.effects
        .filter((x) => x && typeof x === "object")
        .map((x) => ({ metric: String(x.metric ?? "").trim(), value: String(x.value ?? "").trim() }))
        .filter((x) => x.metric && x.value)
        .slice(0, 5)
    : [];

  return zhWalk({
    taglineZh: String(out.taglineZh ?? "").trim() || `${repoName} 创业情报`,
    whatZh: String(out.whatZh ?? "").trim(),
    capabilities: strArray(out.capabilities, 6),
    buildIdeas,
    buildSteps,
    effects,
    moat: String(out.moat ?? "").trim(),
    risks: strArray(out.risks, 4),
    techNotes: String(out.techNotes ?? "").trim(),
    difficulty,
    timeToMvp: String(out.timeToMvp ?? "").trim(),
    costToMvp: String(out.costToMvp ?? "").trim(),
    competitors: strArray(out.competitors, 5),
    differentiators: strArray(out.differentiators, 5),
  }) as GitHubInsight;
}

/* ------------------------------- 本地启发式（无 LLM 兜底） ------------------------------- */

const CAT_ZH: Record<string, string> = {
  "AI Chat": "AI 对话",
  "Image Gen": "图像生成",
  Video: "短视频",
  "Voice & Audio": "语音音频",
  Writing: "内容写作",
  Coding: "编程开发",
  Automation: "自动化工作流",
  Marketing: "营销获客",
  Productivity: "效率工具",
  "Data & Analytics": "数据分析",
  Agent: "智能体",
  Inference: "模型推理",
  RAG: "知识库检索",
  Other: "通用工具",
};

const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "Unlicense", "MPL-2.0", "ISC", "0BSD", "MIT-0"]);

type Ctx = { fullName: string; mainZh: string; lang: string };
type Family = "media" | "knowledge" | "agent" | "infra" | "growth";
type StepTuple = [step: string, detail: string, phase: BuildPhase, output: string, duration: string];

function familyOf(cat: string): Family {
  if (["Video", "Image Gen", "Voice & Audio", "Writing"].includes(cat)) return "media";
  if (["AI Chat", "RAG"].includes(cat)) return "knowledge";
  if (["Agent", "Automation"].includes(cat)) return "agent";
  if (["Inference", "Coding", "Data & Analytics"].includes(cat)) return "infra";
  return "growth";
}

/** 不同能力族的落地路径：阶段、产出、耗时都不同，避免跨项目一套模板 */
const FAMILY_STEPS: Record<Family, StepTuple[]> = {
  media: [
    ["跑通并摸清质量", "用 {name} 官方入口生成 10-20 个真实样例，记录质量、单件耗时与失败率。", "验证", "样例集 + 耗时基线", "2-3 天"],
    ["锁定一个细分场景", "只选 1 个{cat}需求最刚的场景，写清交付物、验收标准与报价。", "验证", "场景说明 + 报价单", "1 天"],
    ["封装成生产流水线", "把{cat}能力包成「提交需求 → 排队生成 → 预览导出」的流程。", "起步", "可对外使用的生成后台", "1-2 周"],
    ["沉淀可复用资产", "积累行业模板、可商用素材与固定风格，让同类订单越做越快。", "变现", "模板库 + 素材库", "持续"],
    ["先收钱再扩张", "接 10 个真实付费客户验证价格，再决定是否做订阅与批量。", "增长", "首批付费客户与复购数据", "2-4 周"],
  ],
  knowledge: [
    ["整理真实语料", "收集 50-200 条真实文档 / 问答，跑通检索与回答并记录准确率。", "验证", "语料集 + 准确率基线", "2-4 天"],
    ["选定知识密集场景", "在客服、合同、培训、内部检索里选 1 个，明确「答不出怎么办」。", "验证", "场景与兜底规则", "1 天"],
    ["搭最小问答闭环", "做「上传资料 → 建索引 → 问答入口」，先支持单租户。", "起步", "可演示的问答系统", "1-2 周"],
    ["解决信任与权限", "加引用溯源、数据隔离与权限控制，这是企业付费的前提。", "变现", "可交付的私有化版本", "1-2 周"],
    ["按席位或项目收费", "先服务 3-5 个客户，用准确率与响应时长做服务承诺。", "增长", "付费客户与续费记录", "3-4 周"],
  ],
  agent: [
    ["跑通一条高频流程", "用 {name} 把 1 条重复流程端到端跑通，统计节省的人工时间。", "验证", "流程演示 + 节省工时", "2-3 天"],
    ["设计人工兜底", "定义失败重试、异常告警与人工审核，避免自动化出错放大损失。", "验证", "异常处理方案", "1-2 天"],
    ["接入客户现有系统", "对接表单 / 表格 / 即时通讯 / 业务接口，做成「提交 → 执行 → 回执」闭环。", "起步", "可运行的自动化流程", "1-2 周"],
    ["按流程或工时收费", "先做托管服务：替客户跑流程，按条数或节省工时收费。", "变现", "计费方式 + 首批客户", "1-2 周"],
    ["沉淀行业流程模板", "把流程配置化，复制到同行业客户，降低交付成本。", "增长", "行业流程模板库", "持续"],
  ],
  infra: [
    ["部署并压测", "在云主机 / 显卡机上部署 {name}，测吞吐、延迟与单次成本。", "验证", "性能与成本基线", "2-4 天"],
    ["定义接口与计费单位", "确定按次 / 按量 / 按时长的计费方式，写清限额与服务承诺。", "验证", "接口文档 + 价格表", "1-2 天"],
    ["补齐鉴权与用量统计", "加密钥管理、限流、用量统计与账单，才能对外稳定售卖。", "起步", "可计费的接口服务", "1-2 周"],
    ["先服务少量开发者", "找 3-5 个真实开发者试用，用稳定性与响应速度建立口碑。", "变现", "首批付费用户", "2-3 周"],
    ["做稳定性与运维", "加监控、告警、备份与扩容，支撑团队级客户。", "增长", "运维体系 + 服务承诺", "持续"],
  ],
  growth: [
    ["先解决自己的问题", "用 {name} 解决你手头 1 个真实问题，记录前后耗时对比。", "验证", "自用案例 + 效率对比", "1-2 天"],
    ["找 5 个同类用户验证", "访谈 5 个有同样痛点的人，确认他们愿意为结果付费。", "验证", "付费意愿结论", "2-3 天"],
    ["做单一功能最小工具", "只保留「输入 → 处理 → 输出」一条主路径，去掉多余功能。", "起步", "可用的最小工具", "1 周"],
    ["手动交付先收费", "先人工帮客户跑结果，验证价格与交付流程，再自动化。", "变现", "首批付费订单", "1-2 周"],
    ["聚焦一个获客渠道", "只做一个渠道（社群 / 搜索 / 内容），把案例与口碑做起来。", "增长", "稳定获客来源", "3-4 周"],
  ],
};

function fill(t: string, c: Ctx): string {
  return t.replace(/\{name\}/g, c.fullName).replace(/\{cat\}/g, c.mainZh);
}

function stepsFor(fam: Family, c: Ctx): BuildStep[] {
  return FAMILY_STEPS[fam].map(([step, detail, phase, output, duration]) => ({
    step,
    detail: fill(detail, c),
    phase,
    output: fill(output, c),
    duration,
  }));
}

function heuristicInsight(r: GitHubRepo): GitHubInsight {
  const cats = r.categories ?? [];
  const main = cats[0] ?? "Other";
  const mainZh = CAT_ZH[main] ?? "AI";
  const lang = r.language ?? "主流语言";
  const lic = r.license?.spdx ?? "开源许可";
  const permissive = PERMISSIVE.has(lic);
  const hot = r.stars >= 10000 ? "高热度" : "成长中";

  const buildIdeas = [
    {
      title: `${mainZh}垂直 SaaS`,
      audience: `不会自建的${mainZh}需求方`,
      product: `把 ${r.fullName} 封装成开箱即用的 ${mainZh} 云服务：免部署、按订阅使用，先做 1 个高频场景。`,
      monetization: "月订阅 ￥99-499，或按用量计费。",
      effort: "1-2 人 / 2-4 周",
      stackHint: `${lang} 服务封装 + 鉴权计费`,
    },
    {
      title: `${mainZh}自动化服务`,
      audience: "有重复流程的中小团队",
      product: `基于项目能力做 ${mainZh} 自动化流水线，客户提交需求、你交付结果。`,
      monetization: "按次 ￥5-50，或项目制报价。",
      effort: "1 人 / 2-3 周",
      stackHint: "任务队列 + 结果交付页",
    },
    {
      title: `${mainZh}行业定制`,
      audience: "一个垂直行业（选竞品少的）",
      product: `只服务一个行业，把通用 ${mainZh} 能力做成该行业的标准交付物。`,
      monetization: "￥999-4999/月 行业服务费。",
      effort: "2 人 / 4-6 周",
      stackHint: "行业模板 + 私有化部署",
    },
  ];

  const fam = familyOf(main);
  const ctx: Ctx = { fullName: r.fullName, mainZh, lang };
  const buildSteps = stepsFor(fam, ctx);

  return zhWalk({
    // 无大模型时写不出可靠的中文定位，留空由前端回落到 GitHub 原始简介，
    // 避免所有项目显示同一句「用 X 能力，做一个能收钱的小产品」。
    taglineZh: "",
    whatZh: `这是一个${hot}的 ${mainZh} 开源项目（${lang}，${lic}，${r.stars} stars）。它把${mainZh}能力封装成可复用模块，适合在其之上做产品化、场景化改造，而不是直接转卖原项目。`,
    capabilities: [`${mainZh}核心能力`, "可二次开发", "本地 / 私有部署", `${lang} 技术栈`],
    buildIdeas,
    buildSteps,
    effects: [
      { metric: "做出 MVP 的周期", value: "2-4 周" },
      { metric: "单次处理成本", value: "约 ￥0.5-5" },
      { metric: "单次对外报价", value: "￥10-50" },
      { metric: "毛利率", value: "60%+" },
    ],
    moat: "壁垒在行业模板、交付质量与客户渠道，不在模型本身。",
    risks: [
      permissive ? "宽松许可可商用，但需保留版权声明并确认无专利风险。" : `${lic} 许可有商业化约束，商用前务必逐条确认。`,
      "上游社区维护与接口变动，可能带来升级成本。",
      "同质化竞争，纯低价难以持续，必须绑定行业与交付。",
    ],
    techNotes: `技术上以 ${lang} 为主；建议加任务队列、对象存储与简单的鉴权计费。`,
    difficulty: "中",
    timeToMvp: "2-4 周",
    costToMvp: "￥100-1000/月",
    competitors: [],
    differentiators: ["只做 1 个垂直行业", "按结果交付而非卖工具", "更快的本地化响应"],
  }) as GitHubInsight;
}

function parseArgs() {
  const only: string[] = [];
  const i = process.argv.indexOf("--only");
  if (i >= 0) {
    const raw = process.argv.slice(i + 1).filter((a) => !a.startsWith("--"));
    for (const a of raw) for (const s of a.split(",")) if (s.trim()) only.push(s.trim().toLowerCase());
  }
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? parseInt(process.argv[limitIdx + 1] ?? "0", 10) || 0 : 0;
  return { only, limit, force: process.argv.includes("--force"), local: process.argv.includes("--local") };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!hasLLM()) {
    console.error("[insight] 未配置 DEEPSEEK_API_KEY（.env.local）");
    process.exit(1);
  }
  const { only, limit, force, local } = parseArgs();
  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf-8")) as { updatedAt: string; repos: GitHubRepo[] };
  const repos = data.repos ?? [];

  /* --repair：不调大模型，只把已有情报里的英文缩写重新洗一遍并重算得分 */
  if (process.argv.includes("--repair")) {
    let fixed = 0;
    for (const r of repos) {
      if (!r.insight) continue;
      const before = JSON.stringify(r.insight);
      r.insight = zhWalk(r.insight) as GitHubInsight;
      if (JSON.stringify(r.insight) !== before) fixed++;
    }
    const rescored = repos.map((r) => ({ ...r, productScore: computeProductScore(r) })).sort(compareByScore);
    fs.writeFileSync(JSON_PATH, JSON.stringify({ ...data, repos: rescored }, null, 2) + "\n", "utf-8");
    console.log(`[insight] 中文清洗完成：修改 ${fixed} 个情报 → ${JSON_PATH}`);
    return;
  }

  const targets = repos.filter((r) => {
    if (only.length > 0 && !only.includes(r.fullName.toLowerCase())) return false;
    if (!force && r.insight) return false;
    return true;
  });

  const todo = limit > 0 ? targets.slice(0, limit) : targets;
  console.log(`[insight] 待生成 ${todo.length} 个（共 ${repos.length} 个仓库）；模式=${local ? "本地" : "LLM"}`);

  let fromCurated = 0;
  let fromLLM = 0;
  let fromLocal = 0;
  let llmFail = 0;

  for (const r of todo) {
    // 1) 精编优先
    const curated = CURATED_INSIGHTS[r.fullName];
    if (curated) {
      r.insight = zhWalk(curated) as GitHubInsight;
      fromCurated++;
      console.log(`[insight] ★ ${r.fullName}（精编）：${curated.taglineZh}`);
      continue;
    }
    // 2) 强制本地
    if (local) {
      r.insight = heuristicInsight(r);
      fromLocal++;
      continue;
    }
    // 3) LLM，失败回退本地
    try {
      const out = await chatJSON<Partial<GitHubInsight>>(SYSTEM, buildPayload(r), 3000);
      r.insight = normalize(out, r.fullName);
      fromLLM++;
      console.log(`[insight] ✓ ${r.fullName}：${r.insight.taglineZh}`);
    } catch (e) {
      llmFail++;
      r.insight = heuristicInsight(r);
      fromLocal++;
      console.warn(`[insight] ✗ ${r.fullName}，回退本地：`, e instanceof Error ? e.message : e);
    }
    await sleep(300);
  }

  // 情报生成后重算综合得分（此时才有「上手难度」可计入），并按得分排序
  const scored = repos
    .map((r) => ({ ...r, productScore: computeProductScore(r) }))
    .sort(compareByScore);

  fs.writeFileSync(
    JSON_PATH,
    JSON.stringify({ ...data, repos: scored }, null, 2) + "\n",
    "utf-8",
  );
  console.log(
    `[insight] 完成：精编 ${fromCurated}，LLM ${fromLLM}，本地 ${fromLocal}（LLM 失败 ${llmFail}）→ ${JSON_PATH}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});