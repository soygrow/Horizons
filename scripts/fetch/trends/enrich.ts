import type {
  ClaimType,
  OpportunityScoreParts,
  TrendActionVerdict,
  TrendCategory,
  TrendEditorNote,
  TrendEvidence,
  TrendIntent,
  TrendIntentKey,
  TrendNextAction,
  TrendOpportunity,
  TrendOpportunityType,
  TrendSeries,
  TrendSourceRef,
} from "@horizons/shared";
import type { KeywordEvidence } from "./discovery";
import { chatJSON } from "../sources/llm";
import { seriesMetrics } from "./score";

export interface Enrichment {
  normalizedName: string;
  category: TrendCategory;
  why: string;
  intentSummary: string;
  /** 准入结论，来自价值判定，页面用来回答「谁付钱、从哪下手」 */
  editorNote?: TrendEditorNote;
  evidence: TrendEvidence[];
  intents: TrendIntent[];
  relatedQueries: string[];
  competitors: string[];
  oppParts: OpportunityScoreParts;
  opportunities: TrendOpportunity[];
  actions: TrendNextAction[];
}

const CATEGORIES: TrendCategory[] = [
  "model",
  "tool",
  "agent",
  "devtech",
  "usecase",
  "business",
  "broadtech",
];
const INTENTS: TrendIntentKey[] = ["learn", "howto", "problem", "compare", "price", "alternative"];
const CLAIMS: ClaimType[] = ["fact", "inference", "hypothesis"];
const OPP_TYPES: TrendOpportunityType[] = ["content", "product", "opensource", "feature"];
const VERDICTS: TrendActionVerdict[] = ["research", "content", "mvp", "watch"];

const SYSTEM = `你是 AI 趋势榜单的资深分析师，服务对象是想找机会的独立开发者与内容创作者。
根据给定的关键词、Google Trends 序列摘要、真实证据列表（编号从 0 开始）输出 JSON，字段：

- normalizedName: 标准名称（模型/产品/能力的正式写法，可含英文）
- category: 从 ${CATEGORIES.join(" / ")} 中选一个；不是 AI 相关就选 broadtech
- why: 60 字内中文，一句话说明「为什么升温」，必须引用给定数据（增长率、峰值倍数、证据标题），不要空话
- 若给定 editorNote：whoPays 是真正付钱的人，entryAngle 是能开工的切入口。
  此时 why 必须同时回答「谁在为什么问题付费」，opportunities 的第一条必须落在 entryAngle 上；
  禁止写成「值得关注」「前景广阔」这类套话，读者是准备动手的创业者。
- intentSummary: 40 字内中文，说明搜索者到底想要什么
- evidence: 1-3 条，每条 {claim, claimType, date?, detail?, sourceIndexes}；
  claimType 只能是 ${CLAIMS.join(" / ")}：有来源直接支持用 fact，由数据推断用 inference，猜测用 hypothesis；
  sourceIndexes 必须来自给定证据编号，找不到依据就用 hypothesis 并给空数组
- intents: 1-3 条 {intent, queries}，intent 取 ${INTENTS.join(" / ")}；
  queries 给 2-5 个这类人真会敲的英文搜索词，不写任何占比数字——Trends 不提供意图份额，百分比一定是编的
- relatedQueries: 3-10 个相关搜索词（英文，尽量贴近真实长尾）
- competitors: 0-4 个现有产品/项目名
- oppParts: {demand, wedge, seo, feasibility, timing}，各自 0-100 的整数，
  demand=需求证据强度，wedge=可切入空间（越大越空），seo=搜索与内容机会，feasibility=独立开发可行性，timing=时机
- opportunities: 2-3 条 {type, title, why, effort, evidence}，
  type 取 ${OPP_TYPES.join(" / ")}；why 必须挂具体依据（谁在搜、竞争、用户反馈）；
  evidence 写可核对的事实，例如「HN 讨论获 865 分」「GitHub 仓库 2.8 万星」
- actions: 1-2 条 {verdict, action, reason, uncertainty}，verdict 取 ${VERDICTS.join(" / ")}

硬性要求：
1. 不要编造来源。没有依据的结论一律 claimType=hypothesis。
2. 不要输出搜索量、月搜索次数——Trends 只有 0-100 相对热度。
3. 中文描述里不要用「爆款」「颠覆」这类夸张词。
4. 禁止出现「证据 3、4」「sourceIndexes [2,6]」这类编号引用：页面上证据不编号，读者对不上；
   要写就写来源和事实本身，例如「HN 讨论获 865 分」「GitHub 仓库 2.8 万星」。
5. 禁止出现「editorNote」「entryAngle」「trendsRelatedQueries」这类内部字段名，读者不认识。
6. 描述里的每个数字都要读者能核对：不要写「意图占比 45%」这种没有数据来源的比例。
7. 只输出 JSON。`;

interface RawEnrichment {
  normalizedName?: string;
  category?: string;
  why?: string;
  intentSummary?: string;
  evidence?: Array<{
    claim?: string;
    claimType?: string;
    date?: string;
    detail?: string;
    sourceIndexes?: number[];
  }>;
  intents?: Array<{ intent?: string; share?: number; queries?: string[] }>;
  relatedQueries?: string[];
  competitors?: string[];
  oppParts?: Partial<Record<keyof OpportunityScoreParts, number>>;
  opportunities?: Array<{
    type?: string;
    title?: string;
    why?: string;
    effort?: string;
    evidence?: string;
  }>;
  actions?: Array<{ verdict?: string; action?: string; reason?: string; uncertainty?: string }>;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? clip(v.trim(), max) : "";

export async function enrichKeyword(params: {
  keyword: string;
  series: TrendSeries;
  relatedQueries: string[];
  evidence: KeywordEvidence;
  sources: TrendSourceRef[];
  /** 准入判定结果：谁付钱 + 可落地的切入口，文案必须与之对齐 */
  editor?: { audience: string; ideaAngle: string; reason: string };
}): Promise<Enrichment> {
  const { keyword, series, evidence, sources } = params;
  const m = seriesMetrics(series);

  const payload = {
    keyword,
    region: "US",
    series: {
      samples: m.samples,
      stepDays: series.stepDays,
      start: series.start,
      baseline: Math.round(m.baseline * 10) / 10,
      recent7: Math.round(m.recent7 * 10) / 10,
      growth7Pct: m.growth7,
      peak: m.peak,
      peakMultiple: m.baseline > 0 ? Math.round((m.peak / m.baseline) * 100) / 100 : null,
      aboveBaselinePoints: m.aboveBaseline,
    },
    trendsRelatedQueries: params.relatedQueries.slice(0, 10),
    evidenceIndex: sources.map((s, i) => ({
      i,
      label: s.label,
      site: s.site ?? "",
      kind: s.kind,
      publishedAt: s.publishedAt ?? "",
    })),
    hnHits: evidence.hn.map((h) => ({ title: h.title, url: h.url, detail: h.detail ?? "" })),
    repoHits: evidence.repos.map((r) => ({ title: r.title, url: r.url, detail: r.detail ?? "" })),
    editorNote: params.editor
      ? {
          whoPays: params.editor.audience,
          entryAngle: params.editor.ideaAngle,
          whyAccepted: params.editor.reason,
        }
      : null,
  };

  const raw = await chatJSON<RawEnrichment>(SYSTEM, JSON.stringify(payload), 4000);

  const category = CATEGORIES.includes(raw.category as TrendCategory)
    ? (raw.category as TrendCategory)
    : "broadtech";

  const evidenceList: TrendEvidence[] = [];
  for (const item of (raw.evidence ?? []).slice(0, 3)) {
    const claim = str(item.claim, 160);
    if (!claim) continue;
    const claimType = CLAIMS.includes(item.claimType as ClaimType)
      ? (item.claimType as ClaimType)
      : "hypothesis";
    const refs = (item.sourceIndexes ?? [])
      .filter((i) => Number.isInteger(i) && i >= 0 && i < sources.length)
      .map((i) => sources[i]);
    evidenceList.push({
      claim,
      claimType,
      ...(item.date && /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? { date: item.date } : {}),
      ...(str(item.detail, 200) ? { detail: str(item.detail, 200) } : {}),
      sources: refs,
    });
  }

  const intents: TrendIntent[] = [];
  for (const item of (raw.intents ?? []).slice(0, 3)) {
    const intent = INTENTS.includes(item.intent as TrendIntentKey)
      ? (item.intent as TrendIntentKey)
      : null;
    const queries = (item.queries ?? []).map((q) => str(q, 60)).filter(Boolean).slice(0, 6);
    if (!intent || queries.length === 0) continue;
    // 不再写 share：Trends 不提供意图份额，模型给的百分比全是估的，
    // 展示成进度条会让读者误以为是统计结果
    intents.push({ intent, queries });
  }

  const opportunities: TrendOpportunity[] = [];
  for (const item of (raw.opportunities ?? []).slice(0, 3)) {
    const title = str(item.title, 80);
    const why = str(item.why, 160);
    if (!title || !why) continue;
    const type = OPP_TYPES.includes(item.type as TrendOpportunityType)
      ? (item.type as TrendOpportunityType)
      : "content";
    opportunities.push({
      type,
      title,
      why,
      ...(str(item.effort, 30) ? { effort: str(item.effort, 30) } : {}),
      ...(str(item.evidence, 120) ? { evidence: str(item.evidence, 120) } : {}),
    });
  }

  const actions: TrendNextAction[] = [];
  for (const item of (raw.actions ?? []).slice(0, 2)) {
    const action = str(item.action, 120);
    const reason = str(item.reason, 160);
    if (!action || !reason) continue;
    actions.push({
      verdict: VERDICTS.includes(item.verdict as TrendActionVerdict)
        ? (item.verdict as TrendActionVerdict)
        : "watch",
      action,
      reason,
      ...(str(item.uncertainty, 120) ? { uncertainty: str(item.uncertainty, 120) } : {}),
    });
  }

  if (opportunities.length === 0 || actions.length === 0) {
    throw new Error("LLM 输出缺少 opportunities / actions");
  }

  return {
    normalizedName: str(raw.normalizedName, 60) || keyword,
    category,
    why: str(raw.why, 80) || `${keyword} 的搜索兴趣在近 7 天高于历史基线。`,
    intentSummary: str(raw.intentSummary, 60),
    ...(params.editor
      ? {
          editorNote: {
            audience: params.editor.audience,
            entryAngle: params.editor.ideaAngle,
            whyAccepted: params.editor.reason,
          },
        }
      : {}),
    evidence: evidenceList,
    intents,
    relatedQueries: [
      ...new Set([
        ...params.relatedQueries,
        ...(raw.relatedQueries ?? []).map((q) => str(q, 60)).filter(Boolean),
      ]),
    ].slice(0, 10),
    competitors: (raw.competitors ?? []).map((c) => str(c, 40)).filter(Boolean).slice(0, 4),
    oppParts: {
      demand: clampScore(raw.oppParts?.demand),
      wedge: clampScore(raw.oppParts?.wedge),
      seo: clampScore(raw.oppParts?.seo),
      feasibility: clampScore(raw.oppParts?.feasibility),
      timing: clampScore(raw.oppParts?.timing),
    },
    opportunities,
    actions,
  };
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}