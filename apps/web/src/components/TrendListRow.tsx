import Link from "next/link";
import type { AITrend } from "@horizons/shared";
import { Sparkline } from "./Sparkline";
import { TrendConfidenceBadge, TrendStatusBadge } from "./TrendBadges";
import { formatDateShort } from "@/lib/format";
import {
  daysSince,
  formatGrowth,
  growthTone,
  hasEnoughData,
  opportunityScore,
  opportunityTypeMeta,
  overallScore,
  scoreTone,
  trendCategoryLabels,
  trendMetrics,
  trendScore,
  trendSparkline,
} from "@/lib/trends";

/**
 * 10 列：# 名次 / 关键词 / 类别 / 状态 / 综合得分 / 增长 / 可信度 / 为什么 / 机会方向 / 更新
 * 名次由综合得分（0.6 趋势 + 0.4 机会）在全站范围内决定，筛选与切换排序都不改变名次。
 */
export const TREND_GRID =
  "grid-cols-[2.5rem_minmax(0,1.8fr)_5.5rem_5.25rem_4.75rem_6.25rem_3.5rem_minmax(0,1.6fr)_6rem_4.5rem]";

export function TrendListHead() {
  return (
    <div
      className={`grid items-center gap-3 border-b border-border px-4 py-2.5 text-xs text-ink-muted sm:px-5 ${TREND_GRID}`}
    >
      <span>#</span>
      <span>关键词 / 标准名称</span>
      <span>类别</span>
      <span>趋势状态</span>
      <span className="text-center">综合得分</span>
      <span>增长（近 7 天）</span>
      <span className="text-center">可信度</span>
      <span>为什么值得关注</span>
      <span>可能的机会</span>
      <span className="text-center">更新</span>
    </div>
  );
}

export function TrendListRow({ trend, rank }: { trend: AITrend; rank: number | null }) {
  const m = trendMetrics(trend);
  const spark = trendSparkline(trend);
  const scored = hasEnoughData(trend);
  const tv = trendScore(trend);
  const op = opportunityScore(trend);
  const overall = overallScore(trend);
  const seenDays = daysSince(trend.firstSeenAt);
  const oppTypes = Array.from(new Set(trend.opportunities.map((o) => o.type))).slice(0, 2);

  return (
    <Link
      href={`/trends/${trend.slug}`}
      className={`group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${TREND_GRID}`}
    >
      <span
        className={`text-sm font-semibold tabular-nums ${
          rank !== null && rank <= 3 ? "text-primary" : "text-ink-muted"
        }`}
        title={rank !== null ? `全站第 ${rank} 名` : "数据不足，不参与排名"}
      >
        {rank !== null ? rank : "—"}
      </span>

      <div className="min-w-0">
        <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
          {trend.normalizedName}
        </h3>
        <p className="mt-0.5 truncate text-xs text-ink-muted">
          <span className="font-mono">{trend.keyword}</span>
          {seenDays !== null ? <span className="ml-2">首次发现 {seenDays} 天</span> : null}
        </p>
      </div>

      <span className="truncate text-xs text-ink-secondary" title={trendCategoryLabels[trend.category]}>
        {trendCategoryLabels[trend.category]}
      </span>

      <div className="min-w-0">
        <TrendStatusBadge status={trend.status} />
      </div>

      <div className="flex flex-col items-center gap-0.5 text-[11px] tabular-nums">
        {scored ? (
          <>
            <span className={`text-base font-bold ${scoreTone(overall)}`}>{overall.toFixed(1)}</span>
            <span className="text-[10px] text-ink-muted">
              T {tv.toFixed(0)} · O {op.toFixed(0)}
            </span>
          </>
        ) : (
          <span className="text-ink-muted" title="采样点不足 14 个，暂不评分">
            数据不足
          </span>
        )}
      </div>

      <div className="flex flex-col items-start gap-0.5">
        <Sparkline points={spark} width={84} height={22} />
        <span className={`text-[11px] tabular-nums ${growthTone(m.growth7)}`}>
          {formatGrowth(m.growth7)}
          <span className="ml-1 text-ink-muted">基线 {m.baseline ?? "—"}</span>
        </span>
      </div>

      <TrendConfidenceBadge confidence={trend.confidence} showLabel={false} />

      <p className="line-clamp-2 text-xs leading-snug text-ink-secondary">{trend.why}</p>

      <div className="flex flex-wrap gap-1">
        {oppTypes.map((t) => (
          <span
            key={t}
            className={`rounded-md border px-1.5 py-0.5 text-[10px] leading-4 ${opportunityTypeMeta[t].cls}`}
          >
            {opportunityTypeMeta[t].label.replace("机会", "")}
          </span>
        ))}
        <span className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] leading-4 text-ink-muted">
          {trend.opportunities.length} 个方向
        </span>
      </div>

      <span className="text-center text-[11px] tabular-nums text-ink-muted">
        {formatDateShort(trend.updatedAt)}
      </span>
    </Link>
  );
}