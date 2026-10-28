import type { Metadata } from "next";
import type { GitHubRepo } from "@horizons/shared";
import {
  githubRepos,
  getGithubLanguages,
  computeStarGrowth,
  isPermissiveLicense,
  categoryLabel,
  repoIntro,
  repoDifficulty,
  repoScore,
} from "@/lib/data";
import { SearchInput } from "@/components/SearchInput";
import { FilterGroup } from "@/components/FilterGroup";
import { RepoListRow, REPO_GRID } from "@/components/RepoListRow";
import { Pagination } from "@/components/Pagination";
import { getDict, format as tf } from "@/lib/i18n";

export const metadata: Metadata = { title: "GitHub 榜" };

const PAGE_SIZE = 12;

interface Query {
  q: string;
  cat: string;
  lang: string;
  license: string;
  diff: string;
  sort: string;
  page: number;
}

function parseSearchParams(sp: Record<string, string | string[] | undefined>): Query {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v ?? "");
  return {
    q: one(sp.q),
    cat: one(sp.cat) || "All",
    lang: one(sp.lang) || "All",
    license: one(sp.license) || "all",
    diff: one(sp.diff) || "all",
    sort: one(sp.sort) || "score",
    page: Math.max(1, parseInt(one(sp.page) || "1", 10) || 1),
  };
}

function buildHref(query: Query, patch: Partial<Query>): string {
  const next = { ...query, ...patch, page: patch.page ?? 1 };
  const sp = new URLSearchParams();
  if (next.q) sp.set("q", next.q);
  if (next.cat !== "All") sp.set("cat", next.cat);
  if (next.lang !== "All") sp.set("lang", next.lang);
  if (next.license !== "all") sp.set("license", next.license);
  if (next.diff !== "all") sp.set("diff", next.diff);
  if (next.sort !== "score") sp.set("sort", next.sort);
  if (next.page > 1) sp.set("page", String(next.page));
  const s = sp.toString();
  return `/github${s ? `?${s}` : ""}`;
}

function filterRepos(query: Query): GitHubRepo[] {
  const q = query.q.trim().toLowerCase();
  let list = githubRepos.filter((r) => {
    if (q) {
      const hay = `${r.fullName} ${r.description ?? ""} ${repoIntro(r)}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (query.cat !== "All" && !r.categories.includes(query.cat)) return false;
    if (query.lang !== "All" && r.language !== query.lang) return false;
    if (query.license === "yes" && !isPermissiveLicense(r)) return false;
    if (query.diff !== "all" && repoDifficulty(r) !== query.diff) return false;
    return true;
  });
  if (query.sort === "7d") {
    list = [...list].sort(
      (a, b) => (computeStarGrowth(b, 7) ?? -Infinity) - (computeStarGrowth(a, 7) ?? -Infinity),
    );
  } else if (query.sort === "30d") {
    list = [...list].sort(
      (a, b) => (computeStarGrowth(b, 30) ?? -Infinity) - (computeStarGrowth(a, 30) ?? -Infinity),
    );
  } else if (query.sort === "stars") {
    list = [...list].sort((a, b) => b.stars - a.stars);
  } else {
    // 默认：综合得分（做成一款有收益产品的可能性）
    list = [...list].sort((a, b) => repoScore(b).score - repoScore(a).score || b.stars - a.stars);
  }
  return list;
}

export default async function GithubPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = parseSearchParams(await searchParams);
  const filtered = filterRepos(query);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(query.page, totalPages);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const g = getDict("zh").github;

  const activeCats = Array.from(new Set(githubRepos.flatMap((r) => r.categories)));
  const catOptions = [
    { value: "All", label: g.list.all },
    ...activeCats.map((c) => ({ value: c, label: categoryLabel(c) })),
  ];
  const langOptions = [
    { value: "All", label: g.list.all },
    ...getGithubLanguages().map((l) => ({ value: l, label: l })),
  ];
  const licenseOptions = [
    { value: "all", label: g.list.all },
    { value: "yes", label: g.list.licenseYes },
  ];
  const diffOptions = [
    { value: "all", label: g.list.all },
    { value: "低", label: "低" },
    { value: "中", label: "中" },
    { value: "高", label: "高" },
  ];

  const scores = githubRepos.map((r) => repoScore(r));
  const permissiveCount = githubRepos.filter(isPermissiveLicense).length;
  const easyCount = githubRepos.filter((r) => repoDifficulty(r) === "低").length;
  const topCount = scores.filter((s) => s.grade === "S" || s.grade === "A").length;
  const avgScore = scores.reduce((s, x) => s + x.score, 0) / (scores.length || 1);

  const sortLink = (sort: string, label: string) => (
    <a
      href={buildHref(query, { sort })}
      className={
        query.sort === sort
          ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
          : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary transition hover:text-ink"
      }
    >
      {label}
    </a>
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{g.list.title}</h1>
        <p className="mt-2 text-sm text-ink-secondary">{g.list.subtitle}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            共 {githubRepos.length} 个可开发项目
          </span>
          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 text-emerald-500">
            S/A 级 {topCount} 个
          </span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            可商用 {permissiveCount} 个
          </span>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-ink-secondary">
            低难度 {easyCount} 个
          </span>
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-primary">
            平均综合得分 {avgScore.toFixed(1)}
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-muted">
          综合得分 = 热度 15 + 增长 15 + 可开发性 20 + 商业化 30 + 活跃度 10 + 落地门槛 10，衡量「用它做出一款有收益产品的可能性」。无官网项目同样收录，仅在商业化项少计分。
        </p>
        <div className="mt-5">
          <SearchInput defaultValue={query.q} action="/github" />
        </div>
      </header>

      <div className="mt-6 space-y-3">
        <FilterGroup
          title={g.list.filterCat}
          options={catOptions}
          current={query.cat}
          makeHref={(v) => buildHref(query, { cat: v })}
        />
        <FilterGroup
          title={g.list.filterLang}
          options={langOptions}
          current={query.lang}
          makeHref={(v) => buildHref(query, { lang: v })}
        />
        <FilterGroup
          title="上手难度"
          options={diffOptions}
          current={query.diff}
          makeHref={(v) => buildHref(query, { diff: v })}
        />
        <FilterGroup
          title={g.list.filterLicense}
          options={licenseOptions}
          current={query.license}
          makeHref={(v) => buildHref(query, { license: v })}
        />
      </div>

      <div className="mt-6 flex items-center justify-between">
        <span className="text-sm text-ink-muted">
          {tf(g.list.results, { n: rows.length, total: filtered.length, pages: totalPages })}
        </span>
        <div className="flex items-center gap-1">
          {sortLink("score", g.list.sortScore)}
          {sortLink("stars", g.list.sortStars)}
          {sortLink("7d", g.list.sort7d)}
          {sortLink("30d", g.list.sort30d)}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl border border-border bg-surface">
        <div className="min-w-[1080px]">
          <div
            className={`grid items-center gap-4 border-b border-border px-4 py-2.5 text-xs text-ink-muted sm:px-5 ${REPO_GRID}`}
          >
            <span>{g.cols.rank}</span>
            <span>{g.cols.repo}</span>
            <span className="text-right">{g.cols.score}</span>
            <span className="text-center">{g.cols.trend}</span>
            <span className="text-right">{g.cols.stars}</span>
            <span className="text-right">{g.cols.growth}</span>
            <span>{g.cols.lang}</span>
            <span>{g.cols.cat}</span>
            <span>{g.cols.updated}</span>
            <span>{g.cols.license}</span>
          </div>
          {rows.length > 0 ? (
            rows.map((r, i) => (
              <RepoListRow key={r.fullName} repo={r} rank={(page - 1) * PAGE_SIZE + i + 1} />
            ))
          ) : (
            <div className="px-4 py-16 text-center">
              <p className="text-sm text-ink-muted">{g.list.empty}</p>
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