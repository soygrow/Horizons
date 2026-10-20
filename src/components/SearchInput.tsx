export function SearchInput({
  defaultValue = "",
  action = "/tools",
}: {
  defaultValue?: string;
  action?: string;
}) {
  return (
    <form action={action} method="get" className="relative w-full max-w-md">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden
      >
        <path
          fillRule="evenodd"
          d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
          clipRule="evenodd"
        />
      </svg>
      <input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder="搜索名称 / 关键词"
        className="w-full rounded-xl border border-border bg-surface py-2.5 pl-9 pr-4 text-sm text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </form>
  );
}
