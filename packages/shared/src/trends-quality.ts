import { MIN_SERIES_POINTS } from "./trends-rank";
import type { AITrend } from "./types";

/**
 * 候选词的内容体检。
 *
 * 只做「这一项能不能上线」的判断，不重新打分：
 * - `empty`：压根没值，页面上是空白
 * - `fallback`：有值但等于没值（模板句、五项全 50 这种兜底）
 * - `suspect`：有值但不足以支撑判断（太短、全是推测、样本点不够）
 */

export type IssueLevel = "empty" | "fallback" | "suspect";

export interface FieldIssue {
  /** 详情页上的区块名，前端按它分组 */
  block: string;
  fields: string[];
  level: IssueLevel;
  detail: string;
}

/** enrich 在模型没给出 why 时填的兜底句，页面上看不出来，必须单独标出 */
const WHY_PLACEHOLDER = "的搜索兴趣在近 7 天高于历史基线";
const MIN_WHY_CHARS = 20;
const MIN_RELATED_QUERIES = 3;

function blank(v: string | undefined | null): boolean {
  return !v || v.trim().length === 0;
}

export function auditTrendFields(t: AITrend): FieldIssue[] {
  const out: FieldIssue[] = [];
  const add = (block: string, fields: string[], level: IssueLevel, detail: string): void => {
    out.push({ block, fields, level, detail });
  };

  const points = t.series?.values?.length ?? 0;
  if (points === 0) add("概览", ["趋势曲线"], "empty", "没有序列数据");
  else if (points < MIN_SERIES_POINTS) add("概览", ["趋势曲线"], "suspect", `只有 ${points} 个点`);

  const parts = t.trendParts;
  if (!parts || Object.values(parts).every((v) => !v)) {
    add("概览", ["趋势分解"], "empty", "五项全为 0");
  }

  const why = (t.why ?? "").trim();
  if (!why) add("为什么升温", ["why"], "empty", "没有填写");
  else if (why.includes(WHY_PLACEHOLDER)) add("为什么升温", ["why"], "fallback", "是模板兜底句");
  else if (why.length < MIN_WHY_CHARS) add("为什么升温", ["why"], "suspect", `仅 ${why.length} 字`);

  if (blank(t.intentSummary)) add("搜索意图", ["intentSummary"], "empty", "没有填写");
  if (!t.intents?.length) add("搜索意图", ["intents"], "empty", "没有意图分组");

  const ev = t.evidence ?? [];
  if (ev.length === 0) add("证据", ["evidence"], "empty", "没有证据条目");
  else if (ev.every((e) => e.claimType === "hypothesis")) {
    add("证据", ["evidence"], "suspect", "全是推测，没有可核对来源");
  }

  if (!t.opportunities?.length) add("机会", ["opportunities"], "empty", "没有机会点");
  const opp = t.oppParts;
  if (opp && [opp.demand, opp.wedge, opp.seo, opp.feasibility, opp.timing].every((v) => v === 50)) {
    add("机会", ["机会分"], "fallback", "五项都是 50，等于没打分");
  }

  if (!t.actions?.length) add("行动", ["actions"], "empty", "没有行动建议");

  const rq = t.relatedQueries ?? [];
  if (rq.length < MIN_RELATED_QUERIES) {
    add("相关查询", ["relatedQueries"], "suspect", `只有 ${rq.length} 个`);
  }

  const note = t.editorNote;
  if (!note) add("编辑注", ["editorNote"], "empty", "没有准入判断");
  else {
    const missing: string[] = [];
    if (blank(note.audience)) missing.push("受众");
    if (blank(note.entryAngle)) missing.push("切入点");
    if (blank(note.whyAccepted)) missing.push("通过理由");
    if (missing.length) add("编辑注", missing, "empty", "准入结论不完整");
  }

  return out;
}

export interface QualitySummary {
  /** 参与体检的词数 */
  audited: number;
  /** 有问题的词数 */
  dirty: number;
  /** 完全干净的词数 */
  clean: number;
  byLevel: Record<IssueLevel, number>;
  /** 按区块统计，键是区块名 */
  byBlock: Record<string, number>;
  /** 出现次数最多的前 5 个问题描述 */
  top: { label: string; count: number }[];
}

/** 把逐词的问题汇总成「哪一块最容易缺内容」，供后台顶部一行展示 */
export function summarizeQuality(items: AITrend[]): QualitySummary {
  const byLevel: Record<IssueLevel, number> = { empty: 0, fallback: 0, suspect: 0 };
  const byBlock: Record<string, number> = {};
  const counter = new Map<string, number>();
  let dirty = 0;

  for (const t of items) {
    const issues = auditTrendFields(t);
    if (issues.length > 0) dirty++;
    for (const issue of issues) {
      byLevel[issue.level]++;
      byBlock[issue.block] = (byBlock[issue.block] ?? 0) + 1;
      const label = `${issue.block} · ${issue.detail}`;
      counter.set(label, (counter.get(label) ?? 0) + 1);
    }
  }

  const top = [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  return { audited: items.length, dirty, clean: items.length - dirty, byLevel, byBlock, top };
}