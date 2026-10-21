"use client";

import { useState } from "react";

const palette = [
  "bg-indigo-500/20 text-indigo-300",
  "bg-violet-500/20 text-violet-300",
  "bg-sky-500/20 text-sky-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-rose-500/20 text-rose-300",
  "bg-amber-500/20 text-amber-300",
];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function ToolIcon({
  domain,
  name,
  size = "md",
}: {
  domain: string;
  name: string;
  size?: "md" | "lg";
}) {
  const [error, setError] = useState(false);
  const cls =
    size === "lg" ? "h-14 w-14 text-xl" : "h-10 w-10 text-base";
  const initial = (name || domain).charAt(0).toUpperCase();
  const color = palette[hash(domain) % palette.length];

  if (error) {
    return (
      <span
        className={`flex ${cls} shrink-0 items-center justify-center rounded-xl font-semibold ${color}`}
      >
        {initial}
      </span>
    );
  }

  return (
    <img
      src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
      alt={`${name} icon`}
      width={size === "lg" ? 56 : 40}
      height={size === "lg" ? 56 : 40}
      loading="lazy"
      onError={() => setError(true)}
      className={`${cls} shrink-0 rounded-xl border border-border bg-surface object-contain p-1`}
    />
  );
}
