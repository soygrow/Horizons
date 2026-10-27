const cols: { label: string; align?: "left" | "center" | "right" }[] = [
  { label: "排名", align: "left" },
  { label: "名称", align: "left" },
  { label: "描述", align: "left" },
  { label: "流量趋势", align: "center" },
  { label: "分类", align: "left" },
  { label: "月访问量", align: "right" },
  { label: "环比增长", align: "right" },
  { label: "自然搜索量", align: "right" },
  { label: "域名权重", align: "right" },
  { label: "注册时间", align: "right" },
];

const GRID =
  "grid-cols-[2.5rem_minmax(0,1.3fr)_minmax(0,1.4fr)_5rem_minmax(0,1fr)_5.5rem_4.5rem_5.5rem_4rem_5.5rem]";

export function ToolListHead() {
  return (
    <div
      className={`grid gap-4 border-b border-border bg-surface/60 px-4 py-2.5 text-xs font-medium text-ink-muted sm:px-5 ${GRID}`}
    >
      {cols.map((c, i) => (
        <span
          key={i}
          className={
            c.align === "right"
              ? "text-right"
              : c.align === "center"
                ? "text-center"
                : ""
          }
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
