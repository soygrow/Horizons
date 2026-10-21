import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  tools,
  getToolByDomain,
  getSimilarTools,
  deriveTags,
  derivePricingModel,
  sparklinePoints,
  computeGrowth,
} from "@/lib/data";
import { ToolIcon } from "@/components/ToolIcon";
import { CategoryBadge } from "@/components/CategoryBadge";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { PricingTag } from "@/components/PricingTag";
import { GrowthBadge } from "@/components/GrowthBadge";
import { Sparkline } from "@/components/Sparkline";
import { formatDate, formatCount } from "@/lib/format";

export function generateStaticParams() {
  return tools.map((t) => ({ domain: t.domain }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ domain: string }>;
}): Promise<Metadata> {
  const { domain } = await params;
  const tool = getToolByDomain(domain);
  if (!tool) return { title: "工具未找到" };
  return { title: tool.name, description: tool.description };
}

export default async function ToolDetailPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await params;
  const tool = getToolByDomain(domain);
  if (!tool) notFound();

  const similar = getSimilarTools(tool);
  const tags = deriveTags(tool);
  const pricingModel = derivePricingModel(tool);
  const points = sparklinePoints(tool);
  const growth = computeGrowth(tool);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link
        href="/tools"
        className="inline-flex items-center gap-1 text-sm text-ink-secondary transition hover:text-primary"
      >
        <span aria-hidden>←</span> 全部工具
      </Link>

      {/* Header */}
      <header className="mt-6 flex flex-col gap-5 sm:flex-row sm:items-start">
        <ToolIcon domain={tool.domain} name={tool.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              {tool.name}
            </h1>
            {tool.verified === "verified" ? <VerifiedBadge /> : null}
          </div>
          <p className="mt-1 text-sm text-ink-muted">{tool.domain}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {tool.categories.map((c) => (
              <CategoryBadge key={c} label={c} />
            ))}
            {pricingModel ? <PricingTag model={pricingModel} /> : null}
            <a
              href={tool.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white transition hover:bg-primary-hover"
            >
              访问官网 ↗
            </a>
          </div>
        </div>
      </header>

      {/* Overview metrics */}
      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-2xl font-semibold text-ink tabular-nums">
            {tool.heatScore}
          </p>
          <p className="mt-1 text-xs text-ink-muted">热度分</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-2xl font-semibold text-ink tabular-nums">
            {tool.githubStars ? formatCount(tool.githubStars) : "—"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">GitHub stars</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-2xl font-semibold text-ink tabular-nums">
            {tool.phUpvotes ? formatCount(tool.phUpvotes) : "—"}
          </p>
          <p className="mt-1 text-xs text-ink-muted">PH 票数</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="flex items-center gap-2">
            <Sparkline points={points} width={48} height={24} />
            <GrowthBadge growth={growth} />
          </div>
          <p className="mt-1 text-xs text-ink-muted">趋势</p>
        </div>
      </section>

      {/* About */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-ink">简介</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">
          {tool.longDescription ?? tool.description}
        </p>
      </section>

      {/* Tags */}
      {tags.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-ink">亮点标签</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {tags.map((tag) => (
              <CategoryBadge key={tag} label={tag} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Pricing */}
      {tool.pricing && tool.pricing.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-ink">定价</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {tool.pricing.map((p) => (
              <div
                key={p.plan}
                className="rounded-2xl border border-border bg-surface p-4"
              >
                <p className="text-sm font-medium text-ink">{p.plan}</p>
                <p className="mt-1 text-lg font-semibold text-primary tabular-nums">
                  {p.price}
                </p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Tech stack */}
      {tool.techStack && tool.techStack.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-ink">技术栈</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {tool.techStack.map((t) => (
              <span
                key={t}
                className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-ink-secondary"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {/* Similar tools */}
      {similar.length > 0 ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-ink">相似产品</h2>
          <div className="mt-3 space-y-2">
            {similar.map((s) => (
              <Link
                key={s.id}
                href={`/tools/${s.domain}`}
                className="flex items-center gap-3 rounded-xl border border-border bg-surface p-3 transition hover:border-primary/40"
              >
                <ToolIcon domain={s.domain} name={s.name} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{s.name}</p>
                  <p className="truncate text-xs text-ink-muted">
                    {s.description}
                  </p>
                </div>
                <span className="text-sm font-semibold text-ink tabular-nums">
                  {s.heatScore}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Source info */}
      <section className="mt-8 rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-ink">收录信息</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-muted">来源</dt>
            <dd className="capitalize text-ink-secondary">{tool.sourceType}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-muted">来源链接</dt>
            <dd className="min-w-0 truncate">
              <a
                href={tool.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {tool.sourceUrl} ↗
              </a>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-muted">首次收录</dt>
            <dd className="text-ink-secondary">{formatDate(tool.firstSeenAt)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 text-ink-muted">最近更新</dt>
            <dd className="text-ink-secondary">{formatDate(tool.collectedAt)}</dd>
          </div>
        </dl>
      </section>

      {/* Contact */}
      {tool.contact &&
      (tool.contact.email || tool.contact.socials?.length) ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold text-ink">联系方式</h2>
          <div className="mt-2 space-y-2">
            {tool.contact.email ? (
              <a
                href={`mailto:${tool.contact.email}`}
                className="block text-sm text-primary hover:underline"
              >
                {tool.contact.email}
              </a>
            ) : null}
            {tool.contact.socials?.length ? (
              <div className="flex flex-wrap gap-2">
                {tool.contact.socials.map((s) => (
                  <a
                    key={s.label}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline"
                  >
                    {s.label} ↗
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
