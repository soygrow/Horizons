import Link from "next/link";

export function PaywallBanner({ total }: { total: number }) {
  return (
    <div className="rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/20 to-primary/5 px-6 py-8 text-center">
      <h2 className="text-lg font-semibold text-ink sm:text-xl">
        解锁全部 {total} 个站点
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-ink-secondary">
        免费榜单仅展示精选部分。订阅后解锁完整榜单、进阶筛选与每周更新。
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Link
          href="#subscribe"
          className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-primary-hover"
        >
          查看今日榜单
        </Link>
        <Link
          href="#subscribe"
          className="rounded-lg border border-border bg-surface px-5 py-2.5 text-sm font-medium text-ink transition hover:bg-surface-2"
        >
          了解订阅
        </Link>
      </div>
    </div>
  );
}
