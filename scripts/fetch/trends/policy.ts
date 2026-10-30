// 榜单准入：不是「沾 AI 就收」，而是「看到这个词的人，明天有活可干」。
// 判定结果缓存在 dataset.policy.verdicts 里避免重复花钱；
// 原则本身可演进——定期用被拒样本做一次审计，把误杀/漏放修回条目。
import type { EntryPolicy, ValueVerdict } from "@horizons/shared";
import { chatJSON } from "../sources/llm";

/** 判定有效期：市场变化快，超期重判 */
const TTL_DAYS = 30;
/** 一次送几个词给模型 */
const BATCH = 10;
/** 低于这个分不收：分数表示「创业切口强度」 */
export const ACCEPT_SCORE = 60;
/** 原则多久自审一次 */
export const AUDIT_INTERVAL_DAYS = 7;

export const DEFAULT_POLICY: EntryPolicy = {
  version: 1,
  updatedAt: "",
  accept: [
    "有明确的问题场景：搜索者不是在追新闻，而是在找解决方案",
    "有可识别的付费方：企业里某个岗位、专业用户、或开发者本人",
    "独立开发者或两三人团队 3 个月内能做出第一版",
    "不需要牌照、不需要自建算力、不需要地面销售团队",
    "需求已被验证、供给还没饱和：有搜索量但还没有强势在位产品",
  ],
  reject: [
    "模型 / 版本发布资讯（gpt-5、llama 4、gemini 3 这类）：只满足好奇心，没有可承接的场景",
    "纯娱乐梗、单条新闻事件、单公司内部功能名",
    "泛概念（ai、machine learning）：没有具体场景就没有具体产品",
    "需要大额资本或资质的领域（自建算力、医疗诊断、法律意见）",
    "已被巨头免费功能覆盖、且没有差异化空间的方向",
  ],
  notes: ["v1 初始口径：以「独立开发者 3 个月内可落地 + 有明确付费方」为准入线"],
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
唯一标准：这个词背后是否存在「一个人或两三人团队，3 个月内能做出来、并且有人愿意付钱」的机会。

判 accept 需要同时满足：
1. 有具体的问题场景——搜索者在找解决方案，不是想知道发生了什么
2. 有可识别的付费方（企业某岗位 / 专业用户 / 开发者）
3. 交付物可以是软件、工具、服务或内容产品，不需要牌照、不需要自建算力、不需要销售团队

判 reject 的典型：
- 只是模型或版本发布（搜的人只想知道新旧差异）
- 纯娱乐梗、单条新闻、单公司内部功能名
- 泛概念，没有具体场景
- 需要大额资本或资质的领域

score 是创业切口强度 0-100：需求确定性、可承接性、供给稀缺度三者综合。40 分以下是「没有切口」。
reason 一句话说清为什么，audience 写谁付钱，ideaAngle 写一个能开工的具体动作（reject 时留空）。

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