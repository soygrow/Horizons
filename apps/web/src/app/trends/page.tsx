import type { Metadata } from "next";
import Link from "next/link";
import type { AITrend, TrendStatus } from "@horizons/shared";
import {
  overallScore,
  sortTrends,
  trendCategoryLabels,
  trendKeywords,
  trendPolicy,
  trendRankMap,
  trendStatusMeta,
  trendsUpdatedAt,
  type TrendSort,
} from "@/lib/trends";
import { SearchInput } from "@/components/SearchInput";
import { FilterGroup } from "@/components/FilterGroup";
import { Pagination } from "@/components/Pagination";
import { TrendListHead, TrendListRow } from "@/components/TrendListRow";
import { formatDateShort } from "@/lib/format";

export const metadata: Metadata = {
  title: "AI 趋势词榜单",
  description:
    "以 Google Trends 搜索证据为基础的 AI 趋势词榜单：按综合得分排名，区分正在爆发、持续增长与新词观察，并给出为什么升温、可以做什么。",
};

/** 单页 50 行，支撑 1000–2000 量级的榜单 */
const PAGE_SIZE = 50;

interface Query {
  q: string;
  cat: string;
  status: string;
  conf: string;
  sort: TrendSort;
  page: number;
}

function parseSearchParams(sp: Record<string, string | string[] | undefined>): Query {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : (v ?? ""));
  const sort = one(sp.sort);
  return {
    q: one(sp.q),
    cat: one(sp.cat) || "All",
    status: one(sp.status) || "all",
    conf: one(sp.conf) || "all",
    sort: (["overall", "trend", "opp", "growth", "newest"].includes(sort)
      ? sort
      : "overall") as TrendSort,
    page: Math.max(1, parseInt(one(sp.page) || "1", 10) || 1),
  };
}

function buildHref(query: Query, patch: Partial<Query>): string {
  const next = { ...query, ...patch, page: patch.page ?? 1 };
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.cat !== "All") sp.set("cat", next.cat);
  if (next.status !== "all") sp.set("status", next.status);
  if (next.conf !== "all") sp.set("conf", next.conf);
  if (next.sort !== "overall") sp.set("sort", next.sort);
  if (next.page > 1) sp.set("page", String(next.page));
  const s = sp.toString();
  return `/trends${s ? `?${s}` : ""}`;
}

function filterTrends(query: Query): AITrend[] {
  const q = query.q.trim().toLowerCase();
  const list = trendKeywords.filter((t) => {
    if (q) {
      const hay = [
        t.keyword,
        t.normalizedName,
        t.why,
        t.intentSummary ?? "",
        ...(t.relatedQueries ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (query.cat !== "All" && t.category !== query.cat) return false;
    if (query.status !== "all" && t.status !== query.status) return false;
    if (query.conf !== "all" && t.confidence !== query.conf) return false;
    return true;
  });
  return sortTrends(list, query.sort);
}

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSearchParams(await searchParams);

  const filtered = filterTrends(query);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, totalPages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const ranks = trendRankMap();

  const counts = {
    breaking: trendKeywords.filter((t) => t.status === "breaking").length,
    gaining: trendKeywords.filter((t) => t.status === "gaining").length,
    fresh: trendKeywords.filter((t) => t.status === "new").length,
    cooling: trendKeywords.filter((t) => t.status === "cooling").length,
    high: trendKeywords.filter((t) => t.confidence === "high").length,
  };
  const topScore = Math.max(...trendKeywords.map((t) => overallScore(t)));

  const catOptions = [
    { value: "All", label: "全部" },
    ...Object.entries(trendCategoryLabels).map(([value, label]) => ({ value, label })),
  ];
  const statusOptions = [
    { value: "all", label: "全部" },
    ...(["breaking", "gaining", "new", "cooling"] as TrendStatus[]).map((s) => ({
      value: s,
      label: trendStatusMeta[s].label,
    })),
  ];
  const confOptions = [
    { value: "all", label: "全部" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
  ];

  const sortLink = (sort: TrendSort, label: string) => (
    <Link
      href={buildHref(query, { sort })}
      className={
        query.sort === sort
          ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
          : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary transition hover:text-ink"
      }
    >
      {label}
    </Link>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">AI 趋势词榜单</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-secondary">
          不是告诉你「什么正在流行」，而是告诉你「什么正在升温、为什么升温、现在可以做什么」。
          榜单按综合得分排名，每个词都能追溯到搜索热度证据、事件来源与可执行的机会方向。
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            共 {trendKeywords.length} 个关键词
          </span>
          <span className="rounded-full border border-rose-400/25 bg-rose-400/10 px-2.5 py-1 text-rose-400">
            正在爆发 {counts.breaking}
          </span>
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-emerald-500">
            持续增长 {counts.gaining}
          </span>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary">
            新词观察 {counts.fresh}
          </span>
          {counts.cooling > 0 ? (
            <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-muted">
              热度回落 {counts.cooling}
            </span>
          ) : null}
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            高可信度 {counts.high}
          </span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-muted">
            快照 {formatDateShort(trendsUpdatedAt)}
          </span>
        </div>

        <div className="mt-5">
          <SearchInput defaultValue={query.q} action="/trends" />
        </div>
      </header>

      <div className="mt-6 space-y-3">
        <FilterGroup
          title="类别"
          options={catOptions}
          current={query.cat}
          makeHref={(v) => buildHref(query, { cat: v })}
        />
        <FilterGroup
          title="阶段"
          options={statusOptions}
          current={query.status}
          makeHref={(v) => buildHref(query, { status: v })}
        />
        <FilterGroup
          title="可信度"
          options={confOptions}
          current={query.conf}
          makeHref={(v) => buildHref(query, { conf: v })}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-ink-muted">
          综合得分 = 0.6 × 趋势强度 + 0.4 × 机会潜力（满分 100）
          <span className="mx-1.5 text-ink-muted">·</span>
          <span className="text-ink-secondary">
            {filtered.length === trendKeywords.length
              ? `当前 ${filtered.length} 个词，最高分 ${topScore.toFixed(1)}`
              : `筛选结果 ${filtered.length} 个 / 共 ${trendKeywords.length} 个 · 第 ${page} / ${totalPages} 页`}
          </span>
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {sortLink("overall", "综合得分")}
          {sortLink("trend", "趋势强度")}
          {sortLink("opp", "机会潜力")}
          {sortLink("growth", "近 7 天增长")}
          {sortLink("newest", "最新发现")}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
        <div className="min-w-[1260px]">
          <TrendListHead />
          {rows.length > 0 ? (
            rows.map((t) => (
              <TrendListRow key={t.slug} trend={t} rank={ranks.get(t.slug) ?? null} />
            ))
          ) : (
            <div className="px-4 py-16 text-center">
              <p className="text-sm text-ink-muted">没有匹配的关键词，换个筛选条件试试。</p>
              <Link href="/trends" className="mt-2 inline-block text-xs text-primary hover:underline">
                重置筛选
              </Link>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6">
        <Pagination page={page} totalPages={totalPages} makeHref={(p) => buildHref(query, { page: p })} />
      </div>

      <section className="mt-10 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-ink">分数是怎么来的</h2>
        <div className="mt-3 grid gap-3 text-xs leading-relaxed text-ink-secondary sm:grid-cols-3">
          <p>
            <span className="font-medium text-ink">综合得分 S</span>
            = 0.6 × 趋势强度 T + 0.4 × 机会潜力 O。名次由 S 从高到低排定，同分先比 T，再比近 7 天增长。
          </p>
          <p>
            <span className="font-medium text-ink">趋势强度 T</span>
            = 0.30 增长幅度 + 0.25 持续性 + 0.20 爆发强度 + 0.15 新颖度 + 0.10 数据可靠性。
            回答「这个词是否值得关注」。
          </p>
          <p>
            <span className="font-medium text-ink">机会潜力 O</span>
            = 0.30 用户需求证据 + 0.25 可切入空间 + 0.20 搜索与内容机会 + 0.15 独立开发可行性 +
            0.10 趋势时机。回答「是否值得投入时间做产品或 SEO」。
          </p>
        </div>
        <p className="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-ink-muted">
          名次是全站名次，筛选与切换排序都不会改变它。采样点少于 14 个的关键词显示「数据不足」，
          不参与排名、不强行给分。
        </p>
      </section>

      {trendPolicy ? (
        <section className="mt-6 rounded-2xl border border-border bg-surface p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">什么词能进这个榜</h2>
            <span className="text-xs text-ink-muted">
              收录标准 v{trendPolicy.version} · {formatDateShort(trendPolicy.updatedAt.slice(0, 10))} 更新
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-secondary">
            标准只回答一件事：一个独立开发者看到这个词，明天有没有能开工的事。
            每次采集都会拿没通过判定的词回头审计这套标准，所以它会随市场变化，而不是一次定死的规则。
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-ink">收：有可落地的切口</p>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-secondary">
                {trendPolicy.accept.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span className="text-emerald-500">·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-xs font-medium text-ink">拒：看着热但没有切入点</p>
              <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-ink-muted">
                {trendPolicy.reject.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span>·</span>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}