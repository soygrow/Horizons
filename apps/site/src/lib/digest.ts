/**
 * 每日情报：构建期读取 content/digest/*.json。
 *
 * 这些文件不是手写、也不入库 —— 唯一真源是 D1 的 digest_issues，
 * 每次 `pnpm data` 先跑 scripts/admin/hydrate-digest.ts 把它们物化出来，
 * 之后照旧静态生成（/daily 与 /daily/[date] 都是纯静态路径）。
 *
 * 只发已核验的条目：成稿阶段就已经把缺一手材料的内容挡在外面（见
 * scripts/fetch/daily/score.ts 的 allocate），这里再过滤一次是给旧期兜底
 * —— 迁到 D1 之前的 payload 里还留着 pending 条目。
 */

import { formatDate as formatYMD } from "./format";

/** rumor 仅作内部判定，成稿里不会出现 */
export type EvidenceLevel = "verified" | "pending" | "rumor";
export type ModuleKey = "headline" | "tools" | "money" | "action";

export interface DigestSource {
  type: "official" | "repo" | "community" | "media";
  label: string;
  url: string;
  verified: boolean;
}

export interface DigestItem {
  id: string;
  title: string;
  summary: string;
  why: string;
  category: string;
  evidence: EvidenceLevel;
  score: number;
  heat: number;
  firstSeenAt: string | null;
  sources: DigestSource[];
  signals: Record<string, number>;
  missing?: string;
}

/** 一期的话头：页面第一屏显示它，条目列表围绕它展开（条目级的三句话见 DigestLine） */
export interface DailySummary {
  lead: string;
  points: string[];
}

export interface Digest {
  date: string;
  generatedAt: string;
  stats: { candidates: number; merged: number; verified: number; published: number };
  /** 成稿时算好；旧期没有这个字段，读入时用 deriveBrief 现算一份 */
  brief?: DailySummary;
  modules: Array<{ key: ModuleKey; items: DigestItem[] }>;
  sourceHealth: Array<{
    source: string;
    ok: boolean;
    items: number;
    duplicates: number;
    ms: number;
    note: string | null;
    error: string | null;
  }>;
}

const RAW = import.meta.glob<{ default: Digest }>("../../../../content/digest/*.json", {
  eager: true,
});

/** 取第一句，用于要点里的一句话 */
function firstSentence(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^[^。！？]*[。！？]/);
  const first = (m ? m[0] : clean).replace(/[。！？]$/, "").trim();
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/**
 * 旧期兜底的话头：与 scripts/fetch/daily/compose.ts 的 composeBrief 同口径。
 *
 * 新期在成稿时就写好了 brief，只有迁到 D1 之前的两期没有 —— 它们也不打算重跑，
 * 所以这里现算一份，免得首页对旧期是「十几条标题堆着」、对新期是「先有一段话」。
 */
function deriveBrief(modules: Digest["modules"]): DailySummary {
  // 这里不能调 categoryLabel：CATEGORY_LABEL 是 const，module 顶层初始化
  // digests 时会撞上 TDZ（Cannot access 'CATEGORY_LABEL' before initialization）。
  const ZH: Record<string, string> = {
    model_release: "模型发布",
    product_launch: "产品发布",
    open_source: "开源项目",
    ai_agent: "智能体",
    ai_coding: "AI 编程",
    business: "商业化",
    other: "其他",
  };
  const zh = (key: string) => ZH[key] ?? key;

  const all = modules.flatMap((m) => m.items);
  const countOf = (key: ModuleKey): number => modules.find((m) => m.key === key)?.items.length ?? 0;

  const tally = new Map<string, number>();
  for (const item of all) tally.set(item.category, (tally.get(item.category) ?? 0) + 1);
  const topCats = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, n]) => `${zh(key)} ${n} 条`);

  /*
   * 第一句要给「今天最值得看的一件事」，不能只报数量。
   * 头条首条是按分数排下来的第一条，用「来源 + 类别」起头，
   * 中文可读且不引入原文没有的判断（英文标题留在下面当出处）。
   */
  const first = countOf("headline") > 0
    ? modules.find((m) => m.key === "headline")?.items[0]
    : all[0];
  const opener = first
    ? `今天最值得先看的是 ${first.sources[0]?.label ?? "一条官方消息"}的 ${zh(first.category)}消息`
    : "";

  const parts: string[] = [];
  if (topCats.length > 0) parts.push(`${topCats.join("、")}，是变动最集中的方向`);
  const tools = countOf("tools");
  const money = countOf("money");
  const action = countOf("action");
  if (tools > 0) parts.push(`${tools} 个能直接上手的项目`);
  if (money > 0) parts.push(`${money} 条成本或定价变化`);
  if (action > 0) parts.push(`${action} 个当天就能验证的动作`);

  const lead =
    (opener ? `${opener}。` : "") +
    `整期 ${all.length} 条：${parts.join("；")}。每条都有一手出处，点开链接就能核对。`;

  const order: ModuleKey[] = ["headline", "tools", "money", "action"];
  const points = order
    .flatMap((key) => modules.find((m) => m.key === key)?.items ?? [])
    // HN 条目的摘要是「外链指向 X 的原文…」，一句话什么也没说，不当要点
    .filter((item) => !item.summary.startsWith("外链指向"))
    .slice(0, 3)
    .map((item) => {
      const where = item.sources[0]?.label ? `${zh(item.category)} · ${item.sources[0].label}` : zh(item.category);
      return `${where}：${firstSentence(item.why)}`;
    });

  return { lead, points };
}

/**
 * 只留已核验的条目，并保证一定带得动话头。
 *
 * 空模块直接丢掉：`模块标题 + 0 条` 这种空壳比少一个模块更难看。
 */
export function publishedDigest(digest: Digest): Digest {
  const modules = digest.modules
    .map((m) => ({ ...m, items: m.items.filter((i) => i.evidence === "verified") }))
    .filter((m) => m.items.length > 0);
  const count = modules.reduce((n, m) => n + m.items.length, 0);
  const verified = modules.reduce(
    (n, m) => n + m.items.filter((i) => i.evidence === "verified").length,
    0,
  );
  return {
    ...digest,
    modules,
    stats: { ...digest.stats, published: count, verified },
    brief: digest.brief ?? deriveBrief(modules),
  };
}

/** 日期倒序：最新一期在最前 */
export const digests: Digest[] = Object.entries(RAW)
  .map(([, mod]) => mod.default ?? (mod as unknown as Digest))
  .filter((d) => Boolean(d?.date) && Array.isArray(d.modules))
  .sort((a, b) => b.date.localeCompare(a.date))
  .map(publishedDigest);

export const latestDigest: Digest | null = digests[0] ?? null;

export function digestByDate(date: string): Digest | null {
  return digests.find((d) => d.date === date) ?? null;
}

export const MODULE_META: Record<ModuleKey, { no: string; name: string; desc: string }> = {
  headline: { no: "01", name: "今日头条", desc: "今天真正变了的事" },
  tools: { no: "02", name: "能直接用的", desc: "开源项目、可自部署工具、免费额度" },
  money: { no: "03", name: "成本与定价", desc: "定价、成本、融资与公开的商业化案例" },
  action: { no: "04", name: "今天就能做", desc: "半小时内可验证的下一步" },
};

/** 采集侧的分类键是英文的，页面一律显示中文 */
export const CATEGORY_LABEL: Record<string, string> = {
  model_release: "模型发布",
  product_launch: "产品发布",
  open_source: "开源项目",
  ai_agent: "智能体",
  ai_coding: "AI 编程",
  business: "商业",
  other: "其他",
};

export function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key;
}

/*
 * 这里原来有一张 EVIDENCE_META：已核验 / 待核实 / 未证实 三档徽章。
 * 现在只发有一手出处的条目，三档里只有一档会出现，徽章等于给每行盖同一个章，
 * 所以连样式表一起删了。
 */

/** 日期统一 YYYY-MM-DD（与 lib/format 同口径，不再拼接星期） */
export function formatDate(date: string): string {
  return formatYMD(date);
}

/** ISO → 05:12（北京时间） */
export function formatTime(iso: string | null): string {
  if (!iso) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function compactNumber(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} 千`;
  return String(n);
}

/** 条目上的关键量，只显示原始材料里真实存在的 */
export function signalText(item: DigestItem): string[] {
  const out: string[] = [];
  if (item.signals.points !== undefined) {
    out.push(`HN ${item.signals.points} 分`);
  }
  if (item.signals.comments !== undefined) {
    out.push(`${item.signals.comments} 条评论`);
  }
  if (item.signals.stars !== undefined) {
    out.push(`${compactNumber(item.signals.stars)} Star`);
  }
  if (item.signals.starDelta !== undefined && item.signals.starDelta > 0) {
    out.push(`近期 +${item.signals.starDelta}`);
  }
  return out;
}

export function digestCounts(d: Digest): number {
  return d.modules.reduce((n, m) => n + m.items.length, 0);
}

/* ------------------------------- 一句话/几句话 ------------------------------- */

/**
 * 成稿里的「为什么值得关注」末尾会带一句证据状态（"已有可直接核对…可以引用。"
 * / "目前只有转述，引用前需二次确认。"）。状态已经由徽章表达，正文再重复一遍
 * 就是凑字数，读起来像模板。这里统一剔掉，旧期数据也一起收干净。
 */
const EVIDENCE_TAIL_SENTENCES = [
  "已有可直接核对的原始出处，可以引用。",
  "目前只有转述，引用前需二次确认。",
];

function stripEvidenceTail(text: string): string {
  let out = text.trim();
  for (const tail of EVIDENCE_TAIL_SENTENCES) {
    if (out.endsWith(tail)) out = out.slice(0, -tail.length).trim();
  }
  return out.replace(/[，、；\s]+$/, "").replace(/([。！？])$/, "$1");
}

/** 取第一句，用于卡片/列表的一行速览 */
export function oneLine(text: string, max = 64): string {
  const clean = stripEvidenceTail(text).replace(/\s+/g, " ");
  const m = clean.match(/^[^。！？]*[。！？]/);
  const first = (m ? m[0] : clean).replace(/[。！？]$/, "");
  const clipped = first.length > max ? `${first.slice(0, max)}…` : first;
  return /[。！？…]$/.test(clipped) ? clipped : `${clipped}。`;
}

/**
 * 每条情报只讲两句话：
 *   1. fact —— 发生了什么（材料能支持的事实）
 *   2. why  —— 所以呢（对判断/成本/动作的影响）
 *
 * 原先还有第三句 caveat「缺什么」，配合「待核实」徽章用。既然现在只发
 * 有一手材料的条目，这一句在页面上永远是空的，字段一并删掉。
 * 字段标签（「发生了什么 · 」）也不贴，直接排成段落才是话。
 */
export interface DigestLine {
  fact: string;
  why: string;
}

export function briefOf(item: DigestItem): DigestLine {
  return {
    fact: stripEvidenceTail(item.summary),
    why: stripEvidenceTail(item.why),
  };
}

/** 列表速览：一句话讲完发生了什么 */
export function briefLine(item: DigestItem): string {
  return oneLine(item.summary);
}