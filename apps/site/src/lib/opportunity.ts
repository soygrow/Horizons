/**
 * 机会榜（/opportunity）：评分口径 + 证据解析 + 构建期硬闸门
 *
 * 原则：机器只做「取数 / 校验 / 渲染」，不做主观打分。
 * 分项分由人工策展写入 content/opportunities.json，但必须：
 *   1. 引用 ≥ 3 个不同榜单，且至少 1 个趋势词；
 *   2. 每个 ref 在榜单中真实存在（否则构建失败）；
 *   3. demand 分与所引用趋势词机会分均值偏差 ≤ 20（防止拍分脱离数据）。
 * 文档：docs/16-机会榜收录原则.md
 */
import { formatCount, formatDateShort } from "./format";
import type { ModelRow, RepoRow, ToolRow, TrendRow } from "./types";

export type BoardKey = "trends" | "tools" | "github" | "models";

export const BOARD_LABELS: Record<BoardKey, string> = {
  trends: "趋势词",
  tools: "AI 工具",
  github: "开源仓库",
  models: "AI 模型",
};

export const BOARD_HINTS: Record<BoardKey, string> = {
  trends: "有人在搜，说明需求正在形成",
  tools: "有人在做并且拿到了流量，说明需求被验证",
  github: "有可复用的工程实现，说明供给成本已下降",
  models: "底层能力与价格变化，决定这件事现在划不划算",
};

export const ENTRY_LABELS: Record<string, string> = {
  product: "做产品",
  opensource: "做开源 + 托管",
  service: "做服务",
  content: "做内容站",
};

export interface OppScores {
  /** 需求证据：是否有人在主动找、在付费 */
  demand: number;
  /** 供给缺口：现有供给是否已填满 */
  gap: number;
  /** 可执行性：一个人 6 周内能否做出收费版（准入项，<60 不进榜） */
  feasible: number;
  /** 时机窗口：现在做还来不来得及 */
  timing: number;
  /** 自助变现：付费方能不能不问人就自己刷卡（准入项，<50 不进榜） */
  monetize: number;
}

export const OPPORTUNITY_WEIGHTS: { key: keyof OppScores; label: string; weight: number }[] = [
  { key: "demand", label: "需求证据", weight: 0.3 },
  { key: "gap", label: "供给缺口", weight: 0.25 },
  { key: "feasible", label: "可执行性", weight: 0.2 },
  { key: "timing", label: "时机窗口", weight: 0.15 },
  { key: "monetize", label: "自助变现", weight: 0.1 },
];

/** 综合分保留 1 位小数，与趋势榜/模型榜口径一致 */
export function opportunityScore(s: OppScores): number {
  const sum = OPPORTUNITY_WEIGHTS.reduce((acc, w) => acc + w.weight * (s[w.key] ?? 0), 0);
  return Math.round(sum * 10) / 10;
}

export const GRADE_MIN = { S: 80, A: 72, B: 64 } as const;

export function gradeOf(score: number): "S" | "A" | "B" | "C" {
  if (score >= GRADE_MIN.S) return "S";
  if (score >= GRADE_MIN.A) return "A";
  if (score >= GRADE_MIN.B) return "B";
  return "C";
}

export const gradeTone: Record<string, string> = {
  S: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  A: "border-primary/40 bg-primary/10 text-primary",
  B: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  C: "border-border bg-surface-2 text-ink-muted",
};

export function scoreTone(score: number): string {
  if (score >= 76) return "text-emerald-500";
  if (score >= 68) return "text-ink";
  return "text-amber-500";
}

/* ------------------------------ 源数据结构 ------------------------------ */

export interface OppEvidence {
  board: BoardKey;
  /** 榜单主键：趋势词 slug / 工具 domain / 仓库 fullName / 模型 slug */
  ref: string;
  /** 人工判断：为什么这条证据支撑这个机会。禁止写会被数据更新打脸的硬数字。 */
  note: string;
}

export interface OppLeverage {
  kind: "open-source" | "model" | "trend" | "tool";
  ref: string;
  how: string;
}

export interface OppPhase {
  phase: string;
  name: string;
  weeks: string;
  actions: string[];
  deliverable: string;
  /** 通过标准：达不到就停，不继续投入 */
  gate: string;
}

/**
 * 一人公司适配：原则 0 的可填写部分。
 * weeks 是「单人做出能收费版本」的周数，构建期硬校验 ≤ 6。
 */
export interface OppSolo {
  /** 启动与稳定期成本，如「首月 0 美元 · 稳定期 ≤ 150 美元/月」 */
  budget: string;
  /** 单人交付周数（≤ 6，超出即出局） */
  weeks: number;
  /** 获客渠道：必须是自己能触发的，不依赖销售与投放 */
  channels: string[];
  /** 第一周三条可执行动作，写到「今天下午就能开始」的粒度 */
  firstWeek: string[];
}

export interface OppMoney {
  /** 定价，如「19 美元/月」或「29 美元/本」 */
  price: string;
  /** 谁自己刷卡（不是哪个部门审批） */
  payer: string;
  /** 前 10 个付费用户从哪来 */
  first10: string;
}

export interface OpportunitySource {
  slug: string;
  /** 批次：ISO 周，如 2026-W44。列表页只展示最新批次，其余进归档 */
  batch?: string;
  title: string;
  oneLiner: string;
  audience: string[];
  entryMode: keyof typeof ENTRY_LABELS | string;
  window: string;
  scores: OppScores;
  scoreBasis: OppScores;
  solo: OppSolo;
  money: OppMoney;
  thesis: { where: string; whyNow: string; dont: string };
  evidence: OppEvidence[];
  build: {
    form: string;
    mvpScope: string[];
    stack: string[];
    leverage: OppLeverage[];
  };
  path: OppPhase[];
  outcome: {
    targets: { metric: string; value: string }[];
    ceiling: string;
    reality: string;
  };
  risks: { risk: string; mitigation: string }[];
}

export interface OpportunityFile {
  version: string;
  updatedAt: string;
  policyDoc?: string;
  note?: string;
  opportunities: OpportunitySource[];
}

/* ------------------------------ 证据解析 ------------------------------ */

export interface EvidenceMetric {
  label: string;
  value: string;
  tone?: string;
}

/** 解析后的证据：标题/链接/实时指标全部来自榜单产物 */
export interface ResolvedEvidence extends OppEvidence {
  boardLabel: string;
  boardHint: string;
  boardHref: string;
  title: string;
  subtitle: string;
  href: string;
  metrics: EvidenceMetric[];
  /** 趋势词机会分（用于 demand 校验） */
  oppScore: number | null;
}

export interface BoardIndex {
  trendRows: TrendRow[];
  toolRows: ToolRow[];
  repoRows: RepoRow[];
  modelRows: ModelRow[];
}

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v}%`);

/** 把一条 {board, ref} 解析成可渲染的证据卡；找不到返回 null（由校验层报错） */
export function resolveEvidence(ev: OppEvidence, idx: BoardIndex): ResolvedEvidence | null {
  const base = {
    ...ev,
    boardLabel: BOARD_LABELS[ev.board],
    boardHint: BOARD_HINTS[ev.board],
    boardHref: `/${ev.board === "github" ? "github" : ev.board}`,
  };

  if (ev.board === "trends") {
    const t = idx.trendRows.find((r) => r.slug === ev.ref);
    if (!t) return null;
    return {
      ...base,
      title: t.normalizedName,
      subtitle: `${t.catLabel} · ${t.statusLabel}`,
      href: `/trends/${t.slug}`,
      metrics: [
        { label: "机会分", value: String(t.op), tone: "text-emerald-500" },
        { label: "趋势强度", value: String(t.tv) },
        { label: "近 7 天", value: t.growthText, tone: t.growthCls },
        { label: "综合分", value: t.overall.toFixed(1) },
      ],
      oppScore: t.scored ? t.op : null,
    };
  }

  if (ev.board === "tools") {
    const t = idx.toolRows.find((r) => r.domain === ev.ref);
    if (!t) return null;
    return {
      ...base,
      title: t.name,
      subtitle: t.domain,
      href: `/tools/${t.domain}`,
      metrics: [
        { label: "月访问", value: t.visits === null ? "—" : formatCount(t.visits) },
        {
          label: "环比",
          value: t.mom === null ? "—" : pct(t.mom),
          tone: t.mom === null ? "text-ink-muted" : t.mom >= 0 ? "text-accent" : "text-rose-400",
        },
        { label: "热度", value: String(t.heat) },
        { label: "分类", value: t.cats[0] ?? "—" },
      ],
      oppScore: null,
    };
  }

  if (ev.board === "github") {
    const r = idx.repoRows.find((x) => x.fullName === ev.ref);
    if (!r) return null;
    return {
      ...base,
      title: r.fullName,
      subtitle: `${r.lang ?? "—"} · ${r.license ?? "无许可"} · ${r.diff}难度`,
      href: `/github/${r.owner}/${r.repo}`,
      metrics: [
        { label: "Stars", value: formatCount(r.stars) },
        {
          label: "30 天",
          value: pct(r.g30),
          tone: r.g30 === null ? "text-ink-muted" : r.g30 >= 0 ? "text-emerald-500" : "text-rose-400",
        },
        { label: "评分", value: `${r.score.toFixed(1)} ${r.grade}` },
        { label: "活跃", value: r.pushedDaysAgo === null ? "—" : `${r.pushedDaysAgo} 天前` },
      ],
      oppScore: null,
    };
  }

  const m = idx.modelRows.find((x) => x.slug === ev.ref);
  if (!m) return null;
  return {
    ...base,
    title: m.name,
    subtitle: `${m.provider} · ${m.open ? "开源" : "闭源"} · ${m.contextText}`,
    href: `/models/${m.slug}`,
    metrics: [
      { label: "能力分", value: String(m.capability) },
      { label: "输入价", value: m.priceInText },
      { label: "输出价", value: m.priceOutText },
      { label: "性价比", value: m.value > 0 ? String(m.value) : "—" },
    ],
    oppScore: null,
  };
}

/* ------------------------------ 校验闸门 ------------------------------ */

export interface ValidateOptions {
  /** demand 分与趋势词机会分均值允许的最大偏差 */
  demandTolerance?: number;
  /** 最少跨榜数 */
  minBoards?: number;
  /** 可执行性准入线（原则 0：一人 6 周内交付） */
  minFeasible?: number;
  /** 自助变现准入线（付费方自己刷卡） */
  minMonetize?: number;
  /** 单人交付周数上限 */
  maxSoloWeeks?: number;
}

/** 返回错误列表；空数组表示通过。artifacts.ts 收到非空即中断构建。 */
export function validateOpportunities(
  file: OpportunityFile,
  idx: BoardIndex,
  opts: ValidateOptions = {},
): string[] {
  const tolerance = opts.demandTolerance ?? 20;
  const minBoards = opts.minBoards ?? 3;
  const minFeasible = opts.minFeasible ?? 60;
  const minMonetize = opts.minMonetize ?? 50;
  const maxSoloWeeks = opts.maxSoloWeeks ?? 6;
  const errors: string[] = [];

  if (!Array.isArray(file.opportunities) || !file.opportunities.length) {
    return ["opportunities 为空"];
  }
  const batchCount = new Map<string, number>();
  for (const o of file.opportunities) {
    const b = o.batch ?? "";
    batchCount.set(b, (batchCount.get(b) ?? 0) + 1);
  }
  for (const [b, n] of batchCount) {
    if (!b) errors.push("存在缺少 batch 的机会（ISO 周，如 2026-W44）");
    else if (n !== 5) errors.push(`批次 ${b} 必须固定 5 条，当前 ${n} 条`);
  }

  const slugs = new Set<string>();
  for (const o of file.opportunities) {
    const tag = o.slug || "(缺 slug)";
    if (!o.slug || !o.title || !o.oneLiner) errors.push(`${tag}：缺少 slug / title / oneLiner`);
    if (!o.batch) errors.push(`${tag}：缺少 batch（ISO 周，如 2026-W44）`);
    else if (!BATCH_PATTERN.test(o.batch)) errors.push(`${tag}：batch 格式应为 YYYY-Www，当前 ${o.batch}`);
    if (slugs.has(o.slug)) errors.push(`${tag}：slug 重复`);
    slugs.add(o.slug);

    for (const k of OPPORTUNITY_WEIGHTS) {
      const v = o.scores[k.key];
      if (typeof v !== "number" || v < 0 || v > 100) {
        errors.push(`${tag}：scores.${k.key} 必须是 0–100 的数字`);
      }
    }

    if (o.scores.feasible < minFeasible) {
      errors.push(`${tag}：可执行性 ${o.scores.feasible} 低于准入线 ${minFeasible}`);
    }
    if (o.scores.monetize < minMonetize) {
      errors.push(`${tag}：自助变现 ${o.scores.monetize} 低于准入线 ${minMonetize}`);
    }

    // 原则 0：一人公司适配（缺一项即出局）
    if (!o.solo) {
      errors.push(`${tag}：缺少 solo（一人公司适配）`);
    } else {
      if (!o.solo.budget) errors.push(`${tag}：solo.budget 缺失（启动成本必须写明）`);
      if (!(o.solo.weeks > 0) || o.solo.weeks > maxSoloWeeks) {
        errors.push(`${tag}：solo.weeks ${o.solo.weeks} 超出单人交付上限 ${maxSoloWeeks} 周`);
      }
      if (!o.solo.channels?.length) {
        errors.push(`${tag}：solo.channels 缺失（必须写明自分发获客渠道）`);
      }
      if ((o.solo.firstWeek?.length ?? 0) < 3) {
        errors.push(`${tag}：solo.firstWeek 至少 3 条第一周动作`);
      }
    }
    if (!o.money) {
      errors.push(`${tag}：缺少 money（谁掏钱、怎么收）`);
    } else {
      if (!o.money.price) errors.push(`${tag}：money.price 缺失`);
      if (!o.money.payer) errors.push(`${tag}：money.payer 缺失`);
      if (!o.money.first10) errors.push(`${tag}：money.first10 缺失（前 10 个付费用户从哪来）`);
    }

    const boards = new Set(o.evidence.map((e) => e.board));
    if (boards.size < minBoards) {
      errors.push(`${tag}：只引用了 ${boards.size} 个榜单，原则要求 ≥ ${minBoards}`);
    }
    if (!boards.has("trends")) {
      errors.push(`${tag}：缺少趋势词证据，原则要求至少 1 条需求侧信号`);
    }

    let resolved = 0;
    for (const e of o.evidence) {
      if (!BOARD_LABELS[e.board]) {
        errors.push(`${tag}：未知榜单 ${e.board}`);
        continue;
      }
      const r = resolveEvidence(e, idx);
      if (!r) errors.push(`${tag}：证据 ${e.board}/${e.ref} 在榜单中不存在`);
      else resolved++;
    }
    if (!o.evidence.length) errors.push(`${tag}：没有任何证据`);

    const trendScores = o.evidence
      .filter((e) => e.board === "trends")
      .map((e) => idx.trendRows.find((t) => t.slug === e.ref))
      .filter((t): t is TrendRow => Boolean(t) && Boolean(t?.scored))
      .map((t) => t.op);

    if (trendScores.length) {
      const avg = trendScores.reduce((a, b) => a + b, 0) / trendScores.length;
      if (Math.abs(avg - o.scores.demand) > tolerance) {
        errors.push(
          `${tag}：demand ${o.scores.demand} 与所引用趋势词机会分均值 ${avg.toFixed(1)} 偏差超过 ${tolerance}`,
        );
      }
    }

    if (!o.path?.length) errors.push(`${tag}：缺少实施路径`);
    for (const p of o.path ?? []) {
      if (!p.gate) errors.push(`${tag}：阶段 ${p.phase} 缺少通过标准（gate）`);
    }
    if ((o.risks?.length ?? 0) < 2) errors.push(`${tag}：至少需要 2 条风险与应对`);
    if (!o.outcome?.reality) errors.push(`${tag}：必须写明效果的现实边界（outcome.reality）`);
    if (resolved === 0) errors.push(`${tag}：证据全部无法解析`);
  }

  return errors;
}

/* ------------------------------ 产物构建 ------------------------------ */

export interface OpportunityRow {
  /** 批内名次（跨批次不混排） */
  rank: number;
  slug: string;
  /** 批次：ISO 周，如 2026-W44 */
  batch: string;
  /** 批次可读标题：2026 年第 44 周 */
  batchLabel: string;
  /** 批次覆盖日期：10.26 – 11.01 */
  batchRange: string;
  /** 是否最新一批（列表页只渲染最新批） */
  isLatest: boolean;
  title: string;
  oneLiner: string;
  audience: string[];
  entryMode: string;
  entryLabel: string;
  window: string;
  overall: number;
  grade: "S" | "A" | "B" | "C";
  scores: OppScores;
  /** 一人公司适配（列表页直接展示预算 / 周数 / 渠道） */
  solo: OppSolo;
  money: OppMoney;
  evidenceCount: number;
  boardCount: number;
  banners: { board: BoardKey; label: string; count: number }[];
  topEvidence: string[];
  updatedShort: string;
}

export interface OpportunityDetail extends OpportunityRow {
  scoreBasis: OppScores;
  thesis: OpportunitySource["thesis"];
  evidence: ResolvedEvidence[];
  build: OpportunitySource["build"] & { leverageLabels: { kind: string; label: string }[] };
  path: OppPhase[];
  outcome: OpportunitySource["outcome"];
  risks: OpportunitySource["risks"];
}

/** 列表页顶部的原则区块：与 docs/16-机会榜收录原则.md 同源，构建期写入产物 */
export interface OpportunityPolicy {
  title: string;
  version: string;
  intro: string;
  rules: { id: string; name: string; desc: string }[];
  formula: string;
  weights: { key: keyof OppScores; label: string; weight: number }[];
  grades: { grade: string; range: string }[];
  gates: string[];
  boards: { key: BoardKey; label: string }[];
  policyDoc: string;
  updatedAt: string;
}

export interface OpportunityBatch {
  batch: string;
  label: string;
  range: string;
  count: number;
  avgOverall: number;
  isLatest: boolean;
}

export interface OpportunityIndex {
  generatedAt: string;
  updatedAt: string;
  version: string;
  policy: OpportunityPolicy;
  total: number;
  /** 最新批次号；列表页只渲染该批次 */
  latestBatch: string;
  /** 批次汇总，按时间倒序（归档页用） */
  batches: OpportunityBatch[];
  rows: OpportunityRow[];
}

export const LEVERAGE_LABELS: Record<string, string> = {
  "open-source": "复用开源",
  model: "调用模型",
  trend: "借势趋势词",
  tool: "对标工具",
};

/* ------------------------------ 批次（ISO 周） ------------------------------ */

export const BATCH_PATTERN = /^(\d{4})-W(\d{2})$/;

/** ISO 周 → 该周周一（UTC） */
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const offset = (jan4.getUTCDay() || 7) - 1;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - offset + (week - 1) * 7);
  return monday;
}

const md = (d: Date) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

/** 2026-W44 → { label: "2026 年第 44 周", range: "2026-10-26 – 2026-11-01" } */
export function describeBatch(batch: string): { label: string; range: string } {
  const m = BATCH_PATTERN.exec(batch);
  if (!m) return { label: batch, range: "" };
  const year = Number(m[1]);
  const week = Number(m[2]);
  const start = isoWeekMonday(year, week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return {
    label: `${year} 年第 ${week} 周`,
    range: `${md(start)} – ${md(end)}`,
  };
}

export function buildOpportunityRows(file: OpportunityFile, updatedAt: string): OpportunityRow[] {
  const batchOf = (o: OpportunitySource) => o.batch ?? "";
  const latestBatch = file.opportunities.map(batchOf).sort().at(-1) ?? "";

  const ordered = [...file.opportunities].sort((a, b) => {
    const byBatch = batchOf(b).localeCompare(batchOf(a));
    if (byBatch) return byBatch;
    const sa = opportunityScore(a.scores);
    const sb = opportunityScore(b.scores);
    if (sb !== sa) return sb - sa;
    if (b.scores.gap !== a.scores.gap) return b.scores.gap - a.scores.gap;
    return b.scores.demand - a.scores.demand;
  });

  const rankCursor = new Map<string, number>();
  return ordered.map((o) => {
    const batch = batchOf(o);
    const rank = (rankCursor.get(batch) ?? 0) + 1;
    rankCursor.set(batch, rank);
    const overall = opportunityScore(o.scores);
    const boardCounts = new Map<BoardKey, number>();
    for (const e of o.evidence) boardCounts.set(e.board, (boardCounts.get(e.board) ?? 0) + 1);
    const banners = [...boardCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([board, count]) => ({ board, label: BOARD_LABELS[board], count }));

    return {
      rank,
      slug: o.slug,
      batch,
      batchLabel: describeBatch(batch).label,
      batchRange: describeBatch(batch).range,
      isLatest: batch === latestBatch,
      title: o.title,
      oneLiner: o.oneLiner,
      audience: o.audience,
      entryMode: o.entryMode,
      entryLabel: ENTRY_LABELS[o.entryMode] ?? o.entryMode,
      window: o.window,
      overall,
      grade: gradeOf(overall),
      scores: o.scores,
      solo: o.solo,
      money: o.money,
      evidenceCount: o.evidence.length,
      boardCount: boardCounts.size,
      banners,
      topEvidence: o.build.leverage.map((l) => `${LEVERAGE_LABELS[l.kind] ?? l.kind} · ${l.ref}`).slice(0, 3),
      updatedShort: formatDateShort(updatedAt),
    };
  });
}

/** 批次汇总：按批次倒序，供归档页与首页批次条使用 */
export function summarizeBatches(rows: OpportunityRow[]): OpportunityBatch[] {
  const map = new Map<string, OpportunityRow[]>();
  for (const r of rows) {
    const list = map.get(r.batch) ?? [];
    list.push(r);
    map.set(r.batch, list);
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([batch, list]) => ({
      batch,
      label: describeBatch(batch).label,
      range: describeBatch(batch).range,
      count: list.length,
      avgOverall: Math.round((list.reduce((s, r) => s + r.overall, 0) / list.length) * 10) / 10,
      isLatest: list[0]?.isLatest ?? false,
    }));
}

/**
 * 归一化一张机会卡片。
 *
 * 类型是紧的（risks 是数组、outcome 有 targets/ceiling/reality），但库里可能躺着
 * 按别的写法生成的卡片：`risks: { biggest, mitigation }`、`outcome: { success, fail }`。
 * 详情页对这些字段直接 `.map()`，形状不符会在渲染时抛 TypeError ——
 * 构建期等于让整站构建失败，预览页等于 500。
 *
 * 所以在这里补一次：能认的旧写法转成数组，认不出的留空。只补齐、不丢内容。
 */
function normalizeOpportunity(o: OpportunitySource): OpportunitySource {
  const raw = o as unknown as Record<string, unknown>;
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  const risksRaw = raw.risks as Record<string, unknown> | undefined;
  const risks = Array.isArray(risksRaw)
    ? risksRaw
    : risksRaw && typeof risksRaw === "object"
      ? [
          {
            risk: (risksRaw.risk ?? risksRaw.biggest ?? "") as string,
            mitigation: (risksRaw.mitigation ?? "") as string,
          },
        ]
      : [];

  const outcomeRaw = (raw.outcome ?? {}) as Record<string, unknown>;
  const outcome = {
    targets: asArray(outcomeRaw.targets) as { metric: string; value: string }[],
    ceiling: (outcomeRaw.ceiling ?? "") as string,
    reality: (outcomeRaw.reality ?? outcomeRaw.fail ?? "") as string,
  };

  const buildRaw = (raw.build ?? {}) as Record<string, unknown>;
  const pathRaw = asArray(raw.path) as Array<{ actions?: unknown }>;

  return {
    ...o,
    evidence: asArray(raw.evidence) as OpportunitySource["evidence"],
    solo: {
      ...(o.solo ?? ({} as OpportunitySource["solo"])),
      channels: asArray(o.solo?.channels) as string[],
      firstWeek: asArray(o.solo?.firstWeek) as string[],
    },
    build: {
      ...(o.build ?? ({} as OpportunitySource["build"])),
      mvpScope: asArray(buildRaw.mvpScope) as string[],
      stack: asArray(buildRaw.stack) as string[],
      leverage: asArray(buildRaw.leverage) as OpportunitySource["build"]["leverage"],
    },
    path: pathRaw.map((p) => ({ ...p, actions: asArray(p.actions) })) as OpportunitySource["path"],
    outcome: outcome as OpportunitySource["outcome"],
    risks: risks as OpportunitySource["risks"],
  } as OpportunitySource;
}

export function buildOpportunityDetails(
  file: OpportunityFile,
  rows: OpportunityRow[],
  idx: BoardIndex,
  updatedAt: string,
): OpportunityDetail[] {
  const rowBySlug = new Map(rows.map((r) => [r.slug, r]));
  return file.opportunities.map((rawOpp) => {
    const o = normalizeOpportunity(rawOpp);
    const row = rowBySlug.get(o.slug);
    if (!row) throw new Error(`机会 ${o.slug} 缺少列表行`);
    const evidence = o.evidence
      .map((e) => resolveEvidence(e, idx))
      .filter((e): e is ResolvedEvidence => Boolean(e));
    return {
      ...row,
      scoreBasis: o.scoreBasis,
      thesis: o.thesis,
      evidence,
      build: {
        ...o.build,
        leverageLabels: o.build.leverage.map((l) => ({
          kind: l.kind,
          label: LEVERAGE_LABELS[l.kind] ?? l.kind,
        })),
      },
      path: o.path,
      outcome: o.outcome,
      risks: o.risks,
      updatedShort: formatDateShort(updatedAt),
    };
  });
}