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
  const coords = points.map((p, i) => {
    const x = i * step;
    const y = height - p * (height - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1];
  const areaY = height - last * (height - 4) - 2;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="text-accent"
      aria-label="热度趋势"
    >
      <polygon
        points={`0,${height} ${coords.join(" ")} ${width},${height}`}
        fill="currentColor"
        opacity="0.12"
      />
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={width} cy={areaY} r="2" fill="currentColor" />
    </svg>
  );
}
