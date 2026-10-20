const cols: { label: string; right?: boolean }[] = [
  { label: "排名" },
  { label: "" },
  { label: "名称" },
  { label: "描述" },
  { label: "趋势" },
  { label: "规模" },
  { label: "定价" },
  { label: "热度" },
  { label: "收录", right: true },
];

export function ToolTableHead() {
  return (
    <div className="hidden border-b border-border bg-surface/60 px-4 py-2.5 sm:px-5 lg:grid lg:grid-cols-[2.5rem_2.75rem_minmax(0,1.1fr)_minmax(0,1.5fr)_4.5rem_4.5rem_4.5rem_5.5rem_5rem] lg:gap-4">
      {cols.map((c, i) => (
        <span
          key={i}
          className={`text-xs font-medium text-ink-muted ${
            c.right ? "text-right" : ""
          }`}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
