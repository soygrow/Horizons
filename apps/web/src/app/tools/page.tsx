import type { Metadata } from "next";
import { tools, allCategories, derivePricingModel } from "@/lib/data";
import { SearchInput } from "@/components/SearchInput";
import { FilterGroup } from "@/components/FilterGroup";
import { ToolListHead } from "@/components/ToolListHead";
import { ToolListRow } from "@/components/ToolListRow";
import { Pagination } from "@/components/Pagination";
import { PaywallBanner } from "@/components/PaywallBanner";
import type { AITool } from "@horizons/shared";

export const metadata: Metadata = { title: "AI工具榜" };

const PAGE_SIZE = 5;

const pricingOptions = [
  { value: "all", label: "全部" },
  { value: "free", label: "免费" },
  { value: "freemium", label: "免费增值" },
  { value: "paid", label: "付费" },
];

const recencyOptions = [
  { value: "all", label: "全部" },
  { value: "7", label: "近 7 天" },
  { value: "30", label: "近 30 天" },
  { value: "90", label: "近 90 天" },
];

interface Query {
  q: string;
  cat: string;
  pricing: string;
  recent: string;
  sort: string;
  page: number;
}

function parseSearchParams(sp: Record<string, string | string[] | undefined>): Query {
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v ?? "";
  return {
    q: one(sp.q),
    cat: one(sp.cat) || "All",
    pricing: one(sp.pricing) || "all",
    recent: one(sp.recent) || "all",
    sort: one(sp.sort) || "heat",
    page: Math.max(1, parseInt(one(sp.page) || "1", 10) || 1),
  };
}

function buildHref(query: Query, patch: Partial<Query>): string {
  const next = { ...query, ...patch, page: patch.page ?? 1 };
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.cat !== "All") sp.set("cat", next.cat);
  if (next.pricing !== "all") sp.set("pricing", next.pricing);
  if (next.recent !== "all") sp.set("recent", next.recent);
  if (next.sort !== "heat") sp.set("sort", next.sort);
  if (next.page > 1) sp.set("page", String(next.page));
  const s = sp.toString();
  return `/tools${s ? `?${s}` : ""}`;
}

function filterTools(query: Query): AITool[] {
  const q = query.q.trim().toLowerCase();
  const now = Date.now();
  const recentDays = parseInt(query.recent, 10) || 0;

  let list = tools.filter((t) => {
    if (q) {
      const hay = `${t.name} ${t.domain} ${t.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (query.cat !== "All" && !t.categories.includes(query.cat as never)) {
      return false;
    }
    if (query.pricing !== "all") {
      const m = derivePricingModel(t);
      if (m !== query.pricing) return false;
    }
    if (recentDays > 0) {
      const age = (now - new Date(t.firstSeenAt).getTime()) / 86_400_000;
      if (age > recentDays) return false;
    }
    return true;
  });

  if (query.sort === "recent") {
    list = [...list].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  } else {
    list = [...list].sort((a, b) => b.heatScore - a.heatScore);
  }
  return list;
}

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSearchParams(await searchParams);
  const filtered = filterTools(query);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, totalPages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const categoryOptions = [
    { value: "All", label: "全部" },
    ...allCategories.map((c) => ({ value: c, label: c })),
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
          AI 工具站榜单
        </h1>
        <p className="mt-2 text-sm text-ink-secondary">
          按可追溯信号排序的高密度榜单，实时追踪值得关注的 AI 工具。
        </p>
        <div className="mt-6">
          <SearchInput defaultValue={query.q} />
        </div>
      </header>

      {/* 分组筛选 */}
      <div className="mt-6 space-y-3">
        <FilterGroup
          title="类别"
          options={categoryOptions}
          current={query.cat}
          makeHref={(v) => buildHref(query, { cat: v })}
        />
        <FilterGroup
          title="定价"
          options={pricingOptions}
          current={query.pricing}
          makeHref={(v) => buildHref(query, { pricing: v })}
        />
        <FilterGroup
          title="上线时间"
          options={recencyOptions}
          current={query.recent}
          makeHref={(v) => buildHref(query, { recent: v })}
        />
      </div>

      {/* meta 行 */}
      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-ink-muted">
          显示 {rows.length} 项，共 {filtered.length} 项 / {totalPages} 页
        </span>
        <div className="flex items-center gap-1">
          <a
            href={buildHref(query, { sort: "heat" })}
            className={
              query.sort === "heat"
                ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary hover:text-ink"
            }
          >
            按热度
          </a>
          <a
            href={buildHref(query, { sort: "recent" })}
            className={
              query.sort === "recent"
                ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary hover:text-ink"
            }
          >
            按最新
          </a>
        </div>
      </div>

      {/* 列表 */}
      <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
        <div className="min-w-[1080px]">
          <ToolListHead />
          {rows.length > 0 ? (
            rows.map((t, i) => (
              <ToolListRow key={t.id} tool={t} rank={(page - 1) * PAGE_SIZE + i + 1} />
            ))
          ) : (
            <div className="px-4 py-16 text-center">
              <p className="text-sm text-ink-muted">没有符合条件的工具</p>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6">
        <Pagination
          page={page}
          totalPages={totalPages}
          makeHref={(p) => buildHref(query, { page: p })}
        />
      </div>

      <div className="mt-10">
        <PaywallBanner total={tools.length} />
      </div>
    </div>
  );
}
