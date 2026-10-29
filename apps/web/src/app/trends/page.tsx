import type { Metadata } from "next";
import Link from "next/link";
import type { AITrend, TrendStatus } from "@horizons/shared";
import {
  trendCategoryLabels,
  trendDataMode,
  trendKeywords,
  trendStatusMeta,
  trendsByStatus,
  trendsUpdatedAt,
  sortTrends,
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
    "以 Google Trends 搜索证据为基础的 AI 趋势词榜单：区分正在爆发、持续增长与新词观察，并给出为什么升温、可以做什么。",
};

const PAGE_SIZE = 20;
/** 默认视图每个分区展示的行数 */
const SECTION_SIZE = 6;

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
    sort: (["trend", "opp", "growth", "newest"].includes(sort) ? sort : "trend") as TrendSort,
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
  if (next.sort !== "trend") sp.set("sort", next.sort);
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

const SECTIONS: { status: TrendStatus; note: string }[] = [
  { status: "breaking", note: "近期增长显著、高于历史基线，且有多时点证据排除单点噪声" },
  { status: "gaining", note: "不追求单日爆发，但多个时间点持续升温，更适合做稳定选题" },
  { status: "new", note: "最近才发现、历史数据不足，值得观察但不能宣称已爆发" },
];

export default async function TrendsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSearchParams(await searchParams);
  const isDefault =
    !query.q && query.cat === "All" && query.status === "all" && query.conf === "all";

  const filtered = filterTrends(query);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, totalPages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const counts = {
    breaking: trendKeywords.filter((t) => t.status === "breaking").length,
    gaining: trendKeywords.filter((t) => t.status === "gaining").length,
    fresh: trendKeywords.filter((t) => t.status === "new").length,
    cooling: trendKeywords.filter((t) => t.status === "cooling").length,
    high: trendKeywords.filter((t) => t.confidence === "high").length,
  };

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
          每个词都能追溯到搜索热度证据、事件来源与可执行的机会方向。
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
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            高可信度 {counts.high}
          </span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-muted">
            快照 {formatDateShort(trendsUpdatedAt)}
          </span>
        </div>

        {trendDataMode === "seed" ? (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-500">
            当前榜单为「结构演示数据」（seed）：字段结构与计算口径已按正式方案落地，分数由序列确定性计算；
            接入 Google Trends 采集后标记为 live，提示自动消失。热度数值为 0–100 归一化相对热度，不代表搜索次数。
          </p>
        ) : null}

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
          {isDefault
            ? "默认按三区展示：新词值得观察，持续增长适合做内容，快速爆发可能需要立即行动。"
            : `筛选结果 ${filtered.length} 个 · 第 ${page} / ${totalPages} 页`}
        </span>
        <div className="flex items-center gap-1">
          {sortLink("trend", "趋势强度")}
          {sortLink("opp", "机会潜力")}
          {sortLink("growth", "近 7 天增长")}
          {sortLink("newest", "最新发现")}
        </div>
      </div>

      {isDefault ? (
        <>
          {SECTIONS.map((section) => {
            const list = trendsByStatus(section.status, SECTION_SIZE);
            const total = trendKeywords.filter((t) => t.status === section.status).length;
            return (
              <section key={section.status} className="mt-8">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
                      <span className={`h-2 w-2 rounded-full ${trendStatusMeta[section.status].dot}`} />
                      {trendStatusMeta[section.status].label}
                      <span className="text-sm font-normal text-ink-muted">{total} 个</span>
                    </h2>
                    <p className="mt-1 text-xs text-ink-muted">{section.note}</p>
                  </div>
                  <Link
                    href={buildHref(query, { status: section.status })}
                    className="text-xs text-primary hover:underline"
                  >
                    查看全部 {total} 个 →
                  </Link>
                </div>

                <div className="mt-3 overflow-x-auto rounded-2xl border border-border bg-surface">
                  <div className="min-w-[1220px]">
                    <TrendListHead />
                    {list.length > 0 ? (
                      list.map((t, i) => <TrendListRow key={t.slug} trend={t} rank={i + 1} />)
                    ) : (
                      <div className="px-4 py-10 text-center text-sm text-ink-muted">
                        暂无符合条件的词
                      </div>
                    )}
                  </div>
                </div>
              </section>
            );
          })}

          {counts.cooling > 0 ? (
            <section className="mt-10">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-ink">
                    <span className="h-2 w-2 rounded-full bg-ink-muted" />
                    热度回落
                    <span className="text-sm font-normal text-ink-muted">{counts.cooling} 个</span>
                  </h2>
                  <p className="mt-1 text-xs text-ink-muted">
                    已低于爆发峰值并向基线回归，仅作参照，不作为机会推荐
                  </p>
                </div>
                <Link
                  href={buildHref(query, { status: "cooling" })}
                  className="text-xs text-primary hover:underline"
                >
                  查看全部 →
                </Link>
              </div>
              <div className="mt-3 overflow-x-auto rounded-2xl border border-border bg-surface">
                <div className="min-w-[1220px]">
                  <TrendListHead />
                  {trendsByStatus("cooling", SECTION_SIZE).map((t, i) => (
                    <TrendListRow key={t.slug} trend={t} rank={i + 1} />
                  ))}
                </div>
              </div>
            </section>
          ) : null}

          <section className="mt-10 rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold text-ink">分数是怎么来的</h2>
            <div className="mt-3 grid gap-3 text-xs leading-relaxed text-ink-secondary sm:grid-cols-2">
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
              两个分数不混用：热度高的词未必是好机会，竞争可能已经饱和。采样点少于 14 个的关键词显示「数据不足」，
              不强行评分、不参与排名。
            </p>
          </section>
        </>
      ) : (
        <>
          <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
            <div className="min-w-[1220px]">
              <TrendListHead />
              {rows.length > 0 ? (
                rows.map((t, i) => (
                  <TrendListRow key={t.slug} trend={t} rank={(page - 1) * PAGE_SIZE + i + 1} />
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
        </>
      )}
    </div>
  );
}