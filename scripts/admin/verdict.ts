/**
 * 待发布候选的准入判定（后台采集链路的唯一真源）。
 *
 * 判定口径与 docs/15-AI工具榜收录原则.md、apps/site/src/lib/data.ts 的 tierOf 一致：
 *   A1 独立 AI 产品 / A2 非大厂主站 / A3 站点可用 / A4 规模达标
 *
 * 采集端只拿到「判断必需的字段」就算出 verdict，不依赖 DFS 关键词、AI 解读等富化数据。
 */
import {
  isBlockedDomain,
  WATCH_HN_POINTS,
  WATCH_PH_UPVOTES,
  type AITool,
} from "@horizons/shared";

/** 与 @horizons/shared 同源，这里再导出一次，既有调用方不用改 import 路径 */
export { WATCH_HN_POINTS, WATCH_PH_UPVOTES };

export const MIN_VISITS_CORE = 10_000;
export const MIN_VISITS_WATCH = 1_000;
/** 新星豁免窗口（A4 第③条） */
export const NEW_STAR_DAYS = 120;

/** 平台型大厂主站：AI 只是其中一个产品线，不是受众要找的工具 */
export const PLATFORM_HOSTS: readonly string[] = [
  "openai.com",
  "anthropic.com",
  "google.com",
  "blog.google",
  "deepmind.google",
  "chatgpt.com",
  "microsoft.com",
  "meta.com",
  "apple.com",
  "github.com",
  "huggingface.co",
  "producthunt.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "medium.com",
  "youtube.com",
  "behance.net",
];

/** 建站平台 / 应用商店子域：内容多为临时项目，且极易批量生成 */
export const PLATFORM_SUFFIXES: readonly string[] = [
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "workers.dev",
  "webflow.io",
  "wixsite.com",
  "weebly.com",
  "blogspot.com",
  "wordpress.com",
  "gumroad.com",
  "play.google.com",
  "apps.apple.com",
];

/** 域名级准入：命中共享黑名单、平台主站或建站平台后缀即不可收录 */
export function isExcludedHost(domain: string): boolean {
  const d = (domain || "").toLowerCase().trim();
  if (!d) return true;
  if (isBlockedDomain(d)) return true;
  if (PLATFORM_HOSTS.includes(d)) return true;
  return PLATFORM_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`));
}

/* ------------------------------ 判定结果结构 ------------------------------ */

export type VerdictTier = "core" | "watch" | "reject";

/** A3 站点探测结果：true 可用 / false 不可用 / null 未探测（不阻断判定，留给人工） */
export type AliveState = boolean | null;

export interface VerdictChecks {
  /** A1 独立 AI 产品（采集端只能判域名形态，语义部分人工确认） */
  a1: boolean;
  /** A2 非大厂主站 */
  a2: boolean;
  /** A3 站点可用 */
  a3: AliveState;
  /** A4 规模达标 */
  a4: boolean;
}

export interface Verdict {
  tier: VerdictTier;
  /** 一句话理由，后台列表直接展示 */
  reason: string;
  checks: VerdictChecks;
  /** 判定时看到的月访问量，便于后台核对 */
  monthlyVisits?: number;
}

/**
 * 数据可信度信号，来自 Similarweb 自评（vortex base_data 透传）。
 *
 * 两个字段都缺失时视为「未知」而不是「不可信」：Actor 少返回一个键
 * 不该把所有站误伤进观察区，那是比漏判更糟的故障。
 */
export interface TrafficQuality {
  dataCoverage?: string;
  isSmall?: boolean;
}

export function visitsOf(t: AITool): number | undefined {
  return t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits;
}

export function momOf(t: AITool): number | undefined {
  return t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth;
}

/**
 * 准入判定。alive 为 null 表示没探测（或探测超时），此时不因 A3 拒绝。
 * 调用方可用 `--probe` 打开真实探测。
 *
 * A4 口径：只用 Similarweb 月访问量（$0.00001/域）+ PH 票数兜底。
 * docs/15 的 A4 第②条「自然搜索流量 ≥300」**不参与判定**——该值来自 DFS
 * traffic_history（$0.075/次），为一次筛选花 7500 倍的钱不划算，无流量时
 * 直接用 PH 票走新星豁免。搜索流量只作为富化后的质量指标展示。
 */
export function judge(
  t: AITool,
  alive: AliveState = null,
  a1 = true,
  quality?: TrafficQuality,
): Verdict {
  const a2 = !isExcludedHost(t.domain);
  const checks: VerdictChecks = { a1, a2, a3: alive, a4: false };

  // 采集端用关键词粗筛出 a1；判定维护/重判走默认 true，不改变已上榜条目的结论
  if (!a1) {
    return { tier: "reject", reason: "A1 不像 AI 产品（名称/简介无 AI 相关词）", checks };
  }
  if (!a2) {
    return { tier: "reject", reason: "A2 大厂主站或平台域名", checks };
  }
  if (alive === false) {
    return { tier: "reject", reason: "A3 站点不可访问", checks };
  }

  const v = visitsOf(t);

  // 无月访问量：只能靠 PH 票数进观察区。
  // 这里**不加发布时间限制**，是为了和 apps/site/src/lib/data.ts 的 tierOf 完全一致：
  // 判定端与展示端口径一旦不同，后台算出的「下榜」就会和线上实际不符。
  // 新星时效交给采集端控制（只抓最近发布的那批），而不是让老条目随时间流逝自动掉榜。
  if (v === undefined) {
    const votes = t.phUpvotes ?? 0;
    if (votes >= WATCH_PH_UPVOTES) {
      checks.a4 = true;
      return { tier: "watch", reason: `无流量·PH ${votes} 票（观察区）`, checks };
    }
    const hn = t.hnPoints ?? 0;
    if (hn >= WATCH_HN_POINTS) {
      checks.a4 = true;
      return { tier: "watch", reason: `无流量·HN ${hn} 分（观察区）`, checks };
    }
    return {
      tier: "reject",
      reason: `A4 无流量且社区热度不足（PH ${votes} 票 / HN ${hn} 分）`,
      checks,
    };
  }

  if (v < MIN_VISITS_WATCH) {
    return { tier: "reject", reason: `A4 月访问 ${v.toLocaleString()} < 1,000`, checks };
  }

  checks.a4 = true;

  /*
   * 可信度优先于访问量：Similarweb 自己说样本不足时，数够主榜也放观察区。
   * 页面会照常展示，只是不带 #名次、标「待验证」—— 让它上主榜等于
   * 用一个不可信的数去和真实站排名次。
   */
  if (quality?.dataCoverage === "partial" || quality?.isSmall === true) {
    const why = [
      quality.dataCoverage ? `覆盖度 ${quality.dataCoverage}` : "",
      quality.isSmall ? "Similarweb 标记为小站" : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      tier: "watch",
      reason: `月访问 ${v.toLocaleString()}，但${why || "Similarweb 样本不足"}（观察区）`,
      checks,
      monthlyVisits: v,
    };
  }

  if (v >= MIN_VISITS_CORE) {
    return { tier: "core", reason: `月访问 ${v.toLocaleString()} ≥ 10,000`, checks, monthlyVisits: v };
  }

  const g = momOf(t);
  const declining = typeof g === "number" && g < 0;
  return {
    tier: declining ? "watch" : "core",
    reason: `月访问 ${v.toLocaleString()}（1k–10k）· 环比 ${typeof g === "number" ? `${g}%` : "无数据"}`,
    checks,
    monthlyVisits: v,
  };
}

/* ------------------------------ 待发布条目结构 ------------------------------ */

/**
 * 候选生命周期：
 *   candidate → approved（人工确认可收录）→ enriched（富化完成）→ published（已发榜）
 *   candidate → rejected（人工拒绝；采集侧按 REJECT_COOLDOWN_DAYS=90 天冷却，
 *                        期满后可被重新抓回并回到 candidate）
 */
export type Stage = "candidate" | "approved" | "enriched" | "published" | "rejected";

/** 合法分类枚举（与 AIToolCategory 保持一致，运行期校验用） */
export const VALID_CATEGORIES: readonly string[] = [
  "AI Chat",
  "Image Gen",
  "Video",
  "Voice & Audio",
  "Writing",
  "Coding",
  "Automation",
  "Marketing",
  "Productivity",
  "Data & Analytics",
  "Other",
];

/** 模型偷懒时常见的占位文案，命中即判为「有值但不可信」 */
const PLACEHOLDER_TEXT = /^(n\/?a|none|null|undefined|todo|tbd|待补充|暂无.*|无|-{1,3})$/i;

function plainLength(s: string): number {
  return s.replace(/\s+/g, "").length;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * 页面展示维度：富化后按这些维度统计两类问题——
 *   missing（空置）：字段完全没有值，通常是这次没采到，补采即可
 *   invalid（异常）：有值但不合法，补采也修不好，必须人工核对
 *
 * check 只在「值存在」时被调用，返回非空字符串即视为异常。
 */
export interface FieldDimension {
  key: string;
  label: string;
  check?: (item: StagingItem) => string | null;
}

export const FIELD_DIMENSIONS: readonly FieldDimension[] = [
  {
    key: "description",
    label: "简介",
    check: (t) => {
      const d = typeof t.description === "string" ? t.description.trim() : "";
      if (!d) return null;
      if (PLACEHOLDER_TEXT.test(d)) return "简介是占位文本";
      const len = plainLength(d);
      return len < 20 ? `简介过短（${len} 字）` : null;
    },
  },
  {
    key: "categories",
    label: "分类",
    check: (t) => {
      if (!Array.isArray(t.categories) || t.categories.length === 0) return null;
      const bad = t.categories.filter((c) => !VALID_CATEGORIES.includes(String(c)));
      return bad.length ? `分类不在枚举内：${bad.slice(0, 3).join("、")}` : null;
    },
  },
  {
    key: "trafficMetrics.monthlyVisits",
    label: "月访问量",
    check: (t) => {
      const v = t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits;
      if (typeof v !== "number") return "月访问量不是数字";
      if (!Number.isFinite(v)) return "月访问量不是有效数字";
      return v <= 0 ? "月访问量为 0 或负数" : null;
    },
  },
  {
    key: "trafficMetrics.monthlyVisitsGrowth",
    label: "环比增长",
    check: (t) => {
      const g = momOf(t);
      if (typeof g !== "number") return "环比不是数字";
      if (!Number.isFinite(g)) return "环比不是有效数字";
      if (g < -100) return `环比跌幅超过 100%（${g}%）`;
      if (g > 5000) return `环比涨幅异常（${g}%）`;
      return null;
    },
  },
  {
    key: "metrics.registeredAt",
    label: "域名注册时间",
    check: (t) => {
      const raw = t.metrics?.registeredAt;
      if (typeof raw !== "string" || !raw.trim()) return null;
      const ts = Date.parse(raw);
      if (!Number.isFinite(ts)) return "注册时间无法解析";
      return ts > Date.now() + 86_400_000 ? "注册时间在未来" : null;
    },
  },
  {
    key: "trafficMetrics.organicSearchVisits",
    label: "自然搜索流量",
    check: (t) => {
      // 新方案（vortex）把自然搜索量写在 trafficMetrics；searchTraffic 是 DFS 时代的容器，
      // 已经没有生产者了，继续按它判缺失会让每条都显示「缺自然搜索」。
      const o = t.trafficMetrics?.organicSearchVisits ?? t.searchTraffic?.organic;
      if (typeof o !== "number") return "自然搜索流量不是数字";
      if (!Number.isFinite(o) || o < 0) return "自然搜索流量为负数";
      const total = visitsOf(t);
      // total 为 0 时也属于「总访问比自然搜索还小」，必须报；undefined 才跳过
      if (total !== undefined && o > total * 1.05) {
        return `自然搜索流量 ${Math.round(o).toLocaleString()} 大于总访问 ${Math.round(total).toLocaleString()}`;
      }
      return null;
    },
  },
  {
    key: "geoDistribution",
    label: "地区分布",
    check: (t) => {
      const list = t.geoDistribution;
      if (!Array.isArray(list) || list.length === 0) return null;
      if (list.some((g) => !g?.country || typeof g.share !== "number")) {
        return "地区分布缺国家或占比";
      }
      // DFS 只返回访问量最高的那几个国家，合计天然小于 100%，不能按「偏离 100%」判错；
// 只有合计超过 100% 才是真的重复计算。
      const sum = list.reduce((s, g) => s + (g.share ?? 0), 0);
      return sum > 105 ? `地区占比合计 ${Math.round(sum)}%，超过 100%（疑似重复计算）` : null;
    },
  },
  {
    key: "keywords",
    label: "关键词",
    check: (t) => {
      const list = t.keywords;
      if (!Array.isArray(list) || list.length === 0) return null;
      const empty = list.filter((k) => !k?.term || !String(k.term).trim());
      if (empty.length) return `${empty.length} 个关键词缺词`;
      // DFS 常见缺陷：只拿到词、没拿到搜索量（volume 字段缺失），这种词等于没有参考价值
      const withVolume = list.filter((k) => typeof k.volume === "number" && k.volume > 0);
      return withVolume.length === 0 ? "全部关键词缺搜索量（只有词）" : null;
    },
  },
  /*
   * 「外链概览」维度已移除：外链只有 DFS / Ahrefs 能给，DFS 下线后没有任何采集源
   * 会写 tool.backlinks。留着这一项的结果是——每一条富化完都必然显示「缺外链」，
   * 把一个「暂时没有数据源」误报成「这次没采到」。
   */
  {
    key: "observations.competitors",
    label: "竞品",
    check: (t) => {
      const list = t.observations?.competitors;
      if (!Array.isArray(list) || list.length === 0) return null;
      const self = String(t.domain ?? "").toLowerCase();
      const hit = list.find((c) => {
        const v = String(c).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        return Boolean(self) && (v === self || v.endsWith(`.${self}`) || self.endsWith(`.${v}`));
      });
      if (hit) return `竞品包含自身域名（${hit}）`;
      const bad = list.filter((c) => !String(c).includes("."));
      return bad.length ? `竞品含非法域名：${bad.slice(0, 2).join("、")}` : null;
    },
  },
  {
    key: "pricing",
    label: "定价",
    check: (t) => {
      const list = t.pricing;
      if (!Array.isArray(list) || list.length === 0) return null;
      const bad = list.find((p) => !p?.plan || p.price === undefined || p.price === null || !String(p.price).trim());
      return bad ? "定价缺套餐名或价格" : null;
    },
  },
  {
    key: "pageStructure",
    label: "页面结构",
    check: (t) => {
      const p = t.pageStructure;
      if (!p) return null;
      if (!p.title || !String(p.title).trim()) return "页面结构缺 title";
      return !Array.isArray(p.h1) || p.h1.length === 0 ? "页面结构缺 H1" : null;
    },
  },
  {
    // 详情页 Hero 的桌面截图：有值即视为采到（图能否取到由 R2 / Worker 决定，
    // 这里只统计「富化有没有拍」）；移动版缺失不算问题，故不单列维度。
    key: "screenshotDesktopUrl",
    label: "官网截图",
  },
  {
    key: "siteAudit",
    label: "站点体检",
    check: (t) => {
      const a = t.siteAudit;
      if (!a) return null;
      if (typeof a.wordCount === "number" && a.wordCount <= 0) return "站点正文字数为 0";
      if (typeof a.pageLang === "string" && a.pageLang.trim() && !/^[a-z]{2}(-[a-z]{2,4})?$/i.test(a.pageLang)) {
        return `页面语言标记异常（${a.pageLang}）`;
      }
      return null;
    },
  },
  {
    key: "aiInsight",
    label: "AI 叙事",
    check: (t) => {
      const a = t.aiInsight;
      if (!a) return null;
      // 只查叙事字段：增长/获客/壁垒/收费已归 performanceInsight，新数据里必然为空，
      // 还按老字段判会把「合格的叙事」误判成「无实质段落」
      const parts = [a.intro, a.before, a.now, a.comparison].filter(
        (s): s is string => typeof s === "string" && s.trim().length > 0,
      );
      if (parts.length === 0) return "AI 叙事无实质段落";
      const tooShort = parts.filter((s) => plainLength(s) < 20);
      return tooShort.length === parts.length ? "AI 叙事段落过短" : null;
    },
  },
  {
    key: "performanceInsight",
    label: "AI 判断",
    check: (t) => {
      const p = t.performanceInsight;
      if (!p) return null;
      const filled = (s?: string) => typeof s === "string" && s.trim().length > 0;
      const four = [p.overview?.what, p.overview?.pain, p.overview?.can, p.overview?.trait];
      // 01 板块只渲染这三张卡，缺了就是页面空洞
      const cards = [p.trafficTruth, p.growthEdge, p.moat];
      const missingFour = four.filter((s) => !filled(s)).length;
      const missingCards = cards.filter((s) => !filled(s)).length;
      if (missingFour === four.length && missingCards === cards.length) return "AI 判断无实质内容";
      if (missingFour) return `四要素缺 ${missingFour} 项`;
      if (missingCards) return `01 判断卡缺 ${missingCards} 张`;
      return null;
    },
  },
];

export interface StagingItem extends AITool {
  verdict?: Verdict;
  stage?: Stage;
  /** 富化后仍缺失的页面维度（key 为 FIELD_DIMENSIONS.key） */
  fieldGaps?: string[];
  /** 富化完成时间 */
  enrichedAt?: string;
}

export interface StagingFile {
  updatedAt: string;
  items: StagingItem[];
  rejected: string[];
  lastRun?: {
    at: string;
    requested: number;
    added: number;
    skipped: number;
    /** 只做流量判定的次数（廉价） */
    judged?: number;
    /** 历史字段，保留兼容 */
    enriched?: number;
  };
  lastEnrich?: {
    at: string;
    requested: number;
    ok: number;
    failed: number;
  };
}

/** 取嵌套字段值，用于完整度统计 */
export function fieldValue(item: StagingItem, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, item);
}

/** 判断某维度是否「有值」：空数组、空字符串、0 都算无值 */
export function hasField(item: StagingItem, key: string): boolean {
  const v = fieldValue(item, key);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * 字段「存在」但可能为空：0、空数组、空字符串都算存在。
 * 用来把「没采到」和「采到了但不对」分开统计。
 */
export function isPresent(item: StagingItem, key: string): boolean {
  const v = fieldValue(item, key);
  return v !== undefined && v !== null;
}

/** 富化后算出该条目还缺哪些页面维度（只算空置，不含异常） */
export function computeFieldGaps(item: StagingItem): string[] {
  return FIELD_DIMENSIONS.filter((d) => !hasField(item, d.key)).map((d) => d.key);
}

export interface FieldIssue {
  key: string;
  label: string;
  reason: string;
}

/** 该条目「有值但不合法」的页面维度 */
export function computeFieldIssues(item: StagingItem): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const d of FIELD_DIMENSIONS) {
    if (!d.check) continue;
    // 没有值 → 记空置，不重复记异常；否则同一个字段会被两处统计重复扣分
    if (!isPresent(item, d.key)) continue;
    const reason = d.check(item);
    if (reason) out.push({ key: d.key, label: d.label, reason });
  }
  return out;
}

/**
 * 条目级异常：不属于任何页面维度、但会直接让页面显示错误的问题。
 * 最典型的是官网域名与收录域名对不上（采到了 Product Hunt 页或跳转页）。
 */
export function computeEntryIssues(item: StagingItem): FieldIssue[] {
  const out: FieldIssue[] = [];
  const url = typeof item.url === "string" ? item.url.trim() : "";
  const domain = String(item.domain ?? "").toLowerCase().replace(/^www\./, "");

  if (!url) {
    out.push({ key: "url", label: "官网地址", reason: "官网地址为空" });
  } else if (!/^https?:\/\//i.test(url)) {
    out.push({ key: "url", label: "官网地址", reason: "不是 http(s) 地址" });
  } else if (domain) {
    const host = hostOf(url);
    if (host && host !== domain && !host.endsWith(`.${domain}`) && !domain.endsWith(`.${host}`)) {
      out.push({ key: "url", label: "官网地址", reason: `域名与官网不一致（${host}）` });
    }
  }

  if (!String(item.name ?? "").trim()) {
    out.push({ key: "name", label: "名称", reason: "名称为空" });
  }

  const firstSeen = item.firstSeenAt ? Date.parse(item.firstSeenAt) : NaN;
  if (item.firstSeenAt && !Number.isFinite(firstSeen)) {
    out.push({ key: "firstSeenAt", label: "首次发现时间", reason: "无法解析" });
  }

  return out;
}

/** 需要人工处理的问题总数 = 空置维度 + 异常维度 + 条目级异常（同 key 去重） */
export function countProblems(item: StagingItem): number {
  const keys = new Set<string>([
    ...(item.fieldGaps ?? computeFieldGaps(item)),
    ...computeFieldIssues(item).map((i) => i.key),
    ...computeEntryIssues(item).map((i) => i.key),
  ]);
  return keys.size;
}