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

/** 单调三次平滑（Fritsch–Carlson，同 d3 curveMonotoneX）：曲线柔和且严格不越出数据范围，0 基线不会下冲 */
function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

  const dx: number[] = [];
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slopes[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }

  // 各点切线：拐点处归零，单调段取加权调和平均
  const m: number[] = new Array(n);
  m[0] = slopes[0];
  m[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i]);
    }
  }

  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const cx1 = pts[i].x + dx[i] / 3;
    const cy1 = pts[i].y + (m[i] * dx[i]) / 3;
    const cx2 = pts[i + 1].x - dx[i] / 3;
    const cy2 = pts[i + 1].y - (m[i + 1] * dx[i]) / 3;
    d += ` C${cx1.toFixed(1)},${cy1.toFixed(1)} ${cx2.toFixed(1)},${cy2.toFixed(1)} ${pts[i + 1].x},${pts[i + 1].y}`;
  }
  return d;
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
    const coords = (key: "total" | "organic") =>
      points.map((p, i) => ({ x: x(i), y: y(p[key]) }));
    const line = (key: "total" | "organic") => smoothPath(coords(key));
    const area = `${smoothPath(coords("total"))} L${x(points.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;
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
        {/* 每月数值标签（常驻可见） */}
        {points.map((p, i) => (
          <text
            key={`v-${p.date}`}
            x={chart.x(i)}
            y={Math.max(chart.y(p.total) - 6, PAD.top + 8)}
            textAnchor="middle"
            fontSize="10"
            style={{ fill: "var(--c-ink-secondary)" }}
          >
            {formatCount(p.total)}
          </text>
        ))}
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
