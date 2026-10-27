import Link from "next/link";
import type { AITool } from "@horizons/shared";
import { ToolIcon } from "./ToolIcon";
import { VerifiedBadge } from "./VerifiedBadge";
import { Sparkline } from "./Sparkline";
import {
  trafficSparklinePoints,
  getMonthlyVisits,
  getMoMGrowth,
  getOrganicVisits,
  getDomainWeight,
  getLaunchedAt,
} from "@/lib/data";
import { formatDate, formatCount } from "@/lib/format";

const GRID =
  "grid-cols-[2.5rem_minmax(0,1.3fr)_minmax(0,1.4fr)_5rem_minmax(0,1fr)_5.5rem_4.5rem_5.5rem_4rem_5.5rem]";

export function ToolListRow({ tool, rank }: { tool: AITool; rank: number }) {
  const traffic = trafficSparklinePoints(tool);
  const visits = getMonthlyVisits(tool);
  const growth = getMoMGrowth(tool);
  const organic = getOrganicVisits(tool);
  const dw = getDomainWeight(tool);
  const launched = getLaunchedAt(tool);

  return (
    <Link
      href={`/tools/${tool.domain}`}
      target="_blank"
      rel="noopener noreferrer"
      className={`group grid items-center gap-4 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${GRID}`}
    >
      {/* 排名 */}
      <span className="text-sm font-semibold text-ink-muted tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>

      {/* 名称 + 域名 */}
      <div className="flex min-w-0 items-center gap-2.5">
        <ToolIcon domain={tool.domain} name={tool.name} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
              {tool.name}
            </h3>
            {tool.verified === "verified" ? <VerifiedBadge /> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-muted">{tool.domain}</p>
        </div>
      </div>

      {/* 描述 */}
      <p className="line-clamp-2 text-sm leading-snug text-ink-secondary">
        {tool.description}
      </p>

      {/* 流量趋势：缩小版 6 个月曲线 */}
      <div className="flex justify-center">
        <Sparkline points={traffic} width={64} height={24} />
      </div>

      {/* 分类 */}
      <div className="min-w-0">
        <div className="flex flex-wrap gap-1">
          {tool.categories.slice(0, 2).map((c) => (
            <span
              key={c}
              className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-secondary"
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {/* 月访问量 */}
      <div className="text-right text-sm text-ink-secondary tabular-nums">
        {visits !== undefined ? formatCount(visits) : "—"}
      </div>

      {/* 环比增长 */}
      <div
        className={`text-right text-sm tabular-nums ${
          growth === undefined
            ? "text-ink-muted"
            : growth >= 0
              ? "text-accent"
              : "text-rose-400"
        }`}
      >
        {growth !== undefined ? `${growth > 0 ? "+" : ""}${growth}%` : "—"}
      </div>

      {/* 自然搜索量 */}
      <div className="text-right text-sm text-ink-secondary tabular-nums">
        {organic !== undefined ? formatCount(organic) : "—"}
      </div>

      {/* 域名权重（DR） */}
      <div className="text-right text-sm text-ink-secondary tabular-nums">
        {dw.value !== undefined ? `${formatCount(dw.value)} ${dw.label ?? "DR"}` : "—"}
      </div>

      {/* 注册时间 */}
      <div className="text-right text-xs text-ink-muted">
        {launched ? formatDate(launched) : "—"}
      </div>
    </Link>
  );
}
