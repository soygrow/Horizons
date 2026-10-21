import testimonials from "../../content/testimonials.json";

export function TestimonialWall() {
  return (
    <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <h2 className="text-center text-2xl font-bold tracking-tight text-ink sm:text-3xl">
        来自真实用户的评价
      </h2>
      <p className="mt-3 text-center text-xs text-ink-muted">
        以下为示例评价，上线后将替换为真实用户反馈。
      </p>

      <div className="mt-8 columns-1 gap-4 sm:columns-2 lg:columns-3">
        {testimonials.map((t, i) => (
          <figure
            key={i}
            className="mb-4 break-inside-avoid rounded-2xl border border-border bg-surface p-5"
          >
            <blockquote className="text-sm leading-relaxed text-ink-secondary">
              {t.text}
            </blockquote>
            <figcaption className="mt-4 flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary">
                {t.author.charAt(0)}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{t.author}</p>
                <p className="text-xs text-ink-muted">
                  {t.role} · {t.platform}
                </p>
              </div>
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
