import Link from "next/link";

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterGroup({
  title,
  options,
  current,
  makeHref,
}: {
  title: string;
  options: FilterOption[];
  current: string;
  makeHref: (value: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mr-1 text-sm font-medium text-ink-muted">{title}</span>
      {options.map((o) => {
        const active = o.value === current;
        return (
          <Link
            key={o.value}
            href={makeHref(o.value)}
            className={
              active
                ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary transition hover:border-primary/50 hover:text-ink"
            }
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}
