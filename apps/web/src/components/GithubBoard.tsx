import Link from "next/link";
import type { GitHubRepo, ProductScore } from "@horizons/shared";
import { computeStarGrowth, categoryLabel, repoIntro, scoreGradeTone } from "@/lib/data";
import { formatCount } from "@/lib/format";

/** 首页 GitHub 榜：综合得分前 N，一屏可扫完 */
export function GithubBoard({
  items,
  total,
}: {
  items: { repo: GitHubRepo; score: ProductScore }[];
  total: number;
}) {
  if (items.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">GitHub 开源榜</h2>
          <p className="mt-1 text-sm text-ink-muted">
            从 {total} 个开源 AI 项目里，按「做成一款有收益产品的可能性」排序
          </p>
        </div>
        <Link
          href="/github"
          className="shrink-0 text-sm font-medium text-primary transition hover:text-primary-hover"
        >
          查看全部 →
        </Link>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface">
        {items.map(({ repo, score }, i) => {
          const growth = computeStarGrowth(repo, 30);
          return (
            <Link
              key={repo.fullName}
              href={`/github/${repo.owner}/${repo.repo}`}
              className="group flex items-center gap-3 border-b border-border px-4 py-3 transition last:border-b-0 hover:bg-surface-2 sm:px-5"
            >
              <span className="w-6 shrink-0 text-sm font-semibold text-ink-muted tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>

              {repo.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={repo.avatarUrl}
                  alt=""
                  loading="lazy"
                  className="h-8 w-8 shrink-0 rounded-md border border-border bg-surface-2 object-cover"
                />
              ) : (
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-[10px] font-semibold text-ink-muted">
                  {(repo.owner || "?").charAt(0).toUpperCase()}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
                    {repo.fullName}
                  </h3>
                  {repo.categories.slice(0, 2).map((c) => (
                    <span
                      key={c}
                      className="hidden shrink-0 rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] leading-4 text-ink-secondary sm:inline"
                    >
                      {categoryLabel(c)}
                    </span>
                  ))}
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-ink-secondary">
                  {repoIntro(repo)}
                </p>
              </div>

              <div className="hidden shrink-0 flex-col items-end gap-0.5 sm:flex">
                <span className="text-xs text-ink-secondary tabular-nums">
                  ★ {formatCount(repo.stars)}
                </span>
                <span
                  className={`text-[11px] tabular-nums ${
                    growth === null ? "text-ink-muted" : growth >= 0 ? "text-emerald-500" : "text-rose-400"
                  }`}
                >
                  {growth !== null ? `30天 ${growth > 0 ? "+" : ""}${growth}%` : "—"}
                </span>
              </div>

              <div className="w-14 shrink-0 text-center">
                <div className="flex items-baseline justify-center gap-1">
                  <span className="text-sm font-bold text-ink tabular-nums">
                    {score.score.toFixed(1)}
                  </span>
                  <span
                    className={`rounded border px-1 text-[10px] font-semibold ${scoreGradeTone[score.grade]}`}
                  >
                    {score.grade}
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}