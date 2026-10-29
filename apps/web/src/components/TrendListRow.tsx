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
  trendCategoryLabels,
  trendMetrics,
  trendScore,
  trendSparkline,
} from "@/lib/trends";

/**
 * 10 列：关键词 / 类别 / 状态 / 增长 / 可信度 / 为什么升温 / 机会方向 / 双分 / 更新
 * 「趋势证据」与「机会判断」两组信息在行内分区呈现，分数只作排序依据。
 */
export const TREND_GRID =
  "grid-cols-[2.25rem_minmax(0,1.9fr)_5.5rem_5.5rem_6.5rem_4.5rem_minmax(0,1.7fr)_6.5rem_4.5rem_4.75rem]";

export function TrendListHead() {
  return (
    <div
      className={`grid items-center gap-3 border-b border-border px-4 py-2.5 text-xs text-ink-muted sm:px-5 ${TREND_GRID}`}
    >
      <span>#</span>
      <span>关键词 / 标准名称</span>
      <span>类别</span>
      <span>趋势状态</span>
      <span>增长（近 7 天）</span>
      <span>可信度</span>
      <span>为什么值得关注</span>
      <span>可能的机会</span>
      <span className="text-center">趋势/机会</span>
      <span className="text-center">更新</span>
    </div>
  );
}

export function TrendListRow({ trend, rank }: { trend: AITrend; rank: number }) {
  const m = trendMetrics(trend);
  const spark = trendSparkline(trend);
  const scored = hasEnoughData(trend);
  const tv = trendScore(trend);
  const op = opportunityScore(trend);
  const seenDays = daysSince(trend.firstSeenAt);
  const oppTypes = Array.from(new Set(trend.opportunities.map((o) => o.type))).slice(0, 2);

  return (
    <Link
      href={`/trends/${trend.slug}`}
      className={`group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${TREND_GRID}`}
    >
      <span className="text-sm font-semibold tabular-nums text-ink-muted">
        {String(rank).padStart(2, "0")}
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

      <div className="flex flex-col items-center gap-0.5 text-[11px] tabular-nums">
        {scored ? (
          <>
            <span className="text-ink">
              趋势 <span className="font-semibold">{tv.toFixed(0)}</span>
            </span>
            <span className="text-ink-muted">
              机会 <span className="font-semibold text-ink-secondary">{op.toFixed(0)}</span>
            </span>
          </>
        ) : (
          <span className="text-ink-muted" title="采样点不足 14 个，暂不评分">
            数据不足
          </span>
        )}
      </div>

      <span className="text-center text-[11px] tabular-nums text-ink-muted">
        {formatDateShort(trend.updatedAt)}
      </span>
    </Link>
  );
}