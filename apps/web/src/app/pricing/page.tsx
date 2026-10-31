import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "定价",
  description:
    "Horizons Pro：一个订阅解锁 AI 工具榜、GitHub 榜、AI 趋势词榜的全部数据与筛选维度。月付 ¥19，年付 ¥99。",
};

/** 两张卡共用同一份权益，与订阅周期无关 */
const benefits = [
  "AI 工具榜 / GitHub 榜 / AI 趋势词榜全量数据",
  "全部筛选条件与交叉排序维度",
  "趋势词 T 分 / O 分明细与权重拆解",
  "工具详情扩展字段：技术栈、联系方式、定价、相似产品",
  "数据更新频率 T+1（免费版 T+7）",
  "CSV 导出与收藏跨设备同步",
  "API 与 MCP 接入，每月 1 万次调用",
];

const faqs = [
  {
    q: "现在可以直接付款吗？",
    a: "还不能。支付通道正在接入（Stripe 订阅 + 支付宝），页面先上线价格与权益。你可以先登录账户，通道开通时第一时间收到通知，并按下单时的价格锁定。",
  },
  {
    q: "现在看到的榜单数据和 Pro 有区别吗？",
    a: "没有区别。当前所有榜单数据都免费、完整开放。Pro 的差异体现在榜单条目范围、筛选维度、更新频率、导出与 API 能力上，这些会随版本分批上线。",
  },
  {
    q: "会自动续费吗？",
    a: "月付默认自动续费，可随时在账户页取消，取消后当期权益到期为止。年付不自动扣款，到期前会发邮件提醒，需要你手动续费。我们不使用静默扣款。",
  },
  {
    q: "权益还没有全部上线，现在买会不会亏？",
    a: "不会。首批订阅用户按当前价格（月付 ¥19 / 年付 ¥99）锁定，后续权益补齐、价格上涨都不影响你。权益上线前如有调整，按实际交付情况顺延使用期。",
  },
  {
    q: "可以开发票吗？团队采购怎么算？",
    a: "可以，个人与企业抬头均可，支持对公转账。三人以上的团队采购、学生与非营利折扣，请邮件说明使用场景，我们按实际情况报价。",
  },
];

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-20">
      {/* 页头 */}
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight text-ink sm:text-4xl">
          定价
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-ink-secondary sm:text-base">
          地平线之上，机会总是先露出轮廓。三条榜单把正在升温的信号、已经成形的想法摊开给你看——
          别人还在猜的时候，你已经能下手。
        </p>
      </header>

      {/* 当前阶段提示 */}
      <div className="mx-auto mt-10 flex max-w-3xl items-start gap-3 rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-left">
        <svg
          className="mt-0.5 h-4 w-4 shrink-0 text-warning"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 00-1.5 0v4.5a.75.75 0 001.5 0v-4.5zM10 14a1 1 0 100-2 1 1 0 000 2z"
            clipRule="evenodd"
          />
        </svg>
        <p className="text-xs leading-relaxed text-ink-secondary">
          支付通道正在接入（Stripe 订阅 + 支付宝）。现在可以先登录账户，
          开通时按当前价格锁定，权益全部上线前不涨价。
        </p>
      </div>

      {/* 价格卡 */}
      <div className="mx-auto mt-8 grid max-w-3xl gap-5 md:grid-cols-2">
        <PlanCard
          title="Pro 月付"
          price="19"
          unit="/ 月"
          note="按月计费，随时取消"
          cta="登录后开通"
        />
        <PlanCard
          title="Pro 年付"
          price="99"
          unit="/ 年"
          note="折合 ¥8.25 / 月，到期不自动扣款"
          badge="省 57%"
          featured
          cta="登录后开通"
        />
      </div>

      <p className="mt-4 text-center text-xs text-ink-muted">
        价格含税，人民币计价。海外支付按当天汇率折算美元。
      </p>

      {/* 权益说明 */}
      <section className="mx-auto mt-16 max-w-3xl">
        <h2 className="text-center text-xl font-semibold tracking-tight text-ink">
          Pro 包含什么
        </h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <ExplainCard
            title="数据范围"
            body="三条榜单全量条目，含未进入首页分区的长尾工具与仓库。趋势词提供完整的准入证据链。"
          />
          <ExplainCard
            title="分析能力"
            body="多维筛选与交叉排序、趋势词评分拆解、工具对比与相似产品推荐，直接导出做表。"
          />
          <ExplainCard
            title="交付形式"
            body="每周一封简报，CSV 导出，以及 API / MCP 接入，方便接进自己的工作流。"
          />
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto mt-16 max-w-3xl">
        <h2 className="text-center text-xl font-semibold tracking-tight text-ink">
          关于付费的常见问题
        </h2>
        <div className="mt-6 space-y-3">
          {faqs.map((item) => (
            <details
              key={item.q}
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

      {/* 底部 CTA */}
      <section className="mx-auto mt-16 max-w-3xl rounded-2xl border border-border bg-surface-2 px-6 py-10 text-center">
        <h2 className="text-lg font-semibold tracking-tight text-ink">
          先看数据，再决定要不要付费
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-secondary">
          榜单现在完全免费。等你确认这些信号对自己的决策有用，再考虑订阅也不迟。
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/tools"
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-white transition hover:bg-primary-hover"
          >
            浏览 AI 工具榜
          </Link>
          <Link
            href="/trends"
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink"
          >
            看趋势词榜单
          </Link>
        </div>
      </section>
    </div>
  );
}

function PlanCard({
  title,
  price,
  unit,
  note,
  badge,
  featured,
  cta,
}: {
  title: string;
  price: string;
  unit: string;
  note: string;
  badge?: string;
  featured?: boolean;
  cta: string;
}) {
  return (
    <div
      className={
        featured
          ? "relative rounded-2xl border-2 border-primary bg-surface p-6 shadow-sm"
          : "relative rounded-2xl border border-border bg-surface p-6"
      }
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {badge ? (
          <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-semibold text-accent">
            {badge}
          </span>
        ) : (
          <span className="text-xs text-ink-muted">灵活</span>
        )}
      </div>

      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-lg font-medium text-ink">¥</span>
        <span className="tabular-nums text-5xl font-bold tracking-tight text-ink">
          {price}
        </span>
        <span className="text-sm text-ink-muted">{unit}</span>
      </div>
      <p className="mt-2 text-xs text-ink-muted">{note}</p>

      <Link
        href="/account"
        className={
          featured
            ? "mt-5 block rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-medium text-white transition hover:bg-primary-hover"
            : "mt-5 block rounded-lg border border-border px-4 py-2.5 text-center text-sm font-medium text-ink-secondary transition hover:border-primary/40 hover:text-ink"
        }
      >
        {cta}
      </Link>

      <ul className="mt-6 space-y-2.5 border-t border-border pt-5">
        {benefits.map((b) => (
          <li key={b} className="flex gap-2.5 text-sm leading-relaxed text-ink-secondary">
            <svg
              className="mt-0.5 h-4 w-4 shrink-0 text-accent"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden
            >
              <path
                fillRule="evenodd"
                d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 111.4-1.4l3.8 3.8 6.8-6.8a1 1 0 011.4 0z"
                clipRule="evenodd"
              />
            </svg>
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExplainCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{body}</p>
    </div>
  );
}