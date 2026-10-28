import type { GitHubRepo, GitHubSnapshot, ProductScore, ScorePart } from "./types";

/**
 * 综合得分模型 pps-v1（product potential score）
 * 回答一个问题：用这个开源项目，做出一款「能收到钱的产品」的可能性有多大？
 *
 * 6 个维度、权重合计 100：
 *   热度 15   —— 有多少人已经在关注它（星标对数归一）
 *   增长 15   —— 近 30 天是否还在涨
 *   可开发性 20 —— 描述 / 标签 / 许可 / 主流语言 / README 是否齐全
 *   商业化 30 —— 许可可否商用、有无官网演示、有无商业化信号、社区是否已 Fork 验证
 *   活跃度 10 —— 最近提交、近 4 周提交、贡献者规模
 *   落地门槛 10 —— 上手难度（越低越容易做出首版）
 *
 * 刻意不把「有没有官网」作为门槛：没有官网的项目同样能进榜，只是商业化项少 6 分。
 */

export const SCORE_MODEL = "pps-v1";

/** 热度满分参考：20 万星标 */
const HOT_CAP = 200_000;

const MAINSTREAM = new Set([
  "Python",
  "TypeScript",
  "JavaScript",
  "Go",
  "Rust",
  "Java",
  "C++",
  "C#",
  "C",
  "Kotlin",
  "Swift",
  "PHP",
  "Ruby",
  "Dart",
  "Elixir",
  "Scala",
  "Zig",
]);

const PERMISSIVE = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "MPL-2.0",
  "ISC",
  "Unlicense",
  "0BSD",
  "MIT-0",
  "CC0-1.0",
  "PostgreSQL",
  "BSL-1.0",
]);

/** 商业化信号：描述 / 标签 / README 里出现这些词，说明它能被包装成付费产品 */
const COMMERCIAL_HINT = /(api|sdk|cli|docker|self[-\s]?host|deploy|cloud|enterprise|pricing|subscription|saas|私有化|企业|商用|付费|订阅)/i;

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** 距今天数（用于「更新」列与活跃度） */
export function daysSincePush(pushedAt?: string | null): number | null {
  if (!pushedAt) return null;
  const t = Date.parse(pushedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

/** 近 N 天星标增速（%）；历史点不足返回 null */
export function growthPercent(history: GitHubSnapshot[] | undefined, days = 30): number | null {
  const list = (history ?? []).slice().sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return null;
  const last = list[list.length - 1]!;
  const target =
    list.find((p) => (Date.parse(last.date) - Date.parse(p.date)) / 86_400_000 >= days - 1) ?? list[0]!;
  if (!target.stars) return null;
  return ((last.stars - target.stars) / target.stars) * 100;
}

/** 等级阈值：S ≥ 84（强推），A ≥ 76（值得做），B ≥ 66（可试），其余 C */
export function gradeOf(score: number): ProductScore["grade"] {
  if (score >= 84) return "S";
  if (score >= 76) return "A";
  if (score >= 66) return "B";
  return "C";
}

export const GRADE_LABEL: Record<ProductScore["grade"], string> = {
  S: "强推：现在就能开工",
  A: "值得做：方向清楚",
  B: "可试：需要找到切口",
  C: "谨慎：更适合练手",
};

export function computeProductScore(repo: GitHubRepo): ProductScore {
  const stars = repo.stars ?? 0;
  const forks = repo.forks ?? 0;
  const topics = repo.topics ?? [];
  const pushedDays = daysSincePush(repo.pushedAt);
  const g = growthPercent(repo.history, 30);
  const spdx = repo.license?.spdx;
  const permissive = !!spdx && PERMISSIVE.has(spdx);

  /* 1. 热度 15：对数归一 */
  const heatValue = clamp((Math.log10(stars + 1) / Math.log10(HOT_CAP)) * 100);

  /* 2. 增长 15：近 30 天增速，0% 记 35 分，25% 记 90 分 */
  const growthValue = g === null ? 45 : clamp(35 + g * 2.2);

  /* 3. 可开发性 20 */
  let dev = 0;
  if (repo.description?.trim()) dev += 4;
  dev += topics.length >= 5 ? 4 : topics.length >= 2 ? 3 : topics.length >= 1 ? 2 : 0;
  if (repo.license) dev += 4;
  if (repo.language && MAINSTREAM.has(repo.language)) dev += 4;
  dev += repo.readme ? 4 : 2;
  const devValue = Math.min(dev, 20) * 5; // 折算到 0-100

  /* 4. 商业化 30 */
  let com = 0;
  if (permissive) com += 10;
  else if (repo.license) com += 4;
  if (repo.homepage) com += 6;
  const text = `${repo.description ?? ""} ${topics.join(" ")} ${(repo.readme ?? "").slice(0, 3000)}`;
  const hinted = COMMERCIAL_HINT.test(text);
  if (hinted) com += 8;
  if (forks >= 100) com += 6;
  else if (forks >= 20) com += 3;
  else if (forks >= 5) com += 1;
  const comValue = (Math.min(com, 30) / 30) * 100;

  /* 5. 活跃度 10 */
  let active = 0;
  if (pushedDays !== null) {
    if (pushedDays <= 30) active += 4;
    else if (pushedDays <= 90) active += 2;
  }
  const recentCommits = (repo.commitActivity ?? []).slice(-4).reduce((a, b) => a + b, 0);
  if (recentCommits > 0) active += 3;
  else if (pushedDays !== null && pushedDays <= 90) active += 1;
  const contributors = repo.contributorsCount;
  if (contributors === undefined) active += 1;
  else if (contributors >= 50) active += 3;
  else if (contributors >= 10) active += 2;
  else active += 1;
  const activeValue = (Math.min(active, 10) / 10) * 100;

  /* 6. 落地门槛 10：难度越低，越容易做出首版 */
  const difficulty = repo.insight?.difficulty;
  const effort = difficulty === "低" ? 10 : difficulty === "高" ? 3 : difficulty === "中" ? 6 : 5;
  const effortValue = effort * 10;

  const parts: ScorePart[] = [
    {
      key: "heat",
      label: "需求热度",
      weight: 15,
      value: round1(heatValue),
      points: round1((heatValue * 15) / 100),
      note: `星标 ${stars.toLocaleString("en-US")}，按对数归一（20 万星标记满分）`,
    },
    {
      key: "growth",
      label: "增长动能",
      weight: 15,
      value: round1(growthValue),
      points: round1((growthValue * 15) / 100),
      note: g === null ? "历史点不足 2 个，按中性 45 分计" : `近 30 天星标 ${g >= 0 ? "+" : ""}${g.toFixed(1)}%`,
    },
    {
      key: "dev",
      label: "可开发性",
      weight: 20,
      value: round1(devValue),
      points: round1((devValue * 20) / 100),
      note: `描述 ${repo.description?.trim() ? "有" : "无"} · 标签 ${topics.length} 个 · 许可 ${
        spdx ?? "缺失"
      } · 语言 ${repo.language ?? "未知"} · README ${repo.readme ? "已采集" : "待补全"}`,
    },
    {
      key: "commercial",
      label: "商业化潜力",
      weight: 30,
      value: round1(comValue),
      points: round1((comValue * 30) / 100),
      note: `许可 ${permissive ? "可商用" : repo.license ? "需确认" : "未声明"} · 官网 ${
        repo.homepage ? "有" : "无"
      } · 商业化信号 ${hinted ? "命中" : "未命中"} · 复刻 ${forks}`,
    },
    {
      key: "active",
      label: "维护活跃度",
      weight: 10,
      value: round1(activeValue),
      points: round1((activeValue * 10) / 100),
      note: `最近提交 ${pushedDays === null ? "未知" : `${pushedDays} 天前`} · 近 4 周提交 ${recentCommits} 次 · 贡献者 ${
        contributors ?? "未采集"
      }`,
    },
    {
      key: "effort",
      label: "落地门槛",
      weight: 10,
      value: round1(effortValue),
      points: round1((effortValue * 10) / 100),
      note: `上手难度 ${difficulty ?? "未知"}（越低越容易做出首版）`,
    },
  ];

  const score = round1(parts.reduce((s, p) => s + p.points, 0));
  const grade = gradeOf(score);
  const top = [...parts].sort((a, b) => b.points - a.points)[0]!;
  const weak = [...parts].sort((a, b) => a.points - b.points)[0]!;

  return {
    score,
    grade,
    summary: `${GRADE_LABEL[grade]}。${top.label}最强，${weak.label}是短板。`,
    parts,
    model: SCORE_MODEL,
    computedAt: new Date().toISOString(),
  };
}

/** 榜单排序：综合得分 → 星标 → 名称 */
export function compareByScore(a: GitHubRepo, b: GitHubRepo): number {
  const sa = a.productScore?.score ?? computeProductScore(a).score;
  const sb = b.productScore?.score ?? computeProductScore(b).score;
  return sb - sa || b.stars - a.stars || a.fullName.localeCompare(b.fullName);
}