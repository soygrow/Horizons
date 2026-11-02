"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { label: string; href: string };

/** 小屏（< lg）导航菜单：桌面端由 NavBar 直接渲染横向导航 */
export function MobileNav({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // 路由变化后自动收起
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "关闭导航菜单" : "打开导航菜单"}
        className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-ink-secondary transition hover:border-primary/40 hover:text-ink"
      >
        <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
          {open ? (
            <path
              fillRule="evenodd"
              d="M5.3 5.3a1 1 0 011.4 0L10 8.6l3.3-3.3a1 1 0 111.4 1.4L11.4 10l3.3 3.3a1 1 0 01-1.4 1.4L10 11.4l-3.3 3.3a1 1 0 01-1.4-1.4L8.6 10 5.3 6.7a1 1 0 010-1.4z"
              clipRule="evenodd"
            />
          ) : (
            <path
              fillRule="evenodd"
              d="M3 5.5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm0 4.5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm1 3.5a1 1 0 100 2h12a1 1 0 100-2H4z"
              clipRule="evenodd"
            />
          )}
        </svg>
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-x-0 bottom-0 top-16 z-40 cursor-default bg-canvas/70 backdrop-blur-sm"
          />
          <nav
            id="mobile-nav-panel"
            className="absolute inset-x-0 top-16 z-50 border-b border-border bg-canvas px-4 pb-3 pt-2 shadow-lg"
          >
            {items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    active
                      ? "flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2.5 text-sm font-medium text-ink"
                      : "flex items-center justify-between rounded-lg px-3 py-2.5 text-sm text-ink-secondary transition hover:bg-surface-2 hover:text-ink"
                  }
                >
                  {item.label}
                  <svg
                    className="h-3.5 w-3.5 text-ink-muted"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    aria-hidden
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                      clipRule="evenodd"
                    />
                  </svg>
                </Link>
              );
            })}
          </nav>
        </>
      ) : null}
    </div>
  );
}