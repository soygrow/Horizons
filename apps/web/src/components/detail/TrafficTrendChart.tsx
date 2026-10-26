"use client";

import { useMemo, useState } from "react";
import type { TrafficTrendPoint } from "@horizons/shared";
import { formatCount } from "@/lib/format";

const W = 760;
const H = 260;
const PAD = { top: 16, right: 16, bottom: 28, left: 48 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = Math.ceil(v / base * 2) / 2 * base;
  return n;
}

/** 流量趋势：双系列折线（总访问量 / 自然搜索），轻量 SVG + hover tooltip */
export function TrafficTrendChart({ points }: { points: TrafficTrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const chart = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const max = niceMax(Math.max(...points.map((p) => p.total), 1));
    const x = (i: number) =>
      PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
    const line = (key: "total" | "organic") =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p[key])}`).join(" ");
    const area = `${line("total")} L${x(points.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;
    const yTicks = [0, max / 2, max];
    return { x, y, line, area, max, yTicks, innerW, innerH };
  }, [points]);

  const active = hover !== null ? points[hover] : null;

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const innerW = chart.innerW;
    const ratio = Math.min(Math.max((px - PAD.left) / innerW, 0), 1);
    setHover(Math.round(ratio * (points.length - 1)));
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="流量趋势图"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* 网格与 Y 轴刻度 */}
        {chart.yTicks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={chart.y(t)}
              y2={chart.y(t)}
              className="stroke-border"
              strokeWidth="1"
              strokeDasharray={t === 0 ? undefined : "4 4"}
            />
            <text
              x={PAD.left - 8}
              y={chart.y(t) + 4}
              textAnchor="end"
              className="fill-current text-[11px] text-ink-muted"
              style={{ fill: "var(--c-ink-muted)" }}
            >
              {formatCount(Math.round(t))}
            </text>
          </g>
        ))}

        {/* X 轴月份 */}
        {points.map((p, i) => {
          const step = Math.ceil(points.length / 8);
          if (i % step !== 0 && i !== points.length - 1) return null;
          return (
            <text
              key={p.date}
              x={chart.x(i)}
              y={H - 8}
              textAnchor="middle"
              style={{ fill: "var(--c-ink-muted)" }}
              fontSize="11"
            >
              {p.date.slice(2).replace("-", "/")}
            </text>
          );
        })}

        {/* 总访问量面积 + 双折线 */}
        <path d={chart.area} fill="var(--c-primary)" opacity="0.06" />
        <path
          d={chart.line("total")}
          fill="none"
          stroke="var(--c-primary)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path
          d={chart.line("organic")}
          fill="none"
          stroke="var(--c-ocean)"
          strokeWidth="2"
          strokeDasharray="5 3"
          strokeLinejoin="round"
        />

        {/* hover 指示 */}
        {hover !== null ? (
          <g>
            <line
              x1={chart.x(hover)}
              x2={chart.x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="stroke-border-strong"
              strokeWidth="1"
            />
            <circle cx={chart.x(hover)} cy={chart.y(points[hover].total)} r="3.5" fill="var(--c-primary)" />
            <circle cx={chart.x(hover)} cy={chart.y(points[hover].organic)} r="3.5" fill="var(--c-ocean)" />
          </g>
        ) : null}
      </svg>

      <div className="mt-2 flex items-center justify-center gap-5 text-xs text-ink-secondary">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px] bg-primary" aria-hidden />
          总访问量
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px] bg-ocean" aria-hidden />
          自然搜索
        </span>
      </div>

      {/* tooltip */}
      <div className="mt-1 h-5 text-center text-xs tabular-nums text-ink-muted" aria-live="polite">
        {active
          ? `${active.date} · 总访问量 ${formatCount(active.total)} · 自然搜索 ${formatCount(active.organic)}`
          : ""}
      </div>
    </div>
  );
}
