// 每日情报：采集层数据结构
// 这一层只做「拿到什么」，不做判断；判断在 verify/score 阶段完成。

export type SourceName = "hackernews" | "github" | "rss";

/** 一条原始信息（帖子 / 仓库 / 文章），不是「事件」 */
export interface RawItem {
  /** `${source}:${sourceItemId}`，稳定可复现 */
  id: string;
  source: SourceName;
  sourceItemId: string;
  title: string;
  /** 规范化后的链接 */
  url: string;
  author: string | null;
  /** 原始发布时间，ISO；来源未给时为 null */
  publishedAt: string | null;
  fetchedAt: string;
  /** 首次被系统看到的时间（跨天去重索引提供），用于「首次发现」展示 */
  firstSeenAt: string | null;
  /** 是否在之前某天的采集里出现过（旧闻重发信号） */
  repeat: boolean;
  /** 粗分类，只用于后续分配模块，不作为入选依据 */
  category: string | null;
  /** 来源内信号：points / comments / stars / starDelta，跨源不可直接相加 */
  signals: Record<string, number>;
  /** 该源支持「官方一手材料」时为 true（仓库、官方博客等） */
  firstHand: boolean;
  /** 采集时命中的关键词，便于回溯为什么被捞上来 */
  matched: string[];
  /** 精简后的原始载荷，便于人工复核 */
  raw: Record<string, unknown>;
}

export interface SourceReport {
  source: string;
  ok: boolean;
  items: number;
  /** 源内重复（同一仓库被多个查询命中） */
  duplicates: number;
  ms: number;
  error: string | null;
  note?: string;
}

export interface RawDigest {
  date: string;
  fetchedAt: string;
  windowHours: number;
  stats: {
    sources: number;
    okSources: number;
    candidates: number;
    unique: number;
    duplicates: number;
  };
  sources: SourceReport[];
  items: RawItem[];
}

/* ---------- 事件层：多条原始信息 → 一个事件 ---------- */

/** 合并后的一个「事件」，是打分和成稿的基本单位 */
export interface Event {
  /** evt_YYYYMMDD_nn，同一天内稳定 */
  id: string;
  /** 合并进本事件的原始条目，[0] 为主条目（信号最强的那个） */
  items: RawItem[];
  /** 去重后的来源类型数；转载不算独立来源 */
  sourceCount: number;
  /** true 表示是靠标题相似度合并的，属于「边界样本」，需要人工复核 */
  mergedByTitle: boolean;
}

/* ---------- 成稿层 ---------- */

export type EvidenceLevel = "verified" | "pending" | "rumor";
export type ModuleKey = "headline" | "model" | "oss" | "business" | "action" | "rumor";

export interface DigestSource {
  type: "official" | "repo" | "community" | "media";
  label: string;
  url: string;
  verified: boolean;
}

export interface DigestItem {
  id: string;
  /** 原文标题（本版不做机器翻译，保留可核对的原题） */
  title: string;
  summary: string;
  why: string;
  category: string;
  evidence: EvidenceLevel;
  /** 内部保留，前端只映射热度档位 */
  score: number;
  /** 1–5 */
  heat: number;
  firstSeenAt: string | null;
  sources: DigestSource[];
  /** 供页面展示的关键量：points / stars / starPerDay 等，来自原始材料 */
  signals: Record<string, number>;
  /** 缺什么证据（pending 时必填） */
  missing?: string;
}

export interface Digest {
  date: string;
  generatedAt: string;
  stats: { candidates: number; merged: number; verified: number; published: number };
  modules: Array<{ key: ModuleKey; items: DigestItem[] }>;
  sourceHealth: SourceReport[];
}

/** GitHub Star 采样历史：只保留最近若干次，用于算增量而不是累计值 */
export interface StarSample {
  at: string;
  stars: number;
}

export type StarState = Record<string, StarSample[]>;