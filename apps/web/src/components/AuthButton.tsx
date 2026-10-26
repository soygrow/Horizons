"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchMe, type SessionUser } from "@/lib/api";

export function AuthButton() {
  const [user, setUser] = useState<SessionUser | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetchMe().then((u) => {
      if (active) setUser(u);
    });
    return () => {
      active = false;
    };
  }, []);

  if (user === undefined) {
    return <span className="h-8 w-20 animate-pulse rounded-lg bg-surface-2" aria-hidden />;
  }

  if (!user) {
    return (
      <a
        href="/api/auth/google"
        className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink"
      >
        登录
      </a>
    );
  }

  return (
    <Link
      href="/account"
      className="flex items-center gap-2 rounded-lg border border-border py-1 pl-1 pr-3 transition hover:border-primary/40"
    >
      {user.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
      ) : (
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
          {(user.name ?? user.email).charAt(0).toUpperCase()}
        </span>
      )}
      <span className="max-w-[8rem] truncate text-sm text-ink-secondary">
        {user.name ?? user.email}
      </span>
    </Link>
  );
}
