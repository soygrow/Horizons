import Link from "next/link";
import { AuthButton } from "./AuthButton";

const channels: { label: string; href: string; soon?: boolean }[] = [
  { label: "AI工具榜", href: "/tools" },
  { label: "AI好公司", href: "#", soon: true },
  { label: "AI行业报告", href: "#", soon: true },
  { label: "AI出海周刊", href: "#", soon: true },
  { label: "AI编程热榜", href: "#", soon: true },
  { label: "Changelog", href: "#", soon: true },
  { label: "Support", href: "#", soon: true },
];

export function NavBar() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-canvas/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-white">
              H
            </span>
            <span className="text-base font-semibold tracking-wide text-ink">
              Horizons
            </span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {channels.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                aria-disabled={c.soon}
                className={
                  c.soon
                    ? "cursor-not-allowed rounded-lg px-3 py-2 text-sm text-ink-muted"
                    : "rounded-lg px-3 py-2 text-sm text-ink-secondary transition hover:bg-surface-2 hover:text-ink"
                }
                title={c.soon ? "即将上线" : undefined}
              >
                {c.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <AuthButton />
          <Link
            href="/#subscribe"
            className="hidden rounded-lg px-3 py-2 text-sm font-medium text-ink-secondary transition hover:text-ink sm:block"
          >
            订阅
          </Link>
          <Link
            href="/#submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary-hover"
          >
            提交产品
          </Link>
        </div>
      </div>
    </header>
  );
}
