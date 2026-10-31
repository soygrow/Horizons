/** AI 模型榜：厂商映射、能力分校准、文案模板与解析工具 */

export const PROVIDERS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
  "x-ai": "xAI",
  moonshotai: "Moonshot AI",
  "z-ai": "Z.ai",
  minimax: "MiniMax",
  nvidia: "NVIDIA",
  microsoft: "Microsoft",
  cohere: "Cohere",
  amazon: "Amazon",
  ai21: "AI21 Labs",
  baidu: "Baidu",
  bytedance: "ByteDance",
  stepfun: "StepFun",
  tencent: "Tencent",
  "01-ai": "01.AI",
  perplexity: "Perplexity",
  allenai: "Allen AI",
  "ibm-granite": "IBM",
  liquid: "Liquid AI",
  inclusionai: "InclusionAI",
  "arcee-ai": "Arcee AI",
  agentica: "Agentica",
  nousresearch: "Nous Research",
  upstage: "Upstage",
  rekaai: "Reka",
  inflection: "Inflection",
  morph: "Morph",
  "nex-agi": "Nex AGI",
  cognitivecomputations: "Cognitive Computations",
  xiaomi: "Xiaomi",
  kwaipilot: "KwaiPilot",
  meituan: "Meituan",
  longcat: "LongCat",
  tngtech: "TNG",
  poolside: "Poolside",
  thudm: "Zhipu AI",
  meta: "Meta",
  "bytedance-seed": "ByteDance",
  "aion-labs": "Aion Labs",
  "particle-ai": "Particle AI",
  thinkingmachines: "Thinking Machines",
  sakana: "Sakana AI",
  writer: "Writer",
  reflection: "Reflection",
  moondream: "Moondream",
  relace: "Relace",
  "inference-net": "Inference.net",
  fireworks: "Fireworks",
};

/**
 * models.dev 厂商键 → 站点展示名
 *
 * 只放「模型原厂」（官方直营 API）：聚合站、云市场、托管平台、订阅套餐一律不收，
 * 避免同一模型被十几个转售商标价重复收录。展示名需与 apps/site/src/lib/vendor-logos.ts
 * 的键保持一致，logo 才能命中；未收录图标的厂商回退首字母方块。
 */
export const MODELS_DEV_PROVIDERS = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  meta: "Meta",
  mistral: "Mistral AI",
  xai: "xAI",
  cohere: "Cohere",
  perplexity: "Perplexity",
  ai21: "AI21 Labs",
  arcee: "Arcee AI",
  inception: "Inception",
  upstage: "Upstage",
  nvidia: "NVIDIA",
  sakana: "Sakana AI",
  thinkingmachines: "Thinking Machines",
  // 同一原厂的国际站 / 国内站，合并到同一个展示名，靠模型名去重
  alibaba: "Qwen",
  "alibaba-cn": "Qwen",
  zhipuai: "Z.ai",
  zai: "Z.ai",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax",
  stepfun: "StepFun",
  "stepfun-ai": "StepFun",
  xiaomi: "Xiaomi",
  longcat: "LongCat",
  volcengine: "ByteDance",
  "tencent-tokenhub": "Tencent",
  sensenova: "SenseNova",
  bailing: "Bailing",
};

/**
 * 品牌归属：模型名里的品牌词 → 应归属厂商展示名
 *
 * 部分聚合型 Provider 会把别人家的模型挂在自己名下（「Kimi K3」出现在 Qwen、
 * 「DeepSeek V4」出现在 Mistral），归属错误会让榜单厂商维度失真。
 * 采集中命中「品牌 ≠ 当前 Provider」的条目直接跳过，由原厂自己的源收录。
 *
 * 匹配规则：取名字中最靠前的品牌词判定归属，因此
 * 「siliconflow/deepseek-v3.2」判给渠道而非 DeepSeek、「Moonshot Kimi K2.5」判给 Moonshot。
 */
const BRAND_OWNER = [
  [/\bdeepseek/i, "DeepSeek"],
  [/\bclaude/i, "Anthropic"],
  [/\b(chatgpt|gpt)/i, "OpenAI"],
  [/\bo[1-9]\b/i, "OpenAI"],
  [/\b(gemini|gemma|palm)\b/i, "Google"],
  [/\b(qwen|qwq)/i, "Qwen"],
  [/\bglm/i, "Z.ai"],
  [/\bllama/i, "Meta"],
  [/\b(mistral|mixtral|magistral|codestral|ministral|devstral|pixtral|voxtral)/i, "Mistral AI"],
  [/\bminimax/i, "MiniMax"],
  [/\bkimi/i, "Moonshot AI"],
  [/\bmoonshot/i, "Moonshot AI"],
  [/\bgrok/i, "xAI"],
  [/\bcommand/i, "Cohere"],
  [/\bnemotron/i, "NVIDIA"],
  [/\bphi[- ]?\d/i, "Microsoft"],
  [/\bnova/i, "Amazon"],
  [/\b(hunyuan|hy\d)/i, "Tencent"],
  [/\bernie/i, "Baidu"],
  [/\b(doubao|seed)[- ]?\d/i, "ByteDance"],
  [/\byi[- ](large|medium|34b|lightning)/i, "01.AI"],
  [/\bling[- ]/i, "InclusionAI"],
  [/\binclusion/i, "InclusionAI"],
  [/\bsonar/i, "Perplexity"],
  [/\bjamba/i, "AI21 Labs"],
  [/\breka/i, "Reka"],
  [/\bolmo/i, "Allen AI"],
  [/\bgranite/i, "IBM"],
  [/\blfm/i, "Liquid AI"],
  [/\bstep[- ]?\d/i, "StepFun"],
  [/\binkling/i, "Thinking Machines"],
  // 渠道名：命中说明该条是分发方的镜像条目，不是原厂模型
  [/\bsiliconflow/i, "SiliconFlow"],
  [/\bmodelscope/i, "ModelScope"],
  [/\bvolcengine/i, "Volcengine"],
];

/** 返回模型名的品牌归属厂商（取最靠前的品牌词）；无法判定返回 null */
export function brandOwnerOf(name = "") {
  const text = String(name);
  let best = null;
  for (const [re, owner] of BRAND_OWNER) {
    const at = text.search(re);
    if (at < 0) continue;
    if (!best || at < best.at) best = { at, owner };
  }
  return best ? best.owner : null;
}

export const PRICING_URL = {
  OpenAI: "https://openai.com/api/pricing/",
  Anthropic: "https://www.anthropic.com/pricing",
  Google: "https://ai.google.dev/pricing",
  DeepSeek: "https://api-docs.deepseek.com/quick_start/pricing",
  Qwen: "https://help.aliyun.com/zh/model-studio/models",
  Meta: "https://www.llama.com/",
  "Mistral AI": "https://mistral.ai/pricing",
  xAI: "https://docs.x.ai/docs/models",
  "Moonshot AI": "https://platform.moonshot.cn/docs/pricing",
  "Z.ai": "https://open.bigmodel.cn/pricing",
  MiniMax: "https://www.minimaxi.com/price",
};

/** 顺序敏感：具体在前，家族兜底在后 */
const CAPABILITY_RULES = [
  [/gpt-6\.1.*(pro|ultra)/, 99],
  [/gpt-6\.1/, 96],
  [/gpt-6(?!.*(mini|nano))/, 95],
  [/gpt-5(?!.*(mini|nano))/, 93],
  [/gpt-5.*mini|gpt-6.*mini/, 84],
  [/gpt-5.*nano/, 76],
  [/claude.*opus/, 96],
  [/claude.*sonnet/, 92],
  [/claude.*haiku/, 80],
  [/gemini.*ultra/, 95],
  [/gemini.*pro/, 93],
  [/gemini.*flash.*lite/, 74],
  [/gemini.*flash/, 84],
  [/grok-(5|4)/, 94],
  [/grok.*mini/, 74],
  [/grok-3/, 86],
  [/deepseek.*(v4|v3\.2|r2)/, 91],
  [/deepseek.*r1/, 87],
  [/deepseek.*v3/, 85],
  [/deepseek.*chat/, 78],
  [/qwen3.*max/, 92],
  [/qwen3.*(235b|480b|thinking|coder-plus)/, 88],
  [/qwen3.*plus/, 86],
  [/qwen3/, 81],
  [/qwen.*(72b|32b)/, 79],
  [/qwen.*small/, 66],
  [/llama-4.*(behemoth|maverick)/, 86],
  [/llama-4.*scout/, 76],
  [/llama-3\.3-70b/, 78],
  [/llama-3\.1-(405b|70b)/, 74],
  [/llama-3\.1-8b|llama-3-8b/, 60],
  [/mistral-large/, 86],
  [/magistral|mistral-medium/, 80],
  [/codestral/, 76],
  [/devstral/, 73],
  [/mixtral-8x22b/, 70],
  [/mistral-small/, 66],
  [/kimi-k2.*(thinking|turbo)/, 92],
  [/kimi-k2/, 88],
  [/kimi/, 74],
  [/glm-5/, 90],
  [/glm-4\.[5-6]/, 84],
  [/glm-4.*air/, 72],
  [/glm/, 70],
  [/minimax-m[2-9]/, 88],
  [/minimax-01/, 74],
  [/nemotron.*(ultra|253b|340b)/, 84],
  [/nemotron.*(70b|49b)/, 74],
  [/nemotron.*(nano|8b|4b)/, 62],
  [/phi-5/, 75],
  [/phi-4/, 68],
  [/gemma-3.*27b/, 70],
  [/gemma-3|gemma-2/, 56],
  [/command-a/, 78],
  [/command-r-plus/, 72],
  [/command-r/, 65],
  [/nova-premier/, 82],
  [/nova-pro/, 75],
  [/nova-lite/, 65],
  [/nova-micro/, 57],
  [/ernie/, 80],
  [/seed-oss|doubao/, 84],
  [/step-3|step-2/, 80],
  [/hunyuan/, 84],
  [/yi-large|yi-34b/, 68],
  [/sonar-pro/, 78],
  [/sonar-reasoning/, 80],
  [/sonar/, 66],
  [/virtuoso/, 70],
  [/ling-/, 70],
  [/lfm/, 55],
  [/hermes/, 62],
  [/jamba/, 66],
  [/olmo/, 60],
  [/granite/, 58],
  [/dolphin/, 60],
  [/solar/, 62],
  [/reka/, 64],
  [/deepcoder/, 85],
  [/gpt-oss/, 82],
  [/^o[34]/, 88],
];

export function estimateCapability(id, ctx, reasoning) {
  let score = 55;
  for (const [re, v] of CAPABILITY_RULES) {
    if (re.test(id)) {
      score = v;
      break;
    }
  }
  if (reasoning && score <= 95) score += 2;
  if (ctx >= 500_000 && score <= 96) score += 1;
  return Math.max(40, Math.min(99, score));
}

export const clean = (s = "") =>
  s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const round = (n) => Math.round(n * 1e6) / 1e6;

const BENCH = [
  "MMLU-Pro",
  "MMLU",
  "GPQA Diamond",
  "GPQA",
  "SWE-bench Verified",
  "SWE-bench",
  "AIME 2025",
  "AIME",
  "HumanEval",
  "LiveCodeBench",
  "ARC-AGI-2",
  "ARC-AGI",
  "HLE",
  "Terminal-Bench",
  "MATH-500",
  "Aider Polyglot",
  "Codeforces",
];

export function parseBenchmarks(desc) {
  const out = [];
  const text = clean(desc);
  for (const name of BENCH) {
    const fwd = new RegExp(`${name.replace(/[-/]/g, "[-/ ]?")}[^%]{0,45}?(\\d{1,3}(?:\\.\\d+)?)\\s*%`, "i");
    const rev = new RegExp(`(\\d{1,3}(?:\\.\\d+)?)\\s*%[^.%]{0,20}?(?:on|in)\\s*${name.replace(/[-/]/g, "[-/ ]?")}`, "i");
    const m = fwd.exec(text) || rev.exec(text);
    if (m) out.push({ name, value: m[1], unit: "%" });
    if (out.length >= 3) break;
  }
  return out;
}

export function detectOpen(id, hfId, desc) {
  if (hfId) return true;
  if (/open[\s-]?weights|open[\s-]?source|apache 2\.0|mit license/i.test(desc)) return true;
  return /deepseek|qwen(?!.*(max|plus|turbo))|llama|mistral|magistral|codestral|devstral|mixtral|kimi-k2|glm-|nemotron|olmo|granite|gemma|phi-|ernie|seed-oss|step-3|hunyuan|yi-|ling-|lfm|virtuoso|hermes|solar|dolphin|jamba|command-a|gpt-oss/.test(
    id,
  );
}

export function detectLicense(desc, open) {
  const m = /(Apache[\s-]?2\.0|MIT|Llama\s?\d(?:\.\d)?\s?Community|Qwen[\s-]?License|Gemma[\s-]?Terms|MRL|CC[\s-]?BY[\s-]?NC(?:[\s-]?\d\.\d)?|DeepSeek[\s-]?License|Modified[\s-]?MIT|OpenRAIL)/i.exec(
    clean(desc),
  );
  if (m) return m[1];
  return open ? "开源（协议待核对）" : "Proprietary";
}

export function paramsOf(name) {
  const m = /(\d+(?:\.\d+)?)\s?B\b/.exec(name);
  return m ? `${m[1]}B` : null;
}

export function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function sentences(text, max = 170) {
  const t = clean(text);
  if (!t) return "";
  const parts = t.split(/(?<=[.!?。！？])\s+/);
  let out = "";
  for (const p of parts) {
    if ((out + p).length > max && out) break;
    out += (out ? " " : "") + p;
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const fmtCtx = (n) => {
  if (!n) return "未公开";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(n / 1000)}K`;
};

const fmtPrice = (n) => {
  if (n === null || n === undefined) return "未公开";
  if (n < 0.1) return `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
};

/**
 * 官方简介：保留厂商模型页原文，只清洗 HTML / Markdown 噪音，不做翻译与改写。
 * 没有有效内容（或短到无信息量）时返回 null，页面不展示、也不生成替代文案。
 */
export function cleanDescription(raw) {
  if (!raw) return null;
  const text = String(raw)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/[*_`]{1,2}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 30 ? text : null;
}

/** 基于真实字段生成优势/短板/场景，不编造具体基准数字 */
export function buildCopy(m) {
  const strengths = [];
  const weaknesses = [];
  const useCases = [];

  if (m.reasoningFlag) strengths.push("支持显式推理模式，复杂任务拆解更稳");
  if (m.context >= 200_000)
    strengths.push(
      `超长上下文（${
        m.context >= 1_000_000
          ? `${Number.isInteger(m.context / 1_000_000) ? m.context / 1_000_000 : (m.context / 1_000_000).toFixed(1)}M`
          : `${Math.round(m.context / 1000)}K`
      }），适合整库与长文档`,
    );
  if (m.priceIn !== null && m.priceIn <= 0.5) strengths.push("输入价格低，适合高频、批量调用");
  if (m.open) strengths.push("权重开放，可私有化部署与微调");
  if (m.modality === "multimodal") strengths.push("支持图像/文件等多模态输入");
  if (m.maxOutput >= 64_000) strengths.push("单次输出上限高，适合长报告生成");

  if (m.priceIn !== null && m.priceIn >= 5) weaknesses.push("输入价格偏高，规模化调用成本压力大");
  if (m.context < 32_000) weaknesses.push("上下文窗口偏小，长文档需切分");
  if (!m.reasoningFlag) weaknesses.push("无显式推理模式，复杂链路要自行拆解");
  if (m.maxOutput !== null && m.maxOutput < 8_000) weaknesses.push("单次输出上限较低");
  if (m.open && /待核对/.test(m.license)) weaknesses.push("开源协议需商用前核对");
  if (!m.open) weaknesses.push("闭源，只能通过 API 调用，无法私有化部署");

  if (m.reasoningFlag) useCases.push("复杂推理与 Agent 编排");
  if (m.modality === "multimodal") useCases.push("图文/文档理解");
  if (m.open) useCases.push("私有化部署");
  if (m.priceIn !== null && m.priceIn <= 0.5) useCases.push("高并发批处理");
  if (m.context >= 200_000) useCases.push("长文档分析");
  if (useCases.length < 3) useCases.push("通用对话与写作", "结构化信息抽取", "内容批量生成");

  const dedupe = (a) => [...new Set(a)];
  const uniqueStrengths = dedupe(strengths);
  const uniqueWeaknesses = dedupe(weaknesses);
  return {
    strengths: (uniqueStrengths.length ? uniqueStrengths : ["支持标准文本对话与补全"]).slice(0, 3),
    weaknesses: (uniqueWeaknesses.length ? uniqueWeaknesses : ["公开资料有限，能力上限需实测确认"]).slice(0, 3),
    useCases: dedupe(useCases).slice(0, 3),
  };
}