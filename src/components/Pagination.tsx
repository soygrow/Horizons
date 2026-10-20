import Link from "next/link";

export function Pagination({
  page,
  totalPages,
  makeHref,
}: {
  page: number;
  totalPages: number;
  makeHref: (p: number) => string;
}) {
  if (totalPages <= 1) return null;

  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  const visible = pages.filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1,
  );

  return (
    <nav className="flex items-center justify-center gap-1.5">
      <Link
        href={makeHref(Math.max(1, page - 1))}
        aria-disabled={page === 1}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink"
      >
        上一页
      </Link>

      {visible.map((p, i) => {
        const prev = visible[i - 1];
        const ellipsis = prev && p - prev > 1;
        return (
          <span key={p} className="flex items-center gap-1.5">
            {ellipsis ? <span className="text-ink-muted">…</span> : null}
            <Link
              href={makeHref(p)}
              className={
                p === page
                  ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white"
                  : "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink"
              }
            >
              {p}
            </Link>
          </span>
        );
      })}

      <Link
        href={makeHref(Math.min(totalPages, page + 1))}
        aria-disabled={page === totalPages}
        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink"
      >
        下一页
      </Link>
    </nav>
  );
}
