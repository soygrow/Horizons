import type { Metadata } from "next";
import {
  listedTools,
  allCategories,
  categoryLabel,
  getMonthlyVisits,
  getMoMGrowth,
  getOrganicShare,
  getLaunchedAt,
  getToolRankMap,
} from "@/lib/data";
import { SearchInput } from "@/components/SearchInput";
import { FilterGroup } from "@/components/FilterGroup";
import { FilterSelect } from "@/components/FilterSelect";
import { ToolListHead } from "@/components/ToolListHead";
import { ToolListRow } from "@/components/ToolListRow";
import { Pagination } from "@/components/Pagination";

import { compareByToolScore } from "@horizons/shared";
import type { AITool } from "@horizons/shared";

export const metadata: Metadata = { title: "AI工具榜" };

const PAGE_SIZE = 20;

const visitOptions = [
  { value: "all", label: "全部" },
  { value: "lt1k", label: "1K 以下" },
  { value: "1k10k", label: "1K–10K" },
  { value: "10k100k", label: "10K–100K" },
  { value: "100k1m", label: "100K–1M" },
  { value: "gt1m", label: "1M 以上" },
];

const growthOptions = [
  { value: "all", label: "全部" },
  { value: "neg", label: "下降" },
  { value: "0_50", label: "0–50%" },
  { value: "50_200", label: "50–200%" },
  { value: "gt200", label: "200% 以上" },
];

const orgOptions = [
  { value: "all", label: "全部" },
  { value: "lt10", label: "10% 以下" },
  { value: "10_30", label: "10–30%" },
  { value: "30_60", label: "30–60%" },
  { value: "gt60", label: "60% 以上" },
];

const regOptions = [
  { value: "all", label: "全部" },
  { value: "3m", label: "近 3 个月" },
  { value: "6m", label: "近 6 个月" },
  { value: "1y", label: "近 1 年" },
  { value: "gt1y", label: "1 年以上" },
];

function matchVisits(v: number | undefined, sel: string): boolean {
  if (sel === "all") return true;
  if (v === undefined) return false;
  if (sel === "lt1k") return v < 1000;
  if (sel === "1k10k") return v >= 1000 && v < 10_000;
  if (sel === "10k100k") return v >= 10_000 && v < 100_000;
  if (sel === "100k1m") return v >= 100_000 && v < 1_000_000;
  if (sel === "gt1m") return v >= 1_000_000;
  return true;
}
function matchGrowth(g: number | undefined, sel: string): boolean {
  if (sel === "all") return true;
  if (g === undefined) return false;
  if (sel === "neg") return g < 0;
  if (sel === "0_50") return g >= 0 && g < 50;
  if (sel === "50_200") return g >= 50 && g < 200;
  if (sel === "gt200") return g >= 200;
  return true;
}
function matchOrg(s: number | undefined, sel: string): boolean {
  if (sel === "all") return true;
  if (s === undefined) return false;
  if (sel === "lt10") return s < 10;
  if (sel === "10_30") return s >= 10 && s < 30;
  if (sel === "30_60") return s >= 30 && s < 60;
  if (sel === "gt60") return s >= 60;
  return true;
}
function matchReg(launched: string | undefined, sel: string): boolean {
  if (sel === "all") return true;
  if (!launched) return false;
  const age = (Date.now() - new Date(launched).getTime()) / 86_400_000;
  if (sel === "3m") return age < 90;
  if (sel === "6m") return age >= 90 && age < 180;
  if (sel === "1y") return age >= 180 && age < 365;
  if (sel === "gt1y") return age >= 365;
  return true;
}

interface Query {
  q: string;
  cat: string;
  visits: string;
  growth: string;
  org: string;
  reg: string;
  sort: string;
  page: number;
}

function parseSearchParams(sp: Record<string, string | string[] | undefined>): Query {
  const one = (v: string | string[] | undefined) =>
    Array.isArray(v) ? v[0] : v ?? "";
  return {
    q: one(sp.q),
    cat: one(sp.cat) || "All",
    visits: one(sp.visits) || "all",
    growth: one(sp.growth) || "all",
    org: one(sp.org) || "all",
    reg: one(sp.reg) || "all",
    sort: one(sp.sort) || "heat",
    page: Math.max(1, parseInt(one(sp.page) || "1", 10) || 1),
  };
}

function buildHref(query: Query, patch: Partial<Query>): string {
  const next = { ...query, ...patch, page: patch.page ?? 1 };
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.cat !== "All") sp.set("cat", next.cat);
  if (next.visits !== "all") sp.set("visits", next.visits);
  if (next.growth !== "all") sp.set("growth", next.growth);
  if (next.org !== "all") sp.set("org", next.org);
  if (next.reg !== "all") sp.set("reg", next.reg);
  if (next.sort !== "heat") sp.set("sort", next.sort);
  if (next.page > 1) sp.set("page", String(next.page));
  const s = sp.toString();
  return `/tools${s ? `?${s}` : ""}`;
}

function filterTools(query: Query): AITool[] {
  const q = query.q.trim().toLowerCase();

  let list = listedTools.filter((t) => {
    if (q) {
      const hay = `${t.name} ${t.domain} ${t.description}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (query.cat !== "All" && !t.categories.includes(query.cat as never)) {
      return false;
    }
    if (!matchVisits(getMonthlyVisits(t), query.visits)) return false;
    if (!matchGrowth(getMoMGrowth(t), query.growth)) return false;
    if (!matchOrg(getOrganicShare(t), query.org)) return false;
    if (!matchReg(getLaunchedAt(t), query.reg)) return false;
    return true;
  });

  if (query.sort === "recent") {
    list = [...list].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
  } else {
    // 默认按综合得分（tps-v1）降序：规模 30 / 增长 20 / 搜索 15 / 热度 15 / DR 10 / 机会分 10
    list = [...list].sort(compareByToolScore);
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
  // 名次取自全库综合得分排名，与分页/筛选无关
  const rankMap = getToolRankMap();

  const categoryOptions = [
    { value: "All", label: "全部" },
    ...allCategories.map((c) => ({ value: c, label: categoryLabel(c) })),
  ];
  const raw = buildHref(query, {});
  const baseQueryStr = raw.includes("?") ? raw.split("?")[1] : "";

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
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

      {/* 筛选 */}
      <div className="mt-6 space-y-3">
        <FilterGroup
          title="类别"
          options={categoryOptions}
          current={query.cat}
          makeHref={(v) => buildHref(query, { cat: v })}
        />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <FilterSelect title="月访问量" param="visits" options={visitOptions} current={query.visits} baseQueryStr={baseQueryStr} />
          <FilterSelect title="环比增长" param="growth" options={growthOptions} current={query.growth} baseQueryStr={baseQueryStr} />
          <FilterSelect title="自然搜索占比" param="org" options={orgOptions} current={query.org} baseQueryStr={baseQueryStr} />
          <FilterSelect title="上线时间" param="reg" options={regOptions} current={query.reg} baseQueryStr={baseQueryStr} />
        </div>
      </div>

      {/* meta 行 */}
      <div className="mt-6 text-sm text-ink-muted">
        显示 {rows.length} 项，共 {filtered.length} 项 / {totalPages} 页
      </div>

      {/* 列表 */}
      <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
        <div className="min-w-[1080px]">
          <ToolListHead />
          {rows.length > 0 ? (
            rows.map((t) => (
              <ToolListRow key={t.id} tool={t} rank={rankMap.get(t.domain) ?? 0} />
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
    </div>
  );
}
