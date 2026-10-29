import faq from "@content/faq.json";

export function FaqAccordion() {
  return (
    <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <h2 className="text-center text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        关于数据来源与收录标准
      </h2>
      <div className="mt-8 space-y-3">
        {faq.map((item, i) => (
          <details
            key={i}
            className="group rounded-xl border border-border bg-surface"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-medium text-ink">
              {item.q}
              <svg
                className="h-4 w-4 shrink-0 text-ink-muted transition group-open:rotate-180"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </summary>
            <p className="px-5 pb-4 text-sm leading-relaxed text-ink-secondary">
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
