// 榜单准入：不是「沾 AI 就收」，而是「看到这个词的人，明天有活可干」。
// 判定结果缓存在 dataset.policy.verdicts 里避免重复花钱；
// 原则本身可演进——定期用被拒样本做一次审计，把误杀/漏放修回条目。
import type { EntryPolicy, ValueVerdict } from "@horizons/shared";
import { chatJSON } from "../sources/llm";

/** 判定有效期：市场变化快，超期重判 */
const TTL_DAYS = 30;
/** 一次送几个词给模型 */
const BATCH = 10;
/**
 * 低于这个分不收：分数表示「创业切口强度」。
 * 定在 40 而不是 60——拥挤但真实的赛道（ai coding agent、ai resume builder）
 * 需求是确定的，只是差异空间小；把这类词挡在门外等于放弃整个主流需求面。
 */
export const ACCEPT_SCORE = 40;
/** 原则多久自审一次 */
export const AUDIT_INTERVAL_DAYS = 7;

export const DEFAULT_POLICY: EntryPolicy = {
  version: 4,
  updatedAt: "",
  accept: [
    "有人在找一个具体工具或方案去做某件事——赛道拥挤不是拒的理由，拥挤说明需求真实",
    "有明确使用场景和可识别人群；付费方是个人用户也算，不必是企业岗位",
    "新兴协议、开源项目、能力名词，只要周围已出现接入、调试、托管、评测等具体工程需求",
    "独立开发者或两三人团队 3 个月内能做出第一版",
    "不需要牌照、不需要自建算力、不需要地面销售团队",
    "一人公司自己的经营问题：给 AI 产品定价、控制 token 成本、获客与留存——搜的人就是做产品的人本人，这类词不指向某个工具，但直接决定他能不能活下来",
  ],
  reject: [
    "模型 / 版本发布资讯（gpt-5、llama 4、gemini 3 这类）：搜的人只想知道新旧差异和跑分",
    "大厂 API / 模型的定价查询词（deepseek api pricing、anthropic api pricing、openai fine tuning price 这类）：搜的人在查价不在找方案，官方文档和 OpenRouter 这类聚合器已经把「查价」做完；判据看主语——主语是厂商价格就拒，主语是自家产品怎么定价、怎么把成本省下来就收",
    "单个小产品的品牌名（Ayven、Ferndesk、Pancake、Busabase 这类）：搜的人是在找这个产品本身，不是找解决方案；只有已成品类代名词的（Figma、Notion、Cursor）例外",
    "纯概念科普的泛词（ai、machine learning、prompt engineering）：没有具体场景",
    "单公司内部功能名、单条新闻事件、纯娱乐梗",
    "必须大额资本或资质才能做：自建算力、GPU 租赁、医疗诊断、法律意见",
    "只剩巨头免费功能承接、且没有任何细分角度的方向",
  ],
  notes: [
    "v4 收敛：榜单里 pricing 类词一度涌进 18 个，其中 deepseek api pricing、anthropic api pricing 这类是纯查价，读者看完只知道多少钱，做不出东西；而 ai saas pricing model、llm cost tracking 是一人公司真在纠结的问题。区别在主语：厂商的价格 vs 自家产品怎么定价和控成本。前一类拒，后一类明确收。",
    "v3 补漏：v2 的排除项漏了「单个小产品名」，实测把 ayven、ferndesk、pancake 这类品牌词收进了榜——它们只有品牌自己的人在搜，读者拿不到任何可迁移的东西。补一条：产品名除非已成品类代名词，一律拒。",
    "v2 校准：v1 把「供给未饱和」当硬门槛，实测 212 个候选只通过 1%，ai resume builder、ai customer feedback 这类真实需求全被误杀。改为排除法——只拒「搜的人拿不到任何可动手的东西」，红海词按 40-60 分收录。",
  ],
  verdicts: {},
};

const DAY_MS = 86_400_000;

export function ensurePolicy(p?: EntryPolicy): EntryPolicy {
  if (!p || !Array.isArray(p.accept) || p.accept.length === 0) {
    return {
      ...DEFAULT_POLICY,
      accept: [...DEFAULT_POLICY.accept],
      reject: [...DEFAULT_POLICY.reject],
      notes: [...DEFAULT_POLICY.notes],
      updatedAt: new Date().toISOString(),
      verdicts: {},
    };
  }
  return { ...p, verdicts: { ...(p.verdicts ?? {}) } };
}

/** 读缓存判定；过期或不存在返回 null */
export function cachedVerdict(policy: EntryPolicy, normalizedKey: string): ValueVerdict | null {
  const hit = policy.verdicts?.[normalizedKey];
  if (!hit) return null;
  const age = Date.now() - Date.parse(hit.at);
  if (!Number.isFinite(age) || age > TTL_DAYS * DAY_MS) return null;
  return hit;
}

export function shouldAccept(v: ValueVerdict): boolean {
  return v.verdict === "accept" && v.score >= ACCEPT_SCORE;
}

const JUDGE_SYSTEM = `你是趋势榜单的选品编辑，读者是独立开发者和小团队创始人。
你的动作是「排除」，不是「择优」：默认收，只有命中下面情形才拒。

拒（搜的人拿不到任何可动手的东西）：
- 模型 / 版本发布资讯：gpt-5、llama 4、gemini 3、nano banana 这类，搜的人只想知道新旧差异、跑分、怎么用
- 单个小产品的品牌名：ayven、ferndesk、pancake、busabase 这类，搜的人是在找这个产品本身，
  读者拿不到任何可迁移的东西。只有已成品类代名词的例外（figma、notion、cursor）
- 品牌名 + 品类词的组合：nebula mcp、render mcp、bluebird mcp、copilotkit examples、
  replit agent、figma agent 这类，主语仍是某个具体产品，不是需求本身。
  判断方法：把这个词去掉品类词后，剩下的还是不是一个产品名；是就拒。
  只有品类词本身（mcp server、mcp、rag pipeline）才收
- 纯概念科普的泛词：ai、machine learning、prompt engineering，没有具体场景
- 单公司内部功能名、单条新闻事件、纯娱乐梗
- 大厂 API / 模型的定价查询词：deepseek api pricing、anthropic api pricing、openai fine tuning price、
  claude code tokens cost 这类。搜的人在查价，不在找方案；官方文档和 OpenRouter 这类聚合器已经把
  「查价」这件事做完了，独立开发者最多做个没人用的计算器，读者拿不到可迁移的东西。
  判据看主语：主语是厂商的价格 → 拒；主语是「我的产品该怎么定价 / 怎么把钱省下来」→ 收。
  所以 ai saas pricing model、per seat pricing ai、llm cost tracking、monitor ai agent cost
  这些收——付费方就是做产品的人自己，是一人公司的真问题
- 必须大额资本或资质才能做：自建算力、GPU 租赁、医疗诊断、法律意见
- 只剩巨头免费功能承接、且没有任何细分角度的方向

收（都能进榜，只是强弱不同）：
- 有人在找一个具体工具或方案去做某件事。赛道拥挤不是拒的理由，拥挤说明需求真实
- 有明确使用场景和可识别人群，付费方是个人用户也算，不必是企业岗位
- 一人公司自己的经营问题：给 AI 产品定价、控制 token 成本、获客渠道、留存与续费。
  这类词搜的人就是做产品的人本人，它们不指向「某个工具」，但直接决定他能不能活下来，
  是榜单里最有行动价值的一类
- 新兴协议、开源项目、能力名词，只要周围已经出现接入、调试、托管、评测这类具体工程需求

score 是创业切口强度 0-100，只用来区分强弱，不是准入门槛：
- 40-60：需求真实但红海，要靠细分场景或体验差异化
- 60-85：需求明确、供给尚未饱和，能直接找到切口
- 85+：少数，需求刚性且几乎没有像样供给

reason 一句话说清判断；audience 写谁最可能付钱（个人用户也可以）；
ideaAngle 写一个明天就能开工的具体动作，不要写「做个更好的 X」这种空话。
只有 reject 时 ideaAngle 留空。

只输出 JSON 对象：{"items":[{"keyword":"原词","verdict":"accept|reject","score":0,"reason":"","audience":"","ideaAngle":""}]}，items 必须覆盖输入的每个词。`;

interface RawItem {
  keyword?: string;
  verdict?: string;
  score?: number;
  reason?: string;
  audience?: string;
  ideaAngle?: string;
}

/**
 * 批量判定候选词的创业价值。LLM 故障时抛错，由调用方决定回退策略
 * （不能静默全收或全拒，否则等于换了套随机规则）。
 */
export async function judgeKeywords(
  keywords: string[],
  policy: EntryPolicy,
): Promise<Map<string, ValueVerdict>> {
  const out = new Map<string, ValueVerdict>();
  const now = new Date().toISOString();

  for (let i = 0; i < keywords.length; i += BATCH) {
    const chunk = keywords.slice(i, i + BATCH);
    const res = await chatJSON<{ items?: RawItem[] }>(
      JUDGE_SYSTEM,
      JSON.stringify({ accept: policy.accept, reject: policy.reject, keywords: chunk }),
      2400,
      0.1,
    );

    for (const item of res.items ?? []) {
      const key = (item.keyword ?? "").trim().toLowerCase();
      if (!key) continue;
      const verdict: ValueVerdict["verdict"] = item.verdict === "accept" ? "accept" : "reject";
      out.set(key, {
        verdict,
        score: Math.max(0, Math.min(100, Math.round(Number(item.score) || 0))),
        reason: (item.reason ?? "").slice(0, 200),
        audience: (item.audience ?? "").slice(0, 120),
        ideaAngle: verdict === "accept" ? (item.ideaAngle ?? "").slice(0, 200) : "",
        at: now,
      });
    }

    if (i + BATCH < keywords.length) await new Promise((r) => setTimeout(r, 600));
  }

  return out;
}

const AUDIT_SYSTEM = `你在维护一份趋势榜单的准入原则，读者是独立开发者。
根据最近一批被拒/被收的词，检查现有原则是否有两类问题：
A) 误杀——本来有可落地机会却被拒；
B) 漏放——明显没有切入点的词被收。
只有样本给出证据时才改条目，不要为改而改。条目保持一句话、可执行，各最多 6 条。
只输出 JSON：{"accept":["..."],"reject":["..."],"notes":["本次修订依据，无修订则写无需修订"]}`;

/** 用最近的判定样本重写原则条目；模型认为无需修订时保持原样 */
export async function auditPolicy(
  policy: EntryPolicy,
  recent: Array<{ keyword: string; verdict: ValueVerdict }>,
): Promise<EntryPolicy> {
  if (recent.length === 0) return policy;

  const res = await chatJSON<{ accept?: string[]; reject?: string[]; notes?: string[] }>(
    AUDIT_SYSTEM,
    JSON.stringify({
      accept: policy.accept,
      reject: policy.reject,
      samples: recent.slice(0, 24).map((s) => ({
        keyword: s.keyword,
        verdict: s.verdict.verdict,
        score: s.verdict.score,
        reason: s.verdict.reason,
      })),
    }),
    1600,
    0.1,
  );

  const clean = (arr: string[] | undefined, fallback: string[]): string[] => {
    const list = (arr ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    return list.length > 0 ? list : fallback;
  };

  return {
    ...policy,
    version: policy.version + 1,
    updatedAt: new Date().toISOString(),
    accept: clean(res.accept, policy.accept),
    reject: clean(res.reject, policy.reject),
    notes: [...clean(res.notes, ["本轮无修订"]), ...policy.notes].slice(0, 8),
  };
}

/** 判定缓存上限，防止 JSON 无限膨胀 */
const MAX_CACHE = 1200;

export function pruneVerdicts(policy: EntryPolicy): EntryPolicy {
  const entries = Object.entries(policy.verdicts ?? {});
  if (entries.length <= MAX_CACHE) return policy;
  entries.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return { ...policy, verdicts: Object.fromEntries(entries.slice(0, MAX_CACHE)) };
}

/** 距离上次审计是否已超过间隔 */
export function auditDue(policy: EntryPolicy): boolean {
  const age = Date.now() - Date.parse(policy.updatedAt || "");
  return !Number.isFinite(age) || age > AUDIT_INTERVAL_DAYS * DAY_MS;
}