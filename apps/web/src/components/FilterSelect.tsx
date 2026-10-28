"use client";

import { useRouter } from "next/navigation";
import type { FilterOption } from "./FilterGroup";

export function FilterSelect({
  title,
  param,
  options,
  current,
  baseQueryStr,
}: {
  title: string;
  param: string;
  options: FilterOption[];
  current: string;
  baseQueryStr: string;
}) {
  const router = useRouter();

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="shrink-0 text-ink-muted">{title}</span>
      <select
        value={current}
        onChange={(e) => {
          const sp = new URLSearchParams(baseQueryStr);
          if (e.target.value === "all") sp.delete(param);
          else sp.set(param, e.target.value);
          sp.set("page", "1");
          router.push(`/tools?${sp.toString()}`);
        }}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink outline-none transition hover:border-primary/50 focus:border-primary"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
