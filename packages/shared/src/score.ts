import type { GitHubRepo, GitHubSnapshot, ProductScore, ScorePart } from "./types";

/**
 * 综合得分模型 pps-v3（product potential score）
 * 回答一个问题：**一个没多少经费的普通人，用这个开源项目做出「小而美、能收点钱」的产品的可能性有多大？**
 *
 * v3 相对 v2 的修正（v2 的实测问题：可开发性 83% 满分、商业化 59% 满分、增长动能标准差仅 0.23，
 * 三个维度基本是常数，真正区分排名的只剩「轻启动」和「商业化」两项）：
 *
 *  1. **官网不再代表商业化**：有官网只加 4 分且区分「自定义域名(4) / 文档托管(1)」，
 *     明确写进判定依据——官网只是「作者有对外门面」，不等于有人愿意付钱；
 *  2. **付费意图信号收紧**：v2 的 /api|sdk|cli|docker|deploy/ 命中率 88%，等于没有信息量，
 *     v3 只认 pricing / subscription / enterprise / self-host / 私有化 / 商用授权 这类付费词；
 *  3. **fork 绝对数不再算商业化**：门槛已要求 forks≥40，且高星项目 93% 都 ≥100，
 *     v3 改用 fork/star 比（有没有人真的拿它当底座做产品），并挪到「需求验证」维度；
 *  4. **新增「需求验证」维度**：热度饱和归一（1 万星即满，不再拿 20 万星当满分——
 *     对个人开发者，20 万星是红海不是机会）+ fork/star 比 + issue 活跃度；
 *  5. **增长动能只认真实采样**：history 里 synthetic=true 的估算点不参与计算，
 *     无真实数据时按中性 50 计并明确标注，权重从 10 降到 8；
 *  6. **可开发性改为质量分**：v2 只要「五个都有」就满分（83% 满分），
 *     v3 要求描述足够长、标签≥5、README≥2000 字符，才有区分度；
 *  7. **落地门槛加入客观项**：不再只信 LLM 给的 difficulty，叠加体量吃透难度、外部成本、首版周期。
 *
 * 维度与权重（合计 100）：
 *   轻启动机会 22 —— 一个人、一台机器、小成本能不能跑起来（越重越大的项目分越低）
 *   加工空间   18 —— 加工之后能不能做出跟它不一样的东西（它已是成品则低，LLM 判断）
 *   商业化潜力 14 —— 许可能否商用、这个领域有没有人付钱、作者有没有对外门面
 *   落地门槛   13 —— 上手难度 + 体量吃透 + 外部成本 + 出首版周期
 *   需求验证   12 —— 真有人要它（热度饱和 + fork/star 比 + issue 活跃）
 *   可开发性    7 —— 描述/标签/许可/语言/README 的完整度与质量
 *   维护活跃度  7 —— 最近提交、近 4 周提交、贡献者规模（能不能长期依赖）
 *   增长动能    7 —— 近 30 天真实星标增速（无真实采样则中性）
 *
 * 刻意不把「有没有官网」作为门槛：没有官网的项目同样能进榜，只是商业化项少 4 分。
 */

export const SCORE_MODEL = "pps-v3";

/** 热度满分参考：1 万星。对「一个人做产品」来说，1 万星已经完成市场验证，再往上只是红海 */
const DEMAND_CAP = 10_000;

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

/**
 * 付费需求信号：只有出现「定价 / 订阅 / 企业版 / 商用授权」这类**收费行为**才算数。
 *
 * v2 用 /api|sdk|cli|docker|deploy/，命中率 88%——几乎所有项目都中，等于白送分。
 * v3 第一版又用了 `plans?`，结果 AI 项目里的「agent plans / 执行计划」大量误命中
 * （tomasz-tomczyk/crit 的 "Review your coding agent's plans" 被判成付费订阅）。
 * 因此 v3 明确排除 plans / price / self-host / managed 这类歧义词。
 */
const PAY_HINT =
  /\b(pricing|subscription|subscribe|billing|invoice|paid plan|pro plan|team plan|enterprise (edition|version|plan|licen[cs]e|support)|commercial (licen[cs]e|edition)|licen[cs]e key)\b|私有化部署|企业版|商用授权|商业授权|付费订阅|按量计费|团队版|企业服务/i;

/** 可以作为「底座」被二次开发的形态：库 / SDK / API / 插件 / CLI */
const EMBEDDABLE =
  /\b(library|sdk|api|framework|plugin|plugins?|extension|cli|command[-\s]?line|wrapper|adapter|binding|middleware|engine|toolkit|protocol|server)\b/i;

/** 文档/托管站：有链接但没有独立门面，只能算「有个说明页」，不能当商业化证据 */
const DOCS_HOST =
  /(github\.io|github\.com|gitlab\.io|readthedocs|gitbook|notion\.(site|so)|vercel\.app|netlify\.app|pages\.dev|surge\.sh|glitch\.me)/i;

const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------- 轻启动机会 ------------------------- */

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
const LIGHT_WEAK = /\b(sqlite|docker[-\s]compose|npx|pip install|pnpm add|single[-\s]?file)\b/i;

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

/** 情报来自本地模板时，其中的 difficulty / cost / 周期都是猜的，不可用于打分 */
function insightTrusted(repo: GitHubRepo): boolean {
  const src = repo.insightSource ?? "";
  return !src.includes("local") && !src.includes("fallback");
}

export interface LightStart {
  value: number;
  hits: string[];
  penalties: string[];
}

/**
 * 轻启动机会分（0-100）：分数越高，越适合「一个人 + 很少的钱」把它做成小而美的产品。
 * 这是 pps-v3 权重最高的维度，也是榜单「小而美优先」的依据。
 */
export function lightStartScore(repo: GitHubRepo): LightStart {
  const stars = repo.stars ?? 0;
  const topics = repo.topics ?? [];
  const text = `${repo.description ?? ""} ${topics.join(" ")} ${(repo.readme ?? "").slice(0, 4000)}`;
  const trusted = insightTrusted(repo);
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

  /* 4. 情报里的真实成本：MVP 月成本 / 出首版周期 / 上手难度（模板兜底的情报不算） */
  if (trusted) {
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
  }

  if (/gpu|显卡|算力/i.test(repo.insight?.costToMvp ?? "")) {
    v -= 8;
    penalties.push("需要 GPU");
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

/**
 * 近 N 天星标增速（%）。
 * 只使用真实采样点：synthetic=true 的回填点会被剔除；
 * 剔除后不足 2 个真实点返回 null（前端显示「暂无真实历史」，不编造增速）。
 */
export function growthPercent(history: GitHubSnapshot[] | undefined, days = 30): number | null {
  const list = (history ?? [])
    .filter((p) => !p.synthetic)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (list.length < 2) return null;
  const last = list[list.length - 1]!;
  const target =
    list.find((p) => (Date.parse(last.date) - Date.parse(p.date)) / 86_400_000 >= days - 1) ?? list[0]!;
  if (!target.stars) return null;
  const span = (Date.parse(last.date) - Date.parse(target.date)) / 86_400_000;
  if (span < 7) return null; // 采样跨度太短，年化后全是噪音
  return ((last.stars - target.stars) / target.stars) * 100;
}

/**
 * 等级阈值（pps-v4 按 1500 条实测分布校准，约对应 前 2% / 前 21% / 前 57%）：
 * S ≥ 79（强推），A ≥ 74（值得做），B ≥ 68（可试），其余 C。
 *
 * C 档占比高不是因为门槛松，而是因为「加工空间」把大量已经做成成品、
 * 拿来做只会照抄原样的项目降了权——这类项目本就不该推荐给人做。
 */
export function gradeOf(score: number): ProductScore["grade"] {
  if (score >= 79) return "S";
  if (score >= 74) return "A";
  if (score >= 68) return "B";
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
  const openIssues = repo.openIssues ?? 0;
  const topics = repo.topics ?? [];
  const readme = repo.readme ?? "";
  const pushedDays = daysSincePush(repo.pushedAt);
  const g = growthPercent(repo.history, 30);
  const spdx = repo.license?.spdx;
  const permissive = !!spdx && PERMISSIVE.has(spdx);
  const lightness = lightStartScore(repo);
  const trusted = insightTrusted(repo);

  /* ---- 轻启动 25 ---- */
  const lightValue = lightness.value;

  /* ---- 商业化 14：许可 6 + 领域有付费需求 4 + 向外的门面 4 ----
     这里只回答「法律允许吗 / 这个领域有人付钱吗 / 作者有没有把项目当回事」。
     「能不能当底座」与「是不是成品」已移到「加工空间」，不再重复计分。 */
  let com = 0;
  if (permissive) com += 6;
  else if (repo.license) com += 3;

  const allText = `${repo.description ?? ""} ${topics.join(" ")} ${readme.slice(0, 3000)}`;
  const paidHint = PAY_HINT.test(allText);
  if (paidHint) com += 4;

  const homepage = repo.homepage?.trim() ?? "";
  const docsOnly = homepage ? DOCS_HOST.test(homepage) : false;
  if (homepage && !docsOnly) com += 4;
  else if (homepage) com += 1;

  const comValue = clamp((Math.min(com, 14) / 14) * 100);

  /* ---- 加工空间 18：它是不是已经做完了 ----
     读者要的是「加工出不一样的产品」，所以项目越像个成品，照抄价值越低。
     这一项由 LLM 读 README 判断（正则做不到：api/cli/sdk 命中率 92%），
     未评估时按中性 5/10 计，避免无数据项目被误判。 */
  const dv = repo.derivative;
  const derivScore = dv ? clamp(dv.space * 10, 0, 100) : 50;
  const derivValue = derivScore;

  /* ---- 落地门槛 13：难度 6 + 体量吃透 4 + 外部成本 2 + 首版周期 1 ---- */
  let effortPts = 0;
  const difficulty = trusted ? repo.insight?.difficulty : undefined;
  effortPts += difficulty === "低" ? 6 : difficulty === "高" ? 1 : 3;
  if (stars <= 2_000) effortPts += 4;
  else if (stars <= 10_000) effortPts += 3;
  else if (stars <= 50_000) effortPts += 1;
  const costText = repo.insight?.costToMvp ?? "";
  const needsPaidInfra = /gpu|显卡|算力|付费|api key|token 费|云服务/i.test(costText);
  if (!needsPaidInfra) effortPts += 2;
  const weeks = parseWeeks(repo.insight?.timeToMvp ?? "");
  effortPts += weeks !== null && weeks <= 3 ? 1 : 0;
  const effortValue = (effortPts / 13) * 100;

  /* ---- 需求验证 12：热度饱和 6 + fork/star 比 4 + issue 活跃 2 ---- */
  let demandPts = 0;
  demandPts += clamp((Math.log10(stars + 1) / Math.log10(DEMAND_CAP)) * 6, 0, 6);
  const forkRatio = stars > 0 ? forks / stars : 0;
  demandPts += forkRatio >= 0.12 ? 4 : forkRatio >= 0.06 ? 3 : forkRatio >= 0.03 ? 1 : 0;
  demandPts += openIssues >= 50 ? 2 : openIssues >= 20 ? 1 : 0;
  const demandValue = (demandPts / 12) * 100;

  /* ---- 可开发性 7：描述 1 + 标签 1 + 许可 1 + 语言 2 + README 2 ---- */
  let devPts = 0;
  const desc = repo.description?.trim() ?? "";
  if (desc.length >= 40) devPts += 1;
  if (topics.length >= 5) devPts += 1;
  if (repo.license) devPts += 1;
  if (repo.language && MAINSTREAM.has(repo.language)) devPts += 2;
  if (readme.length >= 2_000) devPts += 2;
  else if (readme.length > 0) devPts += 1;
  const devValue = (devPts / 7) * 100;

  /* ---- 维护活跃度 7：最近提交 3 + 近 4 周提交 3 + 贡献者 1 ---- */
  let activePts = 0;
  if (pushedDays !== null) {
    if (pushedDays <= 30) activePts += 3;
    else if (pushedDays <= 90) activePts += 1.5;
  }
  /* commitActivity 缺失（约 1/3 项目未抓到 /stats/participation）按中性计，
     否则这些项目会被当成「近 4 周零提交」白扣分 */
  const hasCommitStats = Array.isArray(repo.commitActivity) && repo.commitActivity.length > 0;
  const recentCommits = hasCommitStats
    ? (repo.commitActivity as number[]).slice(-4).reduce((a, b) => a + b, 0)
    : null;
  if (recentCommits === null) activePts += 2;
  else if (recentCommits > 0) activePts += 3;
  else if (pushedDays !== null && pushedDays <= 90) activePts += 1;
  const contributors = repo.contributorsCount;
  if (contributors !== undefined && contributors >= 10) activePts += 1;
  const activeValue = (Math.min(activePts, 7) / 7) * 100;

  /* ---- 增长动能 8：只认真实采样；没有就中性 50，不编造 ---- */
  const growthValue = g === null ? 50 : clamp(20 + (g + 5) * 2.67);

  const parts: ScorePart[] = [
    {
      key: "light",
      label: "轻启动机会",
      weight: 22,
      value: round1(lightValue),
      points: round1((lightValue * 22) / 100),
      note:
        [
          lightness.hits.length ? `加分项：${lightness.hits.join("、")}` : "",
          lightness.penalties.length ? `减分项：${lightness.penalties.join("、")}` : "",
        ]
          .filter(Boolean)
          .join("；") || "体量中等，无明显轻/重型信号",
    },
    {
      key: "derivative",
      label: "加工空间",
      weight: 18,
      value: round1(derivValue),
      points: round1((derivValue * 18) / 100),
      note: dv
        ? [
            `形态 ${dv.base}`,
            dv.occupancy ? `已占住「${dv.occupancy}」` : "尚未占住具体产品场景",
            dv.hook ? `接入点 ${dv.hook}` : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : "未评估，按中性 5/10 计",
    },
    {
      key: "commercial",
      label: "商业化潜力",
      weight: 14,
      value: round1(comValue),
      points: round1((comValue * 14) / 100),
      note: [
        `许可 ${permissive ? "可商用" : repo.license ? "需确认条款" : "未声明"}`,
        `领域付费需求 ${paidHint ? "有" : "未发现"}`,
        `官网 ${homepage ? (docsOnly ? "仅文档/托管页" : "独立域名") : "无"}`,
      ].join(" · "),
    },
    {
      key: "effort",
      label: "落地门槛",
      weight: 13,
      value: round1(effortValue),
      points: round1((effortValue * 13) / 100),
      note: [
        `上手难度 ${difficulty ?? (trusted ? "未知" : "情报为模板，未采信")}`,
        `体量 ${stars.toLocaleString("en-US")} 星`,
        needsPaidInfra ? "需付费基础设施" : "无需额外付费资源",
        weeks !== null ? `首版 ${repo.insight?.timeToMvp}` : "首版周期未知",
      ].join(" · "),
    },
    {
      key: "demand",
      label: "需求验证",
      weight: 12,
      value: round1(demandValue),
      points: round1((demandValue * 12) / 100),
      note: `热度 ${stars.toLocaleString("en-US")} 星（1 万星即视为验证完成） · fork/star ${(forkRatio * 100).toFixed(1)}% · 未结 issue ${openIssues}`,
    },
    {
      key: "dev",
      label: "可开发性",
      weight: 7,
      value: round1(devValue),
      points: round1((devValue * 7) / 100),
      note: `描述 ${desc.length} 字符 · 标签 ${topics.length} 个 · 许可 ${spdx ?? "缺失"} · 语言 ${
        repo.language ?? "未知"
      } · README ${readme.length} 字符`,
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
      key: "growth",
      label: "增长动能",
      weight: 7,
      value: round1(growthValue),
      points: round1((growthValue * 7) / 100),
      note:
        g === null
          ? "暂无真实采样（榜单 2026-10 起逐日记录，满 7 天后才有增速），按中性 50 计"
          : `近 30 天星标 ${g >= 0 ? "+" : ""}${g.toFixed(1)}%（真实采样）`,
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