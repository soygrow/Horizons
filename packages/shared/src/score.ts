import type { GitHubRepo, GitHubSnapshot, ProductScore, ScorePart } from "./types";

/**
 * 综合得分模型 pps-v2（product potential score）
 * 回答一个问题：**一个没多少经费的普通人，用这个开源项目做出「小而美、能收点钱」的产品的可能性有多大？**
 *
 * 7 个维度、权重合计 100（v2 相比 v1：把「轻启动机会」提到第一位，降低热度/增长权重）：
 *   轻启动 25   —— 一个人、一台机器、小成本能不能跑起来（越重越大的项目分越低）
 *   商业化 22   —— 许可可否商用、有无官网演示、有无商业化信号、社区是否已 Fork 验证
 *   落地门槛 15 —— 上手难度 + MVP 成本 + 出首版周期
 *   可开发性 13 —— 描述 / 标签 / 许可 / 主流语言 / README 是否齐全
 *   增长 10     —— 近 30 天是否还在涨
 *   热度 8      —— 关注度高只说明有人验证，不代表个人做得了
 *   活跃度 7    —— 最近提交、近 4 周提交、贡献者规模
 *
 * 刻意不把「有没有官网」作为门槛：没有官网的项目同样能进榜，只是商业化项少 6 分。
 */

export const SCORE_MODEL = "pps-v2";

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

/* ------------------------- 轻启动机会（pps-v2 新增） ------------------------- */

/** 重型信号：命中说明「一个人扛不动」——要集群、要运维、要算力 */
const HEAVY_TEXT =
  /\b(kubernetes|k8s|helm|terraform|kafka|spark|hadoop|flink|airflow|microservices?|distributed (training|inference)|multi-?gpu|multi-?node|slurm|ray cluster|triton|tensorrt|high availability|horizontal scal|service mesh|istio|prometheus|grafana|hpc)\b/i;

const HEAVY_TOPICS = new Set([
  "kubernetes",
  "k8s",
  "distributed-systems",
  "big-data",
  "data-engineering",
  "hadoop",
  "spark",
  "kafka",
  "microservices",
  "cloud-native",
  "mlops",
]);

/** 强轻信号：形态本身就是「一个人能做的小东西」 */
const LIGHT_STRONG =
  /\b(one[-\s]?click|vercel|netlify|railway|render|serverless|chrome extension|browser extension|telegram bot|discord bot|slack bot|wechat bot|local[-\s]?first|offline[-\s]?first|no[-\s]?code|bring your own key|free tier)\b/i;

/** 弱轻信号：只是「装起来不麻烦」，几乎所有库都满足，不该给高分 */
const LIGHT_WEAK = /\b(sqlite|docker[-\s]?compose|npx|pip install|pnpm add|single[-\s]?file)\b/i;

const STRONG_TOPICS = new Set([
  "chrome-extension",
  "browser-extension",
  "telegram-bot",
  "discord-bot",
  "slack-bot",
  "no-code",
  "serverless",
  "local-first",
  "offline",
  "tauri",
  "electron",
  "desktop-app",
]);

const WEAK_TOPICS = new Set(["cli", "sqlite", "side-project", "indie-hacker"]);

const LIGHT_FRIENDLY = new Set(["Python", "TypeScript", "JavaScript", "Dart", "Swift", "PHP", "Ruby"]);

/** 从「¥0-200/月」这类文本里取一个代表值（元） */
function parseCny(s?: string): number | null {
  if (!s) return null;
  const t = s.replace(/[,，]/g, "");
  const wan = /(\d+(?:\.\d+)?)\s*万/.exec(t);
  if (wan) return Number(wan[1]) * 10_000;
  const nums = t.match(/\d+(?:\.\d+)?/g);
  if (!nums || !nums.length) return null;
  return Math.max(...nums.map(Number));
}

/** 从「1-2 周」这类文本里取周期（周） */
function parseWeeks(s?: string): number | null {
  if (!s) return null;
  const m = /(\d+(?:\.\d+)?)\s*[-~至到]?\s*(\d+(?:\.\d+)?)?\s*(周|星期|个月|月|天|日)/.exec(s);
  if (!m) return null;
  const n = Number(m[2] ?? m[1]);
  const unit = m[3]!;
  if (unit === "月" || unit === "个月") return n * 4.3;
  if (unit === "天" || unit === "日") return n / 7;
  return n;
}

export interface LightStart {
  value: number;
  hits: string[];
  penalties: string[];
}

/**
 * 轻启动机会分（0-100）：分数越高，越适合「一个人 + 很少的钱」把它做成小而美的产品。
 * 这是 pps-v2 权重最高的维度，也是榜单「小而美优先」的依据。
 */
export function lightStartScore(repo: GitHubRepo): LightStart {
  const stars = repo.stars ?? 0;
  const topics = repo.topics ?? [];
  const text = `${repo.description ?? ""} ${topics.join(" ")} ${(repo.readme ?? "").slice(0, 4000)}`;
  const hits: string[] = [];
  const penalties: string[] = [];
  let v = 52;

  /* 1. 体量甜区：几百到几万星是「被验证过、又不是基础设施」的区间 */
  if (stars <= 1_500) {
    v += 12;
    hits.push("小而美体量");
  } else if (stars <= 5_000) {
    v += 10;
    hits.push("个人可驾驭");
  } else if (stars <= 20_000) {
    v += 8;
    hits.push("中等体量");
  } else if (stars <= 50_000) {
    v += 2;
  } else if (stars <= 100_000) {
    v -= 6;
    penalties.push("大型项目");
  } else {
    v -= 12;
    penalties.push("巨型项目");
  }

  /* 2. 重型依赖：要集群 / 运维 / 大算力的，普通人扛不住 */
  const heavyHits = [
    ...new Set((text.match(new RegExp(HEAVY_TEXT.source, "gi")) ?? []).map((s) => s.toLowerCase())),
  ];
  const heavyTopics = topics.filter((t) => HEAVY_TOPICS.has(t));
  const heavyCount = heavyHits.length + heavyTopics.length;
  if (heavyCount >= 2) {
    v -= 20;
    penalties.push(`重型依赖 ${[...heavyHits, ...heavyTopics].slice(0, 3).join("/")}`);
  } else if (heavyCount === 1) {
    v -= 9;
    penalties.push(`含重型组件 ${(heavyHits[0] ?? heavyTopics[0]) as string}`);
  }

  /* 3. 轻启动形态：插件 / 机器人 / 单机 / 一键部署（强信号），安装简单（弱信号） */
  const strongHits = [
    ...new Set((text.match(new RegExp(LIGHT_STRONG.source, "gi")) ?? []).map((s) => s.toLowerCase())),
  ];
  const strongTopics = topics.filter((t) => STRONG_TOPICS.has(t));
  const strongCount = strongHits.length + strongTopics.length;
  if (strongCount >= 2) {
    v += 14;
    hits.push(`轻形态 ${[...strongHits, ...strongTopics].slice(0, 3).join("/")}`);
  } else if (strongCount === 1) {
    v += 8;
    hits.push(`轻形态 ${(strongHits[0] ?? strongTopics[0]) as string}`);
  }

  const weakHits = [
    ...new Set((text.match(new RegExp(LIGHT_WEAK.source, "gi")) ?? []).map((s) => s.toLowerCase())),
  ];
  const weakTopics = topics.filter((t) => WEAK_TOPICS.has(t));
  if (weakHits.length + weakTopics.length > 0) {
    v += 3;
    hits.push("安装轻量");
  }

  /* 4. 情报里的真实成本：MVP 月成本 / 出首版周期 / 上手难度 */
  const cost = parseCny(repo.insight?.costToMvp);
  if (cost !== null) {
    if (cost <= 200) {
      v += 8;
      hits.push("月成本≈0");
    } else if (cost <= 1_000) {
      v += 3;
    } else if (cost > 3_000) {
      v -= 6;
      penalties.push("月成本偏高");
    }
  }
  if (/gpu|显卡|算力/i.test(repo.insight?.costToMvp ?? "")) {
    v -= 8;
    penalties.push("需要 GPU");
  }

  const weeks = parseWeeks(repo.insight?.timeToMvp);
  if (weeks !== null) {
    if (weeks <= 3) {
      v += 7;
      hits.push("首版≤3周");
    } else if (weeks <= 8) {
      v += 2;
    } else if (weeks > 12) {
      v -= 6;
      penalties.push("首版周期长");
    }
  }

  const d = repo.insight?.difficulty;
  if (d === "低") {
    v += 8;
    hits.push("上手容易");
  } else if (d === "高") {
    v -= 10;
    penalties.push("上手门槛高");
  }

  if (repo.language && LIGHT_FRIENDLY.has(repo.language)) {
    v += 4;
  }

  return { value: round1(clamp(v)), hits, penalties };
}

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

/** 等级阈值（pps-v2 按实测分布校准）：S ≥ 85（强推），A ≥ 79（值得做），B ≥ 75（可试），其余 C */
export function gradeOf(score: number): ProductScore["grade"] {
  if (score >= 85) return "S";
  if (score >= 79) return "A";
  if (score >= 75) return "B";
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
  const lightness = lightStartScore(repo);

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
      key: "light",
      label: "轻启动机会",
      weight: 25,
      value: round1(lightness.value),
      points: round1((lightness.value * 25) / 100),
      note:
        [
          lightness.hits.length ? `加分项：${lightness.hits.join("、")}` : "",
          lightness.penalties.length ? `减分项：${lightness.penalties.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("；") || "体量中等，无明显轻/重型信号",
    },
    {
      key: "heat",
      label: "需求热度",
      weight: 8,
      value: round1(heatValue),
      points: round1((heatValue * 8) / 100),
      note: `星标 ${stars.toLocaleString("en-US")}，按对数归一（20 万星标记满分）`,
    },
    {
      key: "growth",
      label: "增长动能",
      weight: 10,
      value: round1(growthValue),
      points: round1((growthValue * 10) / 100),
      note: g === null ? "历史点不足 2 个，按中性 45 分计" : `近 30 天星标 ${g >= 0 ? "+" : ""}${g.toFixed(1)}%`,
    },
    {
      key: "dev",
      label: "可开发性",
      weight: 13,
      value: round1(devValue),
      points: round1((devValue * 13) / 100),
      note: `描述 ${repo.description?.trim() ? "有" : "无"} · 标签 ${topics.length} 个 · 许可 ${
        spdx ?? "缺失"
      } · 语言 ${repo.language ?? "未知"} · README ${repo.readme ? "已采集" : "待补全"}`,
    },
    {
      key: "commercial",
      label: "商业化潜力",
      weight: 22,
      value: round1(comValue),
      points: round1((comValue * 22) / 100),
      note: `许可 ${permissive ? "可商用" : repo.license ? "需确认" : "未声明"} · 官网 ${
        repo.homepage ? "有" : "无"
      } · 商业化信号 ${hinted ? "命中" : "未命中"} · 复刻 ${forks}`,
    },
    {
      key: "active",
      label: "维护活跃度",
      weight: 7,
      value: round1(activeValue),
      points: round1((activeValue * 7) / 100),
      note: `最近提交 ${pushedDays === null ? "未知" : `${pushedDays} 天前`} · 近 4 周提交 ${recentCommits} 次 · 贡献者 ${
        contributors ?? "未采集"
      }`,
    },
    {
      key: "effort",
      label: "落地门槛",
      weight: 15,
      value: round1(effortValue),
      points: round1((effortValue * 15) / 100),
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