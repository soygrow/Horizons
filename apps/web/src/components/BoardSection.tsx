import Link from "next/link";
import type { AITool } from "@/lib/types";
import { ToolRow } from "./ToolRow";

export function BoardSection({
  title,
  subtitle,
  items,
  viewAllHref,
}: {
  title: string;
  subtitle?: string;
  items: AITool[];
  viewAllHref?: string;
}) {
  if (items.length === 0) return null;

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-ink">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
          ) : null}
        </div>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="shrink-0 text-sm font-medium text-primary transition hover:text-primary-hover"
          >
            查看全部 →
          </Link>
        ) : null}
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-surface">
        {items.map((t, i) => (
          <ToolRow key={t.id} tool={t} rank={i + 1} />
        ))}
      </div>
    </section>
  );
}
