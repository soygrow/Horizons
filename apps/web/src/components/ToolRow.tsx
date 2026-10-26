import Link from "next/link";
import type { AITool } from "@horizons/shared";
import { ToolIcon } from "./ToolIcon";
import { VerifiedBadge } from "./VerifiedBadge";
import { Sparkline } from "./Sparkline";
import { PricingTag } from "./PricingTag";
import { GrowthBadge } from "./GrowthBadge";
import { derivePricingModel, sparklinePoints, computeGrowth } from "@/lib/data";
import { formatDate, formatCount } from "@/lib/format";

function scaleLabel(tool: AITool): string | null {
  if (tool.githubStars) return `★ ${formatCount(tool.githubStars)}`;
  if (tool.phUpvotes) return `▲ ${formatCount(tool.phUpvotes)}`;
  return null;
}

export function ToolRow({ tool, rank }: { tool: AITool; rank: number }) {
  const pricing = derivePricingModel(tool);
  const points = sparklinePoints(tool);
  const growth = computeGrowth(tool);
  const scale = scaleLabel(tool);

  return (
    <Link
      href={`/tools/${tool.domain}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group grid grid-cols-[2rem_auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 lg:grid-cols-[2.5rem_2.75rem_minmax(0,1.1fr)_minmax(0,1.5fr)_4.5rem_4.5rem_4.5rem_5.5rem_5rem] lg:gap-4"
    >
      {/* 排名 */}
      <span className="text-sm font-semibold text-ink-muted tabular-nums lg:text-base">
        {String(rank).padStart(2, "0")}
      </span>

      {/* 图标 */}
      <ToolIcon domain={tool.domain} name={tool.name} />

      {/* 名称 + 域名 */}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="truncate text-sm font-semibold text-ink group-hover:text-primary">
            {tool.name}
          </h3>
          {tool.verified === "verified" ? <VerifiedBadge /> : null}
        </div>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-muted">
          <span className="truncate">{tool.domain}</span>
          <svg
            className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-100"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
            <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
          </svg>
        </p>
      </div>

      {/* 描述 */}
      <div className="hidden min-w-0 lg:block">
        <p className="line-clamp-2 text-sm leading-snug text-ink-secondary">
          {tool.description}
        </p>
      </div>

      {/* 趋势 */}
      <div className="hidden lg:block">
        <Sparkline points={points} width={64} height={24} />
      </div>

      {/* 规模 */}
      <div className="hidden text-sm text-ink-secondary tabular-nums lg:block">
        {scale ?? <span className="text-ink-muted">—</span>}
      </div>

      {/* 定价 */}
      <div className="hidden lg:block">
        <PricingTag model={pricing} />
      </div>

      {/* 热度 + 涨幅 */}
      <div className="text-right">
        <div className="text-lg font-semibold leading-none text-ink tabular-nums">
          {tool.heatScore}
        </div>
        <div className="mt-1 hidden lg:block">
          <GrowthBadge growth={growth} />
        </div>
      </div>

      {/* 日期 */}
      <div className="hidden text-right text-xs text-ink-muted lg:block">
        {formatDate(tool.collectedAt)}
      </div>
    </Link>
  );
}
