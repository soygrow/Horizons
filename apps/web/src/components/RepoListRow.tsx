import Link from "next/link";
import type { GitHubRepo } from "@horizons/shared";
import { Sparkline } from "./Sparkline";
import { formatCount } from "@/lib/format";
import {
  computeStarGrowth,
  starSparklinePoints,
  isPermissiveLicense,
  categoryLabel,
  repoIntro,
  repoDifficulty,
  repoScore,
  repoUpdatedDays,
  scoreGradeTone,
} from "@/lib/data";

/**
 * 10 列：排名 / 项目（含 logo）/ 综合得分 / 星标趋势 / 星标 / 近30天 / 语言 / 用途 / 更新 / 许可
 * 趋势与用途各留出更宽的空间：趋势放完整 30 天折线，用途按「一行两个」展示全部分类。
 */
export const REPO_GRID =
  "grid-cols-[2.5rem_minmax(0,2.4fr)_5.5rem_6.5rem_5rem_4.5rem_4.5rem_9rem_4.5rem_5rem]";

export function RepoListRow({ repo, rank }: { repo: GitHubRepo; rank: number }) {
  const spark = starSparklinePoints(repo, 30);
  const growth30 = computeStarGrowth(repo, 30);
  const diff = repoDifficulty(repo);
  const score = repoScore(repo);
  const days = repoUpdatedDays(repo);

  const diffCls =
    diff === "低"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
      : diff === "高"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
        : "border-border bg-surface-2 text-ink-secondary";

  return (
    <Link
      href={`/github/${repo.owner}/${repo.repo}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${REPO_GRID}`}
    >
      <span className="text-sm font-semibold text-ink-muted tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>

      <div className="flex min-w-0 items-start gap-2.5">
        {/* 与详情页一致的项目 logo（GitHub 头像） */}
        {repo.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={repo.avatarUrl}
            alt=""
            loading="lazy"
            className="mt-0.5 h-7 w-7 shrink-0 rounded-md border border-border bg-surface-2 object-cover"
          />
        ) : (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-[10px] font-semibold text-ink-muted">
            {(repo.owner || "?").charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
              {repo.fullName}
            </h3>
            <span className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${diffCls}`}>
              {diff}
            </span>
          </div>
          {/* 简介：优先中文定位，否则展示 GitHub 原始简介 */}
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-secondary">{repoIntro(repo)}</p>
        </div>
      </div>

      {/* 综合得分（排序依据） */}
      <div className="text-center">
        <div className="flex items-baseline justify-center gap-1">
          <span className="text-sm font-bold tabular-nums text-ink">{score.score.toFixed(1)}</span>
          <span className={`rounded border px-1 text-[10px] font-semibold ${scoreGradeTone[score.grade]}`}>
            {score.grade}
          </span>
        </div>
        <div className="mx-auto mt-1 h-1 w-14 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(4, score.score))}%` }}
          />
        </div>
      </div>

      <div className="flex justify-center">
        <Sparkline points={spark} width={88} height={26} />
      </div>

      <div className="text-center text-sm text-ink-secondary tabular-nums">
        {formatCount(repo.stars)}
      </div>

      <div
        className={`text-center text-sm tabular-nums ${
          growth30 === null ? "text-ink-muted" : growth30 >= 0 ? "text-emerald-500" : "text-rose-400"
        }`}
      >
        {growth30 !== null ? `${growth30 > 0 ? "+" : ""}${growth30}%` : "—"}
      </div>

      <div className="truncate text-center text-xs text-ink-secondary">{repo.language ?? "—"}</div>

      {/* 用途：与详情页一致展示全部分类，一行两个 */}
      {repo.categories.length ? (
        <div className="grid grid-cols-2 gap-1">
          {repo.categories.map((c) => (
            <span
              key={c}
              title={categoryLabel(c)}
              className="truncate rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-center text-[10px] leading-4 text-ink-secondary"
            >
              {categoryLabel(c)}
            </span>
          ))}
        </div>
      ) : (
        <span className="block text-center text-xs text-ink-secondary">—</span>
      )}

      <div
        className="text-center text-xs text-ink-muted"
        title="距项目最后一次提交（GitHub push）的天数"
      >
        {days === null ? "—" : days === 0 ? "今天" : `${days} 天前`}
      </div>

      <div
        className={`truncate text-center text-xs ${
          repo.license ? (isPermissiveLicense(repo) ? "text-emerald-500" : "text-amber-500") : "text-ink-muted"
        }`}
      >
        {repo.license?.spdx ?? "—"}
      </div>
    </Link>
  );
}