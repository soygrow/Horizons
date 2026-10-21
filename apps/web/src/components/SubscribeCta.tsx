export function SubscribeCta() {
  return (
    <section
      id="subscribe"
      className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6"
    >
      <h2 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
        你的下一片大陆，已经在路上
      </h2>
      <p className="mx-auto mt-4 max-w-xl text-base text-ink-secondary">
        每周一封邮件，带你发现正在崛起的 AI 工具与真实信号。
      </p>

      <form className="mx-auto mt-8 flex max-w-md flex-col gap-3 sm:flex-row">
        <input
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          className="flex-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          className="rounded-xl bg-primary px-6 py-3 text-sm font-medium text-white transition hover:bg-primary-hover"
        >
          免费每周订阅
        </button>
      </form>
      <p className="mt-3 text-xs text-ink-muted">
        订阅功能即将上线，当前为占位表单，不会收集你的邮箱。
      </p>
    </section>
  );
}
