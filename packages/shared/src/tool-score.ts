import type { AITool } from "./types";

/**
 * 综合得分模型 tps-v1（tool potential score）
 * 回答一个问题：这个 AI 工具站现在值不值得研究、能不能做成生意？
 *
 * 6 个维度，权重合计 100：
 *   规模 30     —— 月访问量（对数归一，10 万记满分）
 *   增长 20     —— 月环比增长（0% 记 50 分，+50% 记 100 分，-50% 记 0 分）
 *   搜索健康 15 —— 自然搜索占比（0% 记 20 分，40% 记 100 分）
 *   外部热度 15 —— Product Hunt 票数 / GitHub 星标（heatScore 现状值）
 *   域名权重 10 —— Ahrefs DR
 *   机会分 10   —— 大模型 opportunity.score（主观项，上限 10%，不主导排序）
 *
 * 缺失维度不罚底：按「可用维度的权重」重新归一，避免没采集到流量的站直接掉到榜尾。
 * 有效维度少于 2 个时封顶 55 分，防止只有单一热度信号的站虚高。
 */

export const TOOL_SCORE_MODEL = "tps-v1";

/** 规模满分参考：10 万月访问 */
const VISIT_CAP = 100_000;

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

export type ToolScoreKey = "scale" | "growth" | "seo" | "heat" | "rank" | "opp";

export interface ToolScorePart {
  key: ToolScoreKey;
  label: string;
  weight: number; // 权重（满分 100 中的占比）
  value: number; // 该项归一值 0-100
  points: number; // 该项实际贡献分
  note: string; // 判定依据
}

export interface ToolScore {
  score: number; // 综合分 0-100
  parts: ToolScorePart[]; // 实际算进得分的维度（缺失项不在其中）
  coverage: number; // 有效维度数
  weightUsed: number; // 参与归一的权重和
  model: string;
}

/* ------------------------------ 取值（数据源优先级与页面一致） ------------------------------ */

/** 月访问量：Similarweb(vortex) 优先，回退 DFS */
function monthlyVisitsOf(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisits ?? tool.metrics?.monthlyVisits;
}

/** 月环比增长 %：vortex 优先，回退 DFS */
function momGrowthOf(tool: AITool): number | undefined {
  return tool.trafficMetrics?.monthlyVisitsGrowth ?? tool.metrics?.momGrowth;
}

/** 自然搜索占比 %：metrics.organicShare 优先，否则用自然搜索量 / 月访问量推算 */
function organicShareOf(tool: AITool): number | undefined {
  if (tool.metrics?.organicShare !== undefined) return tool.metrics.organicShare;
  const organic =
    tool.trafficMetrics?.organicSearchVisits ?? tool.metrics?.organicVisits;
  const visits = monthlyVisitsOf(tool);
  if (organic !== undefined && visits && visits > 0) return (organic / visits) * 100;
  return undefined;
}

/* ------------------------------ 主函数 ------------------------------ */

export function computeToolScore(tool: AITool): ToolScore {
  const visits = monthlyVisitsOf(tool);
  const growth = momGrowthOf(tool);
  const share = organicShareOf(tool);
  const heat = typeof tool.heatScore === "number" ? tool.heatScore : undefined;
  const grank = tool.ranks?.global;
  const opp = tool.opportunity?.score;

  const raw: Omit<ToolScorePart, "points">[] = [];

  /* 1. 规模 30：对数归一，10 万月访问记满分 */
  if (visits !== undefined && visits > 0) {
    const value = clamp((Math.log10(visits + 1) / Math.log10(VISIT_CAP)) * 100);
    raw.push({
      key: "scale",
      label: "用户规模",
      weight: 30,
      value: round1(value),
      note: `月访问 ${visits.toLocaleString("en-US")}（10 万记满分）`,
    });
  }

  /* 2. 增长 20：0% 记 50 分，斜率 1 */
  if (growth !== undefined) {
    raw.push({
      key: "growth",
      label: "增长动能",
      weight: 20,
      value: round1(clamp(50 + growth)),
      note: `月环比 ${growth >= 0 ? "+" : ""}${growth}%`,
    });
  }

  /* 3. 搜索健康 15：0% 占 20 分，40% 占 100 分 */
  if (share !== undefined) {
    raw.push({
      key: "seo",
      label: "搜索健康度",
      weight: 15,
      value: round1(clamp(20 + share * 2)),
      note: `自然搜索占比 ${share.toFixed(1)}%`,
    });
  }

  /* 4. 外部热度 15：直接用 heatScore（PH 票数 / GitHub 星标归一结果） */
  if (heat !== undefined) {
    raw.push({
      key: "heat",
      label: "外部热度",
      weight: 15,
      value: round1(clamp(heat)),
      note: tool.phUpvotes
        ? `Product Hunt ${tool.phUpvotes.toLocaleString("en-US")} 票`
        : tool.githubStars
          ? `GitHub ${tool.githubStars.toLocaleString("en-US")} 星`
          : "热度分",
    });
  }

  /*
   * 5. 全球排名 10：原来用 Ahrefs/DFS 的 DR，数据源下线后存量值会永久冻结，
   *    改用 SimilarWeb 全球排名。排名越小越强，所以按对数反比换算，方向不能反。
   */
  if (typeof grank === "number" && grank > 0) {
    // 第 1 名 100 分，每放大 10 倍扣 20 分。
    // 排名 10 万以外换算为负，按「缺失维度不罚底」原则不计入。
    const normalized = 100 - 20 * Math.log10(Math.max(grank, 1));
    if (normalized > 0) {
      raw.push({
        key: "rank",
        label: "全球排名",
        weight: 10,
        value: round1(clamp(normalized)),
        note: `SimilarWeb 全球排名第 ${grank.toLocaleString("en-US")}`,
      });
    }
  }

  /* 6. 机会分 10：大模型主观判断，权重封顶 10% */
  if (typeof opp === "number") {
    raw.push({
      key: "opp",
      label: "机会评分",
      weight: 10,
      value: round1(clamp(opp)),
      note: tool.opportunity?.verdict
        ? `大模型判定「${tool.opportunity.verdict}」`
        : "大模型机会评分",
    });
  }

  const weightUsed = raw.reduce((s, p) => s + p.weight, 0);
  const weighted = raw.reduce((s, p) => s + p.value * p.weight, 0);
  let score = weightUsed > 0 ? weighted / weightUsed : 0;
  // 只有单一维度时信号太弱，封顶 55，避免「纯热度分」冲榜
  if (raw.length < 2) score = Math.min(score, 55);

  return {
    score: round1(score),
    parts: raw.map((p) => ({ ...p, points: round1((p.value * p.weight) / 100) })),
    coverage: raw.length,
    weightUsed,
    model: TOOL_SCORE_MODEL,
  };
}

/**
 * 榜单排序：综合得分 → 外部热度 → 域名。
 * 后两级只用于同分时的稳定排序，保证每次构建顺序一致。
 */
export function compareByToolScore(a: AITool, b: AITool): number {
  const d = computeToolScore(b).score - computeToolScore(a).score;
  if (d !== 0) return d;
  const h = (b.heatScore ?? 0) - (a.heatScore ?? 0);
  if (h !== 0) return h;
  return a.domain.localeCompare(b.domain);
}