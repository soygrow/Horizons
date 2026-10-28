/** 平滑路径：相邻点中点作二次贝塞尔控制点，曲线圆滑无尖角 */
function smoothPath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 2) return "";
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < n - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)} ${xc.toFixed(1)},${yc.toFixed(1)}`;
  }
  d += ` L${pts[n - 1].x.toFixed(1)},${pts[n - 1].y.toFixed(1)}`;
  return d;
}

export function Sparkline({
  points,
  width = 72,
  height = 26,
}: {
  points: number[] | null;
  width?: number;
  height?: number;
}) {
  // 无快照：渲染占位虚线（趋势待积累）
  if (!points) {
    const mid = height / 2;
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="text-ink-muted"
        aria-label="趋势待积累"
      >
        <line
          x1="0"
          y1={mid}
          x2={width}
          y2={mid}
          stroke="currentColor"
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.4"
        />
      </svg>
    );
  }

  const step = width / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: i * step,
    y: height - p * (height - 4) - 2,
  }));
  const d = smoothPath(coords);
  const last = coords[coords.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-accent"
      aria-label="流量趋势"
    >
      <path
        d={`${d} L${width},${height} L0,${height} Z`}
        fill="currentColor"
        opacity="0.12"
      />
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last.x} cy={last.y} r="2" fill="currentColor" />
    </svg>
  );
}
