import Link from "next/link";
import type { AITool } from "@horizons/shared";
import { ToolIcon } from "./ToolIcon";
import { Sparkline } from "./Sparkline";
import { TOOL_GRID } from "./ToolListHead";
import {
  trafficSparklinePoints,
  getMonthlyVisits,
  getMoMGrowth,
  getOrganicVisits,
  getDomainWeight,
  getLaunchedAt,
  categoryLabel,
} from "@/lib/data";
import { formatDateShort, formatCount } from "@/lib/format";

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
      className={`group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${TOOL_GRID}`}
    >
      {/* 排名 */}
      <span className="text-center text-sm font-semibold text-ink-muted tabular-nums">
        {String(rank).padStart(2, "0")}
      </span>

      {/* 名称 + 域名 */}
      <div className="flex min-w-0 items-center justify-start gap-2.5">
        <ToolIcon domain={tool.domain} name={tool.name} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
              {tool.name}
            </h3>
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-muted">{tool.domain}</p>
        </div>
      </div>

      {/* 描述 */}
      <p className="line-clamp-2 text-left text-sm leading-snug text-ink-secondary">
        {tool.description}
      </p>

      {/* 流量趋势：缩小版 6 个月曲线 */}
      <div className="flex justify-center">
        <Sparkline points={traffic} width={88} height={28} />
      </div>

      {/* 分类：每个类别单独一行，不换行 */}
      <div className="flex flex-col items-center gap-1">
        {tool.categories.slice(0, 2).map((c) => (
          <span
            key={c}
            className="whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-secondary"
          >
            {categoryLabel(c)}
          </span>
        ))}
      </div>

      {/* 月访问量 */}
      <div className="text-center text-sm text-ink-secondary tabular-nums">
        {visits !== undefined ? formatCount(visits) : "n/a"}
      </div>

      {/* 环比增长：无上月基数时显示 n/a，避免「—」被误读成负号 */}
      <div
        title={growth === undefined ? "上月无数据，无法计算环比" : undefined}
        className={`text-center text-sm tabular-nums ${
          growth === undefined
            ? "text-ink-muted"
            : growth >= 0
              ? "text-accent"
              : "text-rose-400"
        }`}
      >
        {growth !== undefined ? `${growth > 0 ? "+" : ""}${growth}%` : "n/a"}
      </div>

      {/* 自然搜索量 */}
      <div className="text-center text-sm text-ink-secondary tabular-nums">
        {organic !== undefined ? formatCount(organic) : "n/a"}
      </div>

      {/* 域名权重（DR）：0 是有效值，采不到才显示 n/a */}
      <div
        title={dw.value === undefined ? "未采集到域名权重" : undefined}
        className="text-center text-sm text-ink-secondary tabular-nums"
      >
        {dw.value !== undefined ? `${formatCount(dw.value)} ${dw.label ?? "DR"}` : "n/a"}
      </div>

      {/* 注册时间 */}
      <div className="whitespace-nowrap text-center text-sm text-ink-secondary tabular-nums">
        {formatDateShort(launched)}
      </div>
    </Link>
  );
}
