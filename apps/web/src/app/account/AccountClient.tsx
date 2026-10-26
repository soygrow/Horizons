"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchMe, logout, type SessionUser } from "@/lib/api";

export function AccountClient() {
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

  async function handleLogout() {
    await logout();
    window.location.href = "/";
  }

  if (user === undefined) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <p className="text-sm text-ink-muted">加载中…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center sm:px-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink">尚未登录</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          登录后即可管理你的账户、订阅与收藏。
        </p>
        <a
          href="/api/auth/google"
          className="mt-6 inline-block rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-primary-hover"
        >
          用 Google 登录
        </a>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink">账户</h1>

      <div className="mt-6 flex items-center gap-4 rounded-2xl border border-border bg-surface p-6">
        {user.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={user.avatarUrl} alt="" className="h-14 w-14 rounded-full" />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-xl font-semibold text-white">
            {(user.name ?? user.email).charAt(0).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold text-ink">
            {user.name ?? "未命名用户"}
          </p>
          <p className="truncate text-sm text-ink-secondary">{user.email}</p>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-border bg-surface p-6">
        <h2 className="text-sm font-semibold text-ink">订阅</h2>
        <p className="mt-2 text-sm text-ink-muted">订阅功能即将上线，敬请期待。</p>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={handleLogout}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink"
        >
          退出登录
        </button>
        <Link
          href="/"
          className="text-sm text-ink-muted transition hover:text-ink-secondary"
        >
          返回首页
        </Link>
      </div>
    </div>
  );
}
