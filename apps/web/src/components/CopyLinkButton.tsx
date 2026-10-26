"use client";

import { useState } from "react";

export function CopyLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // 忽略
        }
      }}
      className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink"
    >
      {copied ? "已复制 ✓" : "复制链接"}
    </button>
  );
}
