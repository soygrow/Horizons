"use client";

import { useEffect, useState } from "react";

const KEY = "horizons:favorites";

function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

/** 「收藏」按钮：localStorage 持久化（后端接入后替换） */
export function FavoriteButton({ domain }: { domain: string }) {
  const [favorited, setFavorited] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setFavorited(readFavorites().includes(domain));
    setMounted(true);
  }, [domain]);

  function toggle() {
    const list = readFavorites();
    const next = list.includes(domain)
      ? list.filter((d) => d !== domain)
      : [...list, domain];
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setFavorited(next.includes(domain));
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={mounted ? favorited : undefined}
      className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition ${
        favorited
          ? "border-primary/40 bg-primary-soft text-primary"
          : "border-border bg-surface text-ink-secondary hover:bg-surface-2 hover:text-ink"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill={favorited ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      </svg>
      {favorited ? "已收藏" : "收藏"}
    </button>
  );
}
