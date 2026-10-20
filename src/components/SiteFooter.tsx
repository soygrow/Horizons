import Link from "next/link";

const columns: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: "产品",
    links: [
      { label: "AI工具榜", href: "/tools" },
      { label: "提交产品", href: "/#submit" },
      { label: "Changelog", href: "#" },
    ],
  },
  {
    title: "公司",
    links: [
      { label: "关于我们", href: "#" },
      { label: "联系我们", href: "#" },
      { label: "加入我们", href: "#" },
    ],
  },
  {
    title: "支持",
    links: [
      { label: "常见问题", href: "/#faq" },
      { label: "数据来源", href: "/#sources" },
      { label: "反馈与勘误", href: "#" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface/40">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-10 md:grid-cols-4">
          <div className="md:col-span-1">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-white">
                H
              </span>
              <span className="text-base font-semibold text-ink">Horizons</span>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-muted">
              用可追溯的信号，追踪值得关注的 AI 工具。
            </p>
          </div>

          {columns.map((col) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold text-ink">{col.title}</h3>
              <ul className="mt-4 space-y-2.5">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link
                      href={l.href}
                      className="text-sm text-ink-muted transition hover:text-ink"
                    >
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-10 border-t border-border pt-6">
          <p className="text-xs leading-relaxed text-ink-muted">
            © {new Date().getFullYear()} Horizons · 数据来自公开官方接口与人工整理，
            热度为可追溯指标，不代表真实访问量。仅供研究参考。
          </p>
        </div>
      </div>
    </footer>
  );
}
