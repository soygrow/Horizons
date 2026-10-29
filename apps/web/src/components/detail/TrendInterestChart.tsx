"use client";

import { useMemo, useState } from "react";

const W = 820;
const H = 280;
const PAD = { top: 18, right: 18, bottom: 26, left: 34 };

/** 相邻点中点作控制点的二次贝塞尔，曲线圆滑且不越界 */
function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < n - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)} ${xc.toFixed(1)},${yc.toFixed(1)}`;
  }
  const last = pts[n - 1];
  d += ` L${last.x.toFixed(1)},${last.y.toFixed(1)}`;
  return d;
}

/**
 * 搜索热度曲线（Google Trends 口径）：
 * - y 轴固定 0–100，方便不同关键词横向对比
 * - 虚线为历史基线，峰值单独标记
 * - 数值是归一化相对热度，不是搜索次数
 */
export function TrendInterestChart({
  points,
  baseline,
  peakDate,
}: {
  points: { date: string; value: number }[];
  baseline: number | null;
  peakDate: string | null;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const chart = useMemo(() => {
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const x = (i: number) =>
      PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const y = (v: number) => PAD.top + innerH - (v / 100) * innerH;
    const coords = points.map((p, i) => ({ x: x(i), y: y(p.value) }));
    const peakIndex = points.reduce(
      (best, p, i) => (p.value > points[best].value ? i : best),
      0,
    );
    return { innerW, innerH, x, y, coords, peakIndex };
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-border">
        <span className="text-sm text-ink-muted">暂无热度序列，等待采集</span>
      </div>
    );
  }

  const { coords, peakIndex, y } = chart;
  const line = smoothPath(coords);
  const peak = coords[peakIndex];
  const last = coords[coords.length - 1];
  const active = hover ?? null;
  const tickStep = Math.max(1, Math.ceil(points.length / 6));

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full text-accent"
        role="img"
        aria-label="近 30 天搜索热度曲线"
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* 横向刻度：0 / 25 / 50 / 75 / 100 */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line
              x1={PAD.left}
              y1={y(v)}
              x2={W - PAD.right}
              y2={y(v)}
              stroke="currentColor"
              strokeWidth="1"
              className="text-border"
              opacity="0.6"
            />
            <text x={4} y={y(v) + 3} className="fill-current text-[10px] text-ink-muted">
              {v}
            </text>
          </g>
        ))}

        {/* 历史基线 */}
        {baseline !== null ? (
          <g>
            <line
              x1={PAD.left}
              y1={y(baseline)}
              x2={W - PAD.right}
              y2={y(baseline)}
              stroke="currentColor"
              className="text-ink-muted"
              strokeWidth="1"
              strokeDasharray="4 4"
              opacity="0.8"
            />
            <text
              x={W - PAD.right}
              y={y(baseline) - 5}
              textAnchor="end"
              className="fill-current text-[10px] text-ink-muted"
            >
              历史基线 {baseline}
            </text>
          </g>
        ) : null}

        <path d={`${line} L${last.x},${H - PAD.bottom} L${coords[0].x},${H - PAD.bottom} Z`} fill="url(#trendFill)" />
        <path
          d={line}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* 峰值标记 */}
        <circle cx={peak.x} cy={peak.y} r="3.5" fill="currentColor" />
        <text
          x={Math.min(peak.x, W - PAD.right - 60)}
          y={Math.max(peak.y - 8, PAD.top + 10)}
          className="fill-current text-[10px] text-ink-secondary"
        >
          峰值 {points[peakIndex].value}
          {peakDate ? ` · ${peakDate.slice(5)}` : ""}
        </text>

        {/* 最新点 */}
        <circle cx={last.x} cy={last.y} r="3" fill="currentColor" />

        {/* x 轴日期 */}
        {points.map((p, i) =>
          i % tickStep === 0 || i === points.length - 1 ? (
            <text
              key={p.date}
              x={chart.x(i)}
              y={H - 8}
              textAnchor="middle"
              className="fill-current text-[10px] text-ink-muted"
            >
              {p.date.slice(5)}
            </text>
          ) : null,
        )}

        {/* hover 命中区 */}
        {points.map((p, i) => (
          <rect
            key={p.date}
            x={chart.x(i) - chart.innerW / (points.length - 1 || 1) / 2}
            y={PAD.top}
            width={chart.innerW / (points.length - 1 || 1)}
            height={chart.innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}

        {active !== null ? (
          <circle cx={coords[active].x} cy={coords[active].y} r="4" fill="currentColor" stroke="white" strokeWidth="1" />
        ) : null}
      </svg>

      {active !== null ? (
        <div
          className="pointer-events-none absolute -translate-x-1/2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs shadow-sm"
          style={{
            left: `${(coords[active].x / W) * 100}%`,
            top: `${(coords[active].y / H) * 100}%`,
            transform: "translate(-50%, -130%)",
          }}
        >
          <div className="font-medium text-ink">{points[active].date}</div>
          <div className="text-ink-secondary">相对热度 {points[active].value} / 100</div>
        </div>
      ) : null}
    </div>
  );
}