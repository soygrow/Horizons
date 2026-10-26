"use client";

import { useCallback, useEffect, useState } from "react";

type Shot = { src: string; caption: string };

/** 双截图点击放大（对齐哥伦布 cursor-zoom-in 交互） */
export function ScreenshotLightbox({ shots }: { shots: Shot[] }) {
  const [active, setActive] = useState<number | null>(null);

  const close = useCallback(() => setActive(null), []);

  useEffect(() => {
    if (active === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, close]);

  return (
    <>
      {shots.map((s, i) => (
        <button
          key={s.src}
          type="button"
          onClick={() => setActive(i)}
          className="group block w-full cursor-zoom-in"
          aria-label={`放大查看${s.caption}截图`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={s.src}
            alt={`${s.caption}截图`}
            className="w-full rounded-lg border border-border object-cover object-top shadow-lg transition group-hover:opacity-90"
          />
        </button>
      ))}
      {active !== null ? (
        <div
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
          onClick={close}
          role="dialog"
          aria-modal="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={shots[active].src}
            alt={shots[active].caption}
            className="max-h-[82vh] w-auto max-w-full rounded-lg border border-white/20 object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="text-sm text-white/70">{shots[active].caption}</p>
          <button
            type="button"
            onClick={close}
            className="rounded-full bg-white/10 px-4 py-1.5 text-sm text-white/80 transition hover:bg-white/20"
          >
            关闭 (Esc)
          </button>
        </div>
      ) : null}
    </>
  );
}
