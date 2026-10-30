/** 每日情报：构建期读取 content/digest/*.json（由 scripts/fetch/daily 生成） */

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

export interface Digest {
  date: string;
  generatedAt: string;
  stats: { candidates: number; merged: number; verified: number; published: number };
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

/** 日期倒序：最新一期在最前 */
export const digests: Digest[] = Object.entries(RAW)
  .map(([path, mod]) => mod.default ?? (mod as unknown as Digest))
  .filter((d) => Boolean(d?.date) && Array.isArray(d.modules))
  .sort((a, b) => b.date.localeCompare(a.date));

export const latestDigest: Digest | null = digests[0] ?? null;

export function digestByDate(date: string): Digest | null {
  return digests.find((d) => d.date === date) ?? null;
}

export const MODULE_META: Record<ModuleKey, { no: string; name: string; desc: string }> = {
  headline: { no: "01", name: "今日头条", desc: "当天影响面最大的几条" },
  model: { no: "02", name: "模型与产品", desc: "能力边界与调用成本的变化" },
  oss: { no: "03", name: "开源与工具", desc: "能直接下载、自部署的东西" },
  business: { no: "04", name: "商业与赚钱信号", desc: "价格、融资与格局变化" },
  action: { no: "05", name: "今天就能做", desc: "半小时内可验证的动作" },
  rumor: { no: "06", name: "未证实观察区", desc: "只是信号，不进头条" },
};

/** 采集侧的分类键是英文的，页面一律显示中文 */
export const CATEGORY_LABEL: Record<string, string> = {
  model_release: "模型发布",
  product_launch: "产品发布",
  open_source: "开源项目",
  ai_agent: "Agent",
  ai_coding: "AI 编程",
  business: "商业",
  other: "其他",
};

export function categoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key;
}

export const EVIDENCE_META: Record<
  EvidenceLevel,
  { label: string; cls: string; dot: string }
> = {
  verified: {
    label: "已核验",
    cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  pending: {
    label: "待核实",
    cls: "border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  rumor: {
    label: "传闻",
    cls: "border-border bg-surface-2 text-ink-muted",
    dot: "bg-ink-muted",
  },
};

/** 2026-10-30 → 2026-10-30 周五 */
export function formatDate(date: string): string {
  const d = new Date(`${date}T00:00:00+08:00`);
  const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short", timeZone: "Asia/Shanghai" });
  return `${date} ${weekday.format(d)}`;
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