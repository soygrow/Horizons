/**
 * 机会榜按批次生成（生成 / 拒绝补位共用一条路径）。
 *
 *   pnpm opps:generate --batch 2026-W47            # 生成 5 条候选
 *   pnpm opps:generate --batch 2026-W47 --fill     # 拒绝 1 条后补 1 条
 *   pnpm opps:generate --batch 2026-W47 --dry       # 只看 prompt 规模，不调模型
 *
 * 为什么逐条生成而不是一次出 5 条：
 * 拒绝补位的常态是「其余 4 条都留着，只换第 3 条」，逐条生成让正常生成和补位
 * 走完全相同的代码路径；同时每条都能把已经选中的标题喂回去，从源头压住重复。
 *
 * 产物两处：
 *   content/opportunities-staging.json  仓库留档，便于 diff 与回看
 *   D1 board_items(board=opps)          后台预览读这里（Worker 读不到仓库文件）
 *
 * 证据必须是四个榜单的真实主键 —— 构建期会逐个回查，引用不存在的 slug
 * 会让整次构建失败，所以这里先生成前拦住，别把问题留给构建。
 */
import "../config"; // 副作用导入：本地运行时加载 .env.local 里的 DEEPSEEK_API_KEY

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { syncCandidates } from "../../admin/board-items";
import { chatJSON } from "../sources/llm";

const ROOT = process.cwd();
const STAGING = join(ROOT, "content/opportunities-staging.json");
const CONTENT = join(ROOT, "content/opportunities.json");
const POLICY = join(ROOT, "docs/16-机会榜收录原则.md");

const DEFAULT_MODEL = "deepseek-v4-pro";
const BATCH_RE = /^\d{4}-W\d{2}$/;

interface Args {
  batch: string;
  count: number;
  fill: boolean;
  reason: string;
  exclude: string[];
  model: string;
  dry: boolean;
  writeD1: boolean;
}

function parseArgs(argv: string[]): Args {
  const pick = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  /**
   * 命令行优先，其次环境变量。
   *
   * 走环境变量是因为 GitHub Actions 里拼 base64/引号很容易被拒绝原因里的
   * 引号、换行打断 —— 让 shell 原样把 OPPS_REASON 交进来，省掉一层转义。
   */
  const fromArgOrEnv = (arg: string, env: string): string =>
    (pick(arg) ?? process.env[env] ?? "").trim();

  const batch = fromArgOrEnv("batch", "OPPS_BATCH");
  if (!BATCH_RE.test(batch)) {
    throw new Error(`批次号必须是 YYYY-Www 形式（例：2026-W47），收到「${batch}」`);
  }

  const fill = argv.includes("--fill") || process.env.OPPS_FILL === "true";
  const count = Number(fromArgOrEnv("count", "OPPS_COUNT") || (fill ? 1 : 5));
  return {
    batch,
    count: Number.isFinite(count) && count > 0 ? Math.min(count, 5) : 5,
    fill,
    reason: fromArgOrEnv("reason", "OPPS_REASON").slice(0, 300),
    exclude: fromArgOrEnv("exclude", "OPPS_EXCLUDE")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    model: pick("model") || process.env.OPPS_MODEL || DEFAULT_MODEL,
    dry: argv.includes("--dry"),
    writeD1: !argv.includes("--no-d1"),
  };
}

/* ----------------------------- 榜单素材 ----------------------------- */

interface TrendRow {
  slug: string;
  keyword: string;
  normalizedName?: string;
  category?: string;
  status?: string;
  why?: string;
  confidence?: string;
  updatedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  editorNote?: { audience?: string; entryAngle?: string; whyAccepted?: string };
}
interface ToolRow {
  id: string;
  name: string;
  domain: string;
  description?: string;
  categories?: string[];
  heatScore?: number;
  collectedAt?: string;
  firstSeenAt?: string;
  trafficMetrics?: { monthlyVisits?: number; monthlyVisitsGrowth?: number };
  opportunity?: { score?: number; verdict?: string; reason?: string };
  ideaSparks?: Array<{ title?: string }>;
}
interface RepoRow {
  fullName: string;
  description?: string;
  stars?: number;
  starsGrowth?: number;
  language?: string;
  lastCrawledAt?: string;
  pushedAt?: string;
  productScore?: { score?: number; grade?: string };
  derivative?: { untapped?: string[]; space?: number };
  insight?: { taglineZh?: string };
}
interface ModelRow {
  slug: string;
  name: string;
  provider: string;
  context?: number;
  price?: { input?: number; output?: number };
  capability?: number;
  tags?: string[];
  open?: boolean;
  releasedAt?: string;
}

function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(ROOT, "content", file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 数组容器兼容：有的榜是裸数组，有的是 { items: [...] } / { models: [...] } */
function asArray<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value as T[];
  const bag = value as Record<string, unknown> | null;
  const inner = bag?.[key];
  return Array.isArray(inner) ? (inner as T[]) : [];
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** 距今多少天；时间戳缺失或非法返回 null（视为「不知道旧不旧」，不剔除）。 */
function daysSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/** 已消费的素材沉底：未用过的在前、用过的在后，各自保持传入顺序，让「推进式覆盖」生效。 */
function sinkConsumed<T>(rows: T[], refOf: (r: T) => string, consumed: Set<string>): T[] {
  return [
    ...rows.filter((r) => !consumed.has(refOf(r))),
    ...rows.filter((r) => consumed.has(refOf(r))),
  ];
}

/**
 * 挑素材：每榜按「机会信号强度」排序，再叠加两条硬约束——
 *
 * 1. 新鲜度门槛：每榜取一条时间戳锚点，数据久未更新的素材剔除（models 例外，发布≠失效）。
 *    采集端若几周不刷榜，老素材会自动落选，而不是无限复用同一批僵尸信号。
 * 2. 已消费记忆：跨批次记住哪些 ref 已被引用过，沉底后让连续批次推进式消费素材库，
 *    而不是每批都撞同一批 top（解决「榜单不变 → 素材一样 → 机会重复」）。
 */
function buildMaterial(consumedRefs: Record<string, string[]> = {}): {
  trends: TrendRow[];
  tools: ToolRow[];
  repos: RepoRow[];
  models: ModelRow[];
  refs: { trends: Set<string>; tools: Set<string>; github: Set<string>; models: Set<string> };
  consumed: { trends: Set<string>; tools: Set<string>; github: Set<string>; models: Set<string> };
  dropped: { trends: number; tools: number; github: number };
} {
  const FRESH_DAYS = { trends: 30, tools: 45, github: 45 } as const;
  const CONF_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const STATUS_RANK: Record<string, number> = { breaking: 2, gaining: 1, cooling: 0 };
  const consumed = {
    trends: new Set(consumedRefs.trends ?? []),
    tools: new Set(consumedRefs.tools ?? []),
    github: new Set(consumedRefs.github ?? []),
    models: new Set(consumedRefs.models ?? []),
  };

  // trends：breaking 优先、confidence 次之；剔除 cooling 与久未更新者
  const trendsRaw = readJSON<unknown>("trends.json", {});
  const trendsFresh = asArray<TrendRow>(trendsRaw, "keywords").filter(
    (t) => t.status !== "cooling" && t.slug && t.editorNote?.entryAngle,
  );
  const trendsAct = trendsFresh.filter((t) => {
    const age = daysSince(t.updatedAt ?? t.lastSeenAt);
    return age === null || age <= FRESH_DAYS.trends;
  });
  const trendRank = (t: TrendRow) =>
    (STATUS_RANK[t.status ?? "cooling"] ?? 0) * 10 + (CONF_RANK[t.confidence ?? "low"] ?? 1);
  const trends = sinkConsumed(
    trendsAct.sort((a, b) => trendRank(b) - trendRank(a)),
    (t) => t.slug,
    consumed.trends,
  ).slice(0, 60);

  // tools：机会分排序，剔除久未采集者
  const toolsRaw = readJSON<unknown>("aitools.json", []);
  const toolsFresh = asArray<ToolRow>(toolsRaw, "items").filter((t) => t.domain);
  const toolsAct = toolsFresh.filter((t) => {
    const age = daysSince(t.collectedAt ?? t.firstSeenAt);
    return age === null || age <= FRESH_DAYS.tools;
  });
  const tools = sinkConsumed(
    toolsAct.sort((a, b) => (b.opportunity?.score ?? 0) - (a.opportunity?.score ?? 0)),
    (t) => t.domain,
    consumed.tools,
  ).slice(0, 40);

  // repos：按机会空间（derivative.space 1-10）排序——不是 productScore 质量分；剔除久未抓取者
  const reposRaw = readJSON<unknown>("github.json", {});
  const reposFresh = asArray<RepoRow>(reposRaw, "repos").filter(
    (r) => r.fullName && r.derivative?.untapped?.length,
  );
  const reposAct = reposFresh.filter((r) => {
    const age = daysSince(r.lastCrawledAt ?? r.pushedAt);
    return age === null || age <= FRESH_DAYS.github;
  });
  const repos = sinkConsumed(
    reposAct.sort((a, b) => (b.derivative?.space ?? 0) - (a.derivative?.space ?? 0)),
    (r) => r.fullName,
    consumed.github,
  ).slice(0, 40);

  // models：服务于 feasible/timing，开源可复用优先、输入价升序；不设新鲜度门槛（发布≠失效）
  const modelsRaw = readJSON<unknown>("models.json", {});
  const models = sinkConsumed(
    asArray<ModelRow>(modelsRaw, "models")
      .filter((m) => m.slug)
      .sort(
        (a, b) =>
          (b.open ? 1 : 0) - (a.open ? 1 : 0) ||
          (a.price?.input ?? Number.POSITIVE_INFINITY) -
            (b.price?.input ?? Number.POSITIVE_INFINITY),
      ),
    (m) => m.slug,
    consumed.models,
  ).slice(0, 25);

  const allTrends = asArray<TrendRow>(trendsRaw, "keywords");
  const allTools = asArray<ToolRow>(toolsRaw, "items");
  const allRepos = asArray<RepoRow>(reposRaw, "repos");
  const allModels = asArray<ModelRow>(modelsRaw, "models");

  return {
    trends,
    tools,
    repos,
    models,
    // 校验用全量，不是裁剪后的前 N 条
    refs: {
      trends: new Set(allTrends.map((t) => t.slug).filter(Boolean)),
      tools: new Set(
        allTools.flatMap((t) => [t.domain, t.id]).filter((v): v is string => Boolean(v)),
      ),
      github: new Set(allRepos.map((r) => r.fullName).filter(Boolean)),
      models: new Set(allModels.map((m) => m.slug).filter(Boolean)),
    },
    consumed,
    dropped: {
      trends: trendsFresh.length - trendsAct.length,
      tools: toolsFresh.length - toolsAct.length,
      github: reposFresh.length - reposAct.length,
    },
  };
}

function renderMaterial(m: ReturnType<typeof buildMaterial>): string {
  const used = (board: keyof typeof m.consumed, ref: string) =>
    m.consumed[board].has(ref) ? "【已用过】" : "";

  const trends = m.trends
    .map(
      (t) =>
        `- ${used("trends", t.slug)}${t.slug} | ${truncate(t.editorNote?.entryAngle, 80)} | 受众 ${truncate(
          t.editorNote?.audience,
          30,
        )} | ${truncate(t.editorNote?.whyAccepted, 50)}`,
    )
    .join("\n");

  const tools = m.tools
    .map((t) => {
      const spark = t.ideaSparks?.[0];
      const tail = spark ? ` | 火花「${truncate(spark.title, 30)}」` : "";
      return `- ${used("tools", t.domain)}${t.domain} | ${t.name} | 机会 ${t.opportunity?.score ?? "?"} 分 ${
        t.opportunity?.verdict ?? ""
      } | ${truncate(t.opportunity?.reason, 60)}${tail}`;
    })
    .join("\n");

  const repos = m.repos
    .map((r) => {
      const untapped = r.derivative?.untapped?.[0];
      const tail = untapped ? ` | 机会 ${truncate(untapped, 60)}` : "";
      return `- ${used("github", r.fullName)}${r.fullName} | ${r.productScore?.grade ?? "?"}级 ${
        r.productScore?.score ?? "?"
      } 分 | ${truncate(r.insight?.taglineZh, 40)}${tail}`;
    })
    .join("\n");

  const models = m.models
    .map(
      (x) =>
        `- ${used("models", x.slug)}${x.slug} | ${x.provider} | ${x.open ? "开源" : "闭源"} | 能力 ${x.capability ?? "?"} | 价格 ${
          x.price?.input ?? "?"
        }/${x.price?.output ?? "?"} 美元每百万 | ${(x.tags ?? []).join("/")}`,
    )
    .join("\n");

  return [
    "## 趋势榜（搜索词，ref 用第一列；entryAngle 是采集端已想好的切入角度；【已用过】= 之前候选引用过，优先找没标的）",
    trends,
    "",
    "## 工具榜（ref 用域名；机会分与「火花」是采集端已算好的判断）",
    tools,
    "",
    "## GitHub 榜（ref 用 owner/repo；「机会」是采集端标的未占场景）",
    repos,
    "",
    "## 模型榜（ref 用 model slug）",
    models,
  ].join("\n");
}

/* ------------------------------ 输出校验 ------------------------------ */

interface Opportunity {
  slug: string;
  batch: string;
  title: string;
  oneLiner: string;
  audience?: string[];
  entryMode?: string;
  window?: string;
  scores?: Record<string, number>;
  scoreBasis?: Record<string, string>;
  solo?: { budget?: string; weeks?: number; channels?: string[]; firstWeek?: string[] };
  money?: { price?: string; payer?: string; first10?: string };
  thesis?: { where?: string; whyNow?: string; dont?: string };
  evidence?: Array<{ board?: string; ref?: string; note?: string }>;
  build?: {
    form?: string;
    mvpScope?: unknown;
    stack?: unknown;
    leverage?: unknown;
  };
  path?: Array<{ name?: string; actions?: unknown }>;
  outcome?: { targets?: unknown; ceiling?: string; reality?: string };
  risks?: unknown;
}

const REQUIRED: Array<[string, (o: Opportunity) => unknown]> = [
  ["slug", (o) => o.slug],
  ["title", (o) => o.title],
  ["oneLiner", (o) => o.oneLiner],
  ["audience", (o) => o.audience?.length],
  ["scores", (o) => o.scores],
  ["scoreBasis", (o) => o.scoreBasis],
  ["solo", (o) => o.solo],
  ["money", (o) => o.money],
  ["thesis", (o) => o.thesis],
  ["evidence", (o) => o.evidence?.length],
  ["build", (o) => o.build],
  ["path", (o) => o.path?.length],
  ["outcome", (o) => o.outcome],
  ["risks", (o) => o.risks],
];

/**
 * 校验一条机会。返回的问题列表 —— 空数组才算通过。
 *
 * 硬约束只查两类：schema 缺字段、证据引用不存在。风格问题（标题不够口语、
 * 分数偏低）交给人在预览里判断，机器不该替人做审美。
 */
function validate(
  opp: Opportunity,
  refs: ReturnType<typeof buildMaterial>["refs"],
  usedSlugs: Set<string>,
): string[] {
  const problems: string[] = [];

  for (const [name, get] of REQUIRED) {
    if (!get(opp)) problems.push(`缺少字段 ${name}`);
  }
  if (opp.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(opp.slug)) {
    problems.push(`slug 必须是 kebab-case：${opp.slug}`);
  }
  if (opp.slug && usedSlugs.has(opp.slug)) {
    problems.push(`slug 与已有机会重复：${opp.slug}`);
  }
  if (opp.batch && !BATCH_RE.test(opp.batch)) {
    problems.push(`batch 格式不对：${opp.batch}`);
  }

  const scores = opp.scores ?? {};
  for (const key of ["demand", "gap", "feasible", "timing", "monetize"]) {
    const v = scores[key];
    if (typeof v !== "number" || v < 0 || v > 100) problems.push(`scores.${key} 必须是 0-100 的数字`);
  }
  // 原则 0：一人公司适配，构建期也会查
  if (typeof scores.feasible === "number" && scores.feasible < 60) {
    problems.push(`feasible=${scores.feasible} 低于门槛 60`);
  }
  if (typeof scores.monetize === "number" && scores.monetize < 50) {
    problems.push(`monetize=${scores.monetize} 低于门槛 50`);
  }
  if (opp.solo?.weeks && opp.solo.weeks > 6) {
    problems.push(`solo.weeks=${opp.solo.weeks} 超过 6 周上限`);
  }

  /*
   * 结构校验：详情页对这些字段是直接 map 的，模型一旦换个写法（把 risks 写成
   * { biggest, mitigation }、把 outcome 写成 { success, fail }），存进库后
   * 发布出去的页面「效果」「风险」两节会渲染不出来，而且要到构建或点开详情才暴露。
   * 所以形状不对就在生成阶段打回重试，别等到发布。
   */
  const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  const outcome = opp.outcome;
  if (!Array.isArray(outcome?.targets) || !outcome.targets.length) {
    problems.push(`outcome.targets 必须是非空数组，形如 [{ metric: "指标名", value: "目标值" }]`);
  } else {
    const bad = (outcome.targets as Array<{ metric?: unknown; value?: unknown }>).find(
      (t) => !isText(t?.metric) || !isText(t?.value),
    );
    if (bad) problems.push(`outcome.targets 每一项都要有 metric 和 value：${JSON.stringify(bad)}`);
  }
  if (!isText(outcome?.ceiling)) problems.push("outcome.ceiling 必须是非空字符串（天花板怎么算）");
  if (!isText(outcome?.reality)) problems.push("outcome.reality 必须是非空字符串（什么条件下不成立）");

  if (!Array.isArray(opp.risks) || !opp.risks.length) {
    problems.push(`risks 必须是非空数组，形如 [{ risk: "风险", mitigation: "怎么对冲" }]`);
  } else {
    const bad = (opp.risks as Array<{ risk?: unknown; mitigation?: unknown }>).find(
      (r) => !isText(r?.risk) || !isText(r?.mitigation),
    );
    if (bad) problems.push(`risks 每一项都要有 risk 和 mitigation：${JSON.stringify(bad)}`);
  }

  for (const key of ["mvpScope", "stack", "leverage"] as const) {
    if (!Array.isArray(opp.build?.[key]) || !(opp.build[key] as unknown[]).length) {
      problems.push(`build.${key} 必须是非空数组`);
    }
  }
  (opp.path ?? []).forEach((phase, i) => {
    if (!Array.isArray(phase?.actions) || !phase.actions.length) {
      problems.push(`path[${i}].actions 必须是非空数组`);
    }
  });

  const boardMap: Record<string, Set<string>> = {
    trends: refs.trends,
    tools: refs.tools,
    github: refs.github,
    models: refs.models,
  };
  for (const ev of opp.evidence ?? []) {
    const pool = ev.board ? boardMap[ev.board] : undefined;
    if (!pool) {
      problems.push(`evidence.board 不认识：${ev.board}`);
      continue;
    }
    if (!ev.ref || !pool.has(ev.ref)) {
      problems.push(`evidence.ref 在 ${ev.board} 榜单里不存在：${ev.ref}`);
    }
  }

  return problems;
}

/* ------------------------------ 提示词 ------------------------------ */

function loadPolicy(): string {
  try {
    return readFileSync(POLICY, "utf8");
  } catch {
    return "（原则文档缺失，仍按「一人公司、四周能跑通、首月零成本」的默认口径执行）";
  }
}

function loadExisting(): Opportunity[] {
  try {
    const data = JSON.parse(readFileSync(CONTENT, "utf8")) as { opportunities?: Opportunity[] };
    return data.opportunities ?? [];
  } catch {
    return [];
  }
}

function renderSummary(items: Opportunity[]): string {
  if (!items.length) return "（无）";
  return items
    .map((o) => {
      const refs = (o.evidence ?? [])
        .map((e) => e.ref)
        .filter(Boolean)
        .join("、");
      return `- ${o.slug} | ${o.title} | ${truncate(o.oneLiner, 40)}${refs ? ` | 已引用：${refs}` : ""}`;
    })
    .join("\n");
}

function systemPrompt(policy: string): string {
  return [
    "你是一家小型工作室的机会研究员。你的读者是中国的独立开发者与一人公司，他们在找「四周内能做出可收费产品」的缝隙。",
    "",
    "## 收录原则（唯一标准，逐条遵守）",
    policy,
    "",
    "## 输出要求",
    "- 只输出 JSON 对象，不要任何解释文字。",
    "- 结构必须与示例完全一致，字段名不得增删改。",
    "- 全部中文，标题要像人说的话，不要营销腔。",
    "- 标题必须是一个完整的句子（可以带逗号），禁止用冒号加副标题的形式，也不要堆名词。",
    "- evidence 至少 3 条，ref 必须来自给定榜单且原样照抄；编造 ref 会让构建失败。",
    "- scores 的 5 个维度各自打分，scoreBasis 每一条都必须引用素材里的具体数字（某 tool 的月访问与环比、某 repo 的星数或评分、某 trend 的热度变化、某 model 的价格），不得只写抽象定性理由。",
    "- 整体篇幅与结构示例一致，不要展开：scoreBasis 每条一句话、只引一个具体数字，evidence 3~4 条即可，其余字段按示例的详略程度写。",
    "- solo.weeks ≤ 6，scores.feasible ≥ 60，scores.monetize ≥ 50。",
  ].join("\n");
}

function userPrompt(options: {
  batch: string;
  material: string;
  existing: Opportunity[];
  exclude: string[];
  reason: string;
  rejections?: Rejection[];
  problems?: string[];
}): string {
  const parts = [
    `## 本期批次：${options.batch}`,
    "",
    `## 已经在线上的机会（不要重复方向，也不要复用它们已引用的证据 ref）`,
    renderSummary(options.existing),
  ];

  if (options.exclude.length) {
    parts.push("", "## 本批次已采纳的机会（同样不要重复）", options.exclude.map((s) => `- ${s}`).join("\n"));
  }
  if (options.reason) {
    parts.push("", "## 上一条被拒绝的原因（这次必须避开同样的问题）", options.reason);
  }
  if (options.rejections?.length) {
    parts.push(
      "",
      "## 历史被拒记录（这些方向已被否决，换新角度，不要重蹈）",
      options.rejections
        .slice(-15)
        .map(
          (r) =>
            `- [${r.batch}] ${r.reason || "（无理由）"}${
              r.exclude?.length ? `（被拒 slug: ${r.exclude.join("、")}）` : ""
            }`,
        )
        .join("\n"),
    );
  }
  if (options.problems?.length) {
    parts.push("", "## 上一次生成的错误（必须全部修掉）", options.problems.map((p) => `- ${p}`).join("\n"));
  }

  parts.push(
    "",
    "## 可引用的素材（ref 必须原样取自下表）",
    options.material,
    "",
    "## 结构示例（只学结构与详略程度，不要复用其内容）",
    JSON.stringify(
      {
        slug: "sample-slug",
        batch: options.batch,
        title: "一句人话标题",
        oneLiner: "两三句讲清需求从哪来、谁在疼、怎么收钱",
        audience: ["独立创作者", "播客主"],
        entryMode: "product",
        window: "3–6 个月",
        scores: { demand: 78, gap: 72, feasible: 86, timing: 78, monetize: 80 },
        scoreBasis: {
          demand: "依据：某 tool 月访问 XX 且环比 +X%、某 trend 热度近 X 周 +X%（要真数字）",
          gap: "依据：某 repo 的 derivative 显示「X」未占场景、某 model 明确是闭源/高价",
          feasible: "依据：某 repo 开源可复用（X 星 / MIT）、某 tool buildBlueprint 首版 ≤ X 周",
          timing: "依据：某 trend 是新词（近期才出现）、某 tool/model 近期才发布",
          monetize: "依据：某 tool pricing 已跑通 X 元/月、同类已有的定价参照",
        },
        solo: { budget: "首月 0 美元 · 稳定期 ≤ 60 美元/月", weeks: 4, channels: ["Google 搜索"], firstWeek: ["第一周要做的验证动作"] },
        money: { price: "12 美元/月", payer: "自己付钱的人", first10: "前 10 个付费用户具体怎么来" },
        thesis: { where: "缺口在哪一层", whyNow: "为什么现在成立", dont: "不要做什么" },
        evidence: [{ board: "trends", ref: "素材里的 slug", note: "这条证据说明什么" }],
        build: { form: "产品形态", mvpScope: ["MVP 边界"], stack: ["技术栈"], leverage: [{ kind: "open-source", ref: "owner/repo", how: "怎么复用" }] },
        path: [{ phase: "0", name: "手工验证", weeks: "1–2 周", actions: ["做什么"], deliverable: "交付物", gate: "过了这道门才继续" }],
        outcome: {
          targets: [{ metric: "可量化的指标名", value: "目标值" }],
          ceiling: "天花板怎么算：单价 × 可触达客户数，说明为什么是这个量级",
          reality: "这条机会在什么条件下不成立",
        },
        risks: [{ risk: "最大的风险", mitigation: "怎么对冲" }],
      },
      null,
      1,
    ),
    "",
    "## 本次任务",
    options.reason || options.exclude.length
      ? "生成 1 条新的机会，补足本批次。"
      : "生成 1 条新的机会。它会和另外几条一起组成本批次。",
    '只返回 {"opportunity": {...}} 这一个对象。',
  );

  return parts.join("\n");
}

/* ------------------------------ 落库 ------------------------------ */

/** 一条被人工拒绝的记录：周期内最强的反馈信号（人为、显式、即时）。
 *  跨批次沉淀后喂回生成，避免下批再踩同样的坑。 */
interface Rejection {
  at: string;
  batch: string;
  reason: string;
  exclude: string[];
}

interface StagingFile {
  updatedAt: string;
  batches: Record<string, { generatedAt: string; model: string; items: Opportunity[] }>;
  rejections?: Rejection[];
  /** 跨批次已引用过的素材 ref，按 board（trends/tools/github/models）分组。
   *  供 buildMaterial 沉底，推进式消费素材库，避免榜单不变时每批都撞同一批头部素材。 */
  consumedRefs?: Record<string, string[]>;
}

function readStaging(): StagingFile {
  if (!existsSync(STAGING)) {
    return { updatedAt: new Date().toISOString(), batches: {}, rejections: [], consumedRefs: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(STAGING, "utf8")) as Partial<StagingFile>;
    return {
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      batches: parsed.batches ?? {},
      rejections: parsed.rejections ?? [],
      consumedRefs: parsed.consumedRefs ?? {},
    };
  } catch {
    return { updatedAt: new Date().toISOString(), batches: {}, rejections: [], consumedRefs: {} };
  }
}

function saveStaging(file: StagingFile): void {
  file.updatedAt = new Date().toISOString();
  writeFileSync(STAGING, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** 后台预览读 D1，所以生成完必须落库；文件只是留档 */
async function pushToD1(batch: string, items: Opportunity[]): Promise<number> {
  return syncCandidates(
    "opps",
    items.map((opp) => ({
      itemKey: opp.slug,
      name: opp.title,
      url: null,
      cats: opp.audience ?? null,
      status: "candidate" as const,
      kind: "new" as const,
      judge: { batch, generatedBy: "generate.ts" },
      /*
       * batch 以命令行参数为准，不信任模型的输出：
       * 0023 之后 board_items.batch 由 card.batch 提成（syncCandidates 填），
       * 后台按批次查候选全靠这一列 —— 模型漏写 batch 就等于候选「不属于任何批次」，
       * 预览页永远看不到它。
       */
      card: { ...opp, batch },
    })),
  );
}

/* ------------------------------- 主流程 ------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // 先读 staging：它携带的 consumedRefs 决定本批素材怎么沉底（推进式消费）
  const staging = readStaging();
  const material = buildMaterial(staging.consumedRefs ?? {});
  const policy = loadPolicy();
  const existing = loadExisting();

  const usedSlugs = new Set(existing.map((o) => o.slug));
  const accepted: Opportunity[] = [];

  // 补位时把该批次已存在的候选也算进"别重复"名单
  const rejections = staging.rejections ?? [];
  const batchItems = staging.batches[args.batch]?.items ?? [];
  for (const o of batchItems) usedSlugs.add(o.slug);
  const excludeTitles = [...args.exclude, ...batchItems.map((o) => o.title)].filter(Boolean);

  const system = systemPrompt(policy);
  const materialText = renderMaterial(material);
  const { dropped } = material;
  if (dropped.trends || dropped.tools || dropped.github) {
    console.log(
      `[opps] stale 剔除：trends ${dropped.trends} / tools ${dropped.tools} / github ${dropped.github}（超过新鲜度门槛的素材）`,
    );
  }
  console.log(
    `[opps] 批次 ${args.batch} · 生成 ${args.count} 条 · 模型 ${args.model} · 素材 trends ${material.trends.length} / tools ${material.tools.length} / github ${material.repos.length} / models ${material.models.length}`,
  );

  for (let i = 0; i < args.count; i++) {
    const user = userPrompt({
      batch: args.batch,
      material: materialText,
      
      existing,
      exclude: [...excludeTitles, ...accepted.map((o) => o.title)],
      reason: args.reason,
      rejections,
    });

    if (args.dry) {
      console.log(`[opps] dry-run：system ${system.length} 字 / user ${user.length} 字`);
      return;
    }

    let lastProblems: string[] = [];
    let picked: Opportunity | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? user
          : userPrompt({
              batch: args.batch,
              material: materialText,
              
              existing,
              exclude: [...excludeTitles, ...accepted.map((o) => o.title)],
              reason: args.reason,
              rejections,
              problems: lastProblems,
            });

      // max_tokens 给到 16000：scoreBasis 要引用具体数字后，单条完整 JSON 会逼近 8k
      // 上限，三条证据 + 五维打分 + 路径/结果/风险全写满时 8000 会被截断。v4-pro 专为
      // 长 JSON 输出，16000 在其能力内。
      const res = await chatJSON<{ opportunity?: Opportunity }>(system, prompt, 16000, 0.7, args.model);
      const opp = res.opportunity;
      if (!opp) {
        lastProblems = ["返回里没有 opportunity 字段"];
        continue;
      }

      opp.batch = args.batch;
      lastProblems = validate(opp, material.refs, usedSlugs);
      if (!lastProblems.length) {
        picked = opp;
        break;
      }
      console.log(`[opps] 第 ${i + 1} 条未通过校验（第 ${attempt + 1} 次）：${lastProblems.join("；")}`);
    }

    if (!picked) {
      throw new Error(`第 ${i + 1} 条两次尝试都未通过校验：${lastProblems.join("；")}`);
    }

    usedSlugs.add(picked.slug);
    accepted.push(picked);
    console.log(`[opps] ✓ ${picked.slug} · ${picked.title}`);
  }

  // 补位 = 「拒绝某条后换一条」，把这次被拒的理由沉淀下来，跨批次喂回
  if (args.reason || args.exclude.length) {
    staging.rejections = [
      ...(staging.rejections ?? []),
      { at: new Date().toISOString(), batch: args.batch, reason: args.reason, exclude: args.exclude },
    ];
  }

  // 已消费记忆：把本批采纳机会引用的素材 ref 沉淀进 staging.consumedRefs，
  // 下批 buildMaterial 会把这些 ref 沉底，推进式消费素材库，避免撞同一批头部素材
  const consumedRefs = staging.consumedRefs ?? {};
  const consumedAdd: Record<string, Set<string>> = {
    trends: new Set(consumedRefs.trends ?? []),
    tools: new Set(consumedRefs.tools ?? []),
    github: new Set(consumedRefs.github ?? []),
    models: new Set(consumedRefs.models ?? []),
  };
  for (const o of accepted) {
    for (const e of o.evidence ?? []) {
      if (e.board && e.ref && consumedAdd[e.board]) consumedAdd[e.board].add(e.ref);
    }
  }
  staging.consumedRefs = {
    trends: [...consumedAdd.trends],
    tools: [...consumedAdd.tools],
    github: [...consumedAdd.github],
    models: [...consumedAdd.models],
  };

  // 落盘：同批次补位是追加，不是覆盖
  const merged = [...batchItems.filter((o) => !accepted.some((a) => a.slug === o.slug)), ...accepted];
  staging.batches[args.batch] = {
    generatedAt: new Date().toISOString(),
    model: args.model,
    items: merged,
  };
  saveStaging(staging);
  console.log(`[opps] 已写 content/opportunities-staging.json（本批次共 ${merged.length} 条）`);

  if (args.writeD1) {
    const n = await pushToD1(args.batch, accepted);
    console.log(n ? `[opps] 已写入 D1 候选池 ${n} 条，后台可见` : "[opps] D1 未配置，后台看不到这批候选（仅文件留档）");
  }

  if (merged.length > 5) {
    console.log(`::warning::[opps] 本批次已有 ${merged.length} 条，超过 5 条上限，发布前请先拒绝多余条目`);
  }
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[opps] 生成失败：${msg}`);
  process.exit(1);
});