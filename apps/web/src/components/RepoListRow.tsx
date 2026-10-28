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

/** 10 列：排名 / 项目 / 综合得分 / 星标趋势 / 星标 / 近30天 / 语言 / 用途 / 更新 / 许可 */
export const REPO_GRID =
  "grid-cols-[2.5rem_minmax(0,2.4fr)_5.5rem_4.5rem_5rem_4.5rem_4.5rem_5rem_4.5rem_5rem]";

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
      className={`group grid items-center gap-4 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${REPO_GRID}`}
    >
      <span className="text-sm font-semibold text-ink-muted tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>

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

      {/* 综合得分（排序依据） */}
      <div className="text-right">
        <div className="flex items-baseline justify-end gap-1">
          <span className="text-sm font-bold tabular-nums text-ink">{score.score.toFixed(1)}</span>
          <span className={`rounded border px-1 text-[10px] font-semibold ${scoreGradeTone[score.grade]}`}>
            {score.grade}
          </span>
        </div>
        <div className="ml-auto mt-1 h-1 w-14 overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.min(100, Math.max(4, score.score))}%` }}
          />
        </div>
      </div>

      <div className="flex justify-center">
        <Sparkline points={spark} width={64} height={24} />
      </div>

      <div className="text-right text-sm text-ink-secondary tabular-nums">
        {formatCount(repo.stars)}
      </div>

      <div
        className={`text-right text-sm tabular-nums ${
          growth30 === null ? "text-ink-muted" : growth30 >= 0 ? "text-emerald-500" : "text-rose-400"
        }`}
      >
        {growth30 !== null ? `${growth30 > 0 ? "+" : ""}${growth30}%` : "—"}
      </div>

      <div className="truncate text-xs text-ink-secondary">{repo.language ?? "—"}</div>

      <div className="truncate text-xs text-ink-secondary">
        {repo.categories[0] ? categoryLabel(repo.categories[0]) : "—"}
      </div>

      <div
        className="text-xs text-ink-muted"
        title="距项目最后一次提交（GitHub push）的天数"
      >
        {days === null ? "—" : days === 0 ? "今天" : `${days} 天前`}
      </div>

      <div
        className={`truncate text-xs ${
          repo.license ? (isPermissiveLicense(repo) ? "text-emerald-500" : "text-amber-500") : "text-ink-muted"
        }`}
      >
        {repo.license?.spdx ?? "—"}
      </div>
    </Link>
  );
}