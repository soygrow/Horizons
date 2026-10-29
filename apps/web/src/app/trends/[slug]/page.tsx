import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { AITrend } from "@horizons/shared";
import { TrendInterestChart } from "@/components/detail/TrendInterestChart";
import { ClaimTypeBadge, TrendConfidenceBadge, TrendStatusBadge } from "@/components/TrendBadges";
import { formatDateShort } from "@/lib/format";
import {
  daysSince,
  formatGrowth,
  getRelatedTrends,
  getTrendBySlug,
  growthTone,
  hasEnoughData,
  intentLabels,
  OPPORTUNITY_WEIGHTS,
  opportunityScore,
  opportunityTypeMeta,
  overallScore,
  OVERALL_WEIGHTS,
  seriesPoints,
  sourceKindLabels,
  systemVerdict,
  trendCategoryLabels,
  trendKeywords,
  trendMetrics,
  trendRank,
  trendScore,
  TREND_WEIGHTS,
  verdictMeta,
} from "@/lib/trends";

export function generateStaticParams() {
  return trendKeywords.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const t = getTrendBySlug(slug);
  if (!t) return { title: "趋势词未找到" };
  return {
    title: `${t.normalizedName} 趋势分析`,
    description: `「${t.keyword}」的搜索趋势证据、升温原因、搜索意图与可执行的机会方向。`,
  };
}

/* ------------------------------- 局部组件 ------------------------------- */

function SectionHeader({ no, title, desc }: { no: string; title: string; desc: string }) {
  return (
    <header className="flex flex-col gap-1.5 border-b border-border pb-4">
      <span className="text-xs tabular-nums tracking-widest text-ink-muted">{no}</span>
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="max-w-2xl text-sm text-ink-muted">{desc}</p>
    </header>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-4" title={hint}>
      <span className="text-xs text-ink-muted">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}

function ScoreCard({
  label,
  sub,
  value,
  scored,
  tone,
  big,
}: {
  label: string;
  sub: string;
  value: number;
  scored: boolean;
  big?: boolean;
  tone: string;
}) {
  return (
    <div
      className={`w-full rounded-xl border border-border bg-surface p-4 ${big ? "sm:w-48" : "sm:w-36"}`}
    >
      <div className="text-xs text-ink-muted">{label}</div>
      {scored ? (
        <div className="mt-1 flex items-baseline gap-1">
          <span className={`font-bold tabular-nums ${big ? "text-4xl" : "text-2xl"} ${tone}`}>
            {big ? value.toFixed(1) : value.toFixed(0)}
          </span>
          <span className="text-xs text-ink-muted">/100</span>
        </div>
      ) : (
        <div className="mt-1 text-sm font-medium text-ink-muted">数据不足</div>
      )}
      <div className="mt-1 text-[11px] leading-snug text-ink-muted">{sub}</div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: scored ? `${Math.min(100, Math.max(3, value))}%` : "0%" }}
        />
      </div>
    </div>
  );
}

function ScoreBreakdown({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; weight: number; value: number }[];
}) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-muted">{title}</h3>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className="w-[6.5rem] shrink-0 truncate text-xs text-ink-secondary">{r.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${r.value}%` }} />
            </div>
            <span className="w-8 shrink-0 text-right text-xs tabular-nums text-ink">{r.value}</span>
            <span className="w-9 shrink-0 text-right text-[10px] tabular-nums text-ink-muted">
              {Math.round(r.weight * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceLink({ label, url, site, extra }: { label: string; url: string; site?: string; extra?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2 transition hover:border-primary/40"
    >
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-ink group-hover:text-primary">{label}</div>
        <div className="truncate text-[11px] text-ink-muted">
          {site ?? url}
          {extra ? ` · ${extra}` : ""}
        </div>
      </div>
    </a>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-2xl border border-border bg-surface p-5">{children}</div>;
}

/* ------------------------------- 页面 ------------------------------- */

export default async function TrendDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const trend = getTrendBySlug(slug);
  if (!trend) notFound();

  const m = trendMetrics(trend);
  const points = seriesPoints(trend);
  const scored = hasEnoughData(trend);
  const tv = trendScore(trend);
  const op = opportunityScore(trend);
  const overall = overallScore(trend);
  const rank = trendRank(trend.slug);
  const verdict = systemVerdict(trend);
  const related = getRelatedTrends(trend, 4);
  const seenDays = daysSince(trend.firstSeenAt);
  const peakGap = m.growth30 === null ? null : m.growth30;

  const trendRows = TREND_WEIGHTS.map((w) => ({
    label: w.label,
    weight: w.weight,
    value: trend.trendParts[w.key],
  }));
  const oppRows = OPPORTUNITY_WEIGHTS.map((w) => ({
    label: w.label,
    weight: w.weight,
    value: trend.oppParts[w.key],
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Link href="/trends" className="hover:text-ink">
          AI 趋势词榜单
        </Link>
        <span>/</span>
        <span className="text-ink-secondary">{trend.normalizedName}</span>
        <span className="ml-auto rounded-full border border-border bg-surface px-2.5 py-1">
          快照 {formatDateShort(trend.updatedAt)}
        </span>
      </div>

      {/* Hero：这是什么 + 是否可信 + 现在能做什么 */}
      <div className="mt-4 rounded-2xl border border-border bg-surface p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <TrendStatusBadge status={trend.status} />
              <TrendConfidenceBadge confidence={trend.confidence} />
              <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-secondary">
                {trendCategoryLabels[trend.category]}
              </span>
              <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">
                地区 {trend.region}
              </span>
            </div>

            <h1 className="mt-3 text-2xl font-bold tracking-tight text-ink sm:text-3xl">
              {trend.normalizedName}
            </h1>
            <p className="mt-1 font-mono text-sm text-ink-muted">{trend.keyword}</p>

            <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-secondary">{trend.why}</p>

            <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
              <span className={`rounded-full border px-2.5 py-1 font-medium ${verdict.cls}`}>
                系统建议：{verdict.label}
              </span>
              <span className={`tabular-nums ${growthTone(m.growth7)}`}>
                近 7 天 {formatGrowth(m.growth7)}
              </span>
              {seenDays !== null ? (
                <span className="text-ink-muted">首次发现 {seenDays} 天前</span>
              ) : null}
              <span className="text-ink-muted">可信度依据：{trend.confidence === "high" ? "多时点 + 跨源" : trend.confidence === "medium" ? "有趋势证据但样本有限" : "观测点不足"}</span>
            </div>
          </div>

          <div className="flex shrink-0 flex-col gap-3">
            <ScoreCard
              label="综合得分"
              sub={rank !== null ? `全站第 ${rank} 名` : "数据不足，未参与排名"}
              value={overall}
              scored={scored}
              tone="text-primary"
              big
            />
            <div className="flex gap-3">
              <ScoreCard
                label="趋势强度"
                sub="是否值得关注"
                value={tv}
                scored={scored}
                tone="text-ink"
              />
              <ScoreCard
                label="机会潜力"
                sub="是否值得投入"
                value={op}
                scored={scored}
                tone="text-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* 指标条 */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        <Stat
          label="近 7 天均值"
          value={m.recent7 === null ? "—" : String(m.recent7)}
          hint="最近 7 个采样点的平均相对热度"
        />
        <Stat
          label="近 30 天变化"
          value={formatGrowth(peakGap)}
          hint="最近 7 点均值相对最初 7 点均值的变化"
          tone={growthTone(peakGap)}
        />
        <Stat
          label="历史基线"
          value={m.baseline === null ? "—" : String(m.baseline)}
          hint="最近 7 点之前的均值，用于判断是否真的高于历史水平"
        />
        <Stat label="爆发峰值" value={String(m.peak)} hint={`出现在 ${m.peakDate ?? "—"}`} />
        <Stat
          label="高于基线"
          value={`${m.aboveBaseline}/${m.window}`}
          hint="近 14 个采样点中高于历史基线的点数，用于判断持续性"
        />
        <Stat
          label="采样点"
          value={`${m.samples}`}
          hint={`步长 ${trend.series.stepDays} 天，覆盖约 ${m.spanDays} 天`}
        />
        <Stat label="首次发现" value={formatDateShort(trend.firstSeenAt)} hint="第一次采集成功的时间，不随后续更新覆盖" />
        <Stat label="最近采集" value={formatDateShort(trend.lastSeenAt)} hint="最近一次成功采集该词的时间" />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex flex-col gap-10">
          {/* 01 趋势证据 */}
          <section className="flex flex-col gap-4">
            <SectionHeader
              no="01"
              title="趋势证据"
              desc="近 30 天搜索热度、历史基线与峰值。数值是 Google Trends 归一化后的相对热度（0–100），不是搜索次数。"
            />
            <Card>
              <TrendInterestChart points={points} baseline={m.baseline} peakDate={m.peakDate} />
              <div className="mt-4 grid gap-2 border-t border-border pt-4 text-xs leading-relaxed text-ink-muted sm:grid-cols-2">
                <p>
                  采样：{trend.series.start} 起，每 {trend.series.stepDays} 天 1 个点，共 {m.samples} 个点。
                  基线 {m.baseline ?? "—"}，峰值 {m.peak}（{m.peakDate ?? "—"}）。
                </p>
                <p>
                  近 {m.window} 点中有 {m.aboveBaseline} 点高于基线，近 7 天均值 {m.recent7 ?? "—"}。
                  {scored ? "采样点充足，可参与评分。" : "采样点少于 14 个，暂不评分。"}
                </p>
              </div>
            </Card>
          </section>

          {/* 02 事件与原因 */}
          <section className="flex flex-col gap-4">
            <SectionHeader
              no="02"
              title="事件与原因"
              desc="与趋势时间对应的事件。时间接近不等于因果，因此每条结论都标注证据等级与发布日期。"
            />
            <div className="flex flex-col gap-3">
              {trend.evidence.map((e, i) => (
                <div key={i} className="rounded-2xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <ClaimTypeBadge type={e.claimType} />
                    {e.date ? (
                      <span className="text-xs tabular-nums text-ink-muted">{e.date}</span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-sm font-medium leading-relaxed text-ink">{e.claim}</p>
                  {e.detail ? (
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">{e.detail}</p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {e.sources.map((s) => (
                      <a
                        key={s.url + s.label}
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-lg border border-border bg-surface-2 px-2 py-1 text-[11px] text-ink-secondary transition hover:border-primary/40 hover:text-primary"
                      >
                        {s.label} ↗
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* 03 搜索意图 */}
          <section className="flex flex-col gap-4">
            <SectionHeader
              no="03"
              title="用户需求与搜索意图"
              desc="把相关搜索词按意图聚类，回答「人们究竟在找什么」，而不是只看热度高低。"
            />
            <Card>
              {trend.intentSummary ? (
                <p className="text-sm leading-relaxed text-ink-secondary">{trend.intentSummary}</p>
              ) : null}
              <ul className="mt-4 flex flex-col gap-4">
                {trend.intents.map((it) => (
                  <li key={it.intent}>
                    <div className="flex items-center gap-3">
                      <span className="w-16 shrink-0 text-xs font-medium text-ink">
                        {intentLabels[it.intent] ?? it.intent}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${Math.min(100, it.share ?? 0)}%` }}
                        />
                      </div>
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-muted">
                        {it.share !== undefined ? `${it.share}%` : "—"}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-[4.75rem]">
                      {it.queries.map((q) => (
                        <span
                          key={q}
                          className="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary"
                        >
                          {q}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          {/* 04 机会分析 */}
          <section className="flex flex-col gap-4">
            <SectionHeader
              no="04"
              title="机会分析"
              desc="依据真实搜索意图、现有产品与竞争情况给出方向。每条机会都写明依据与工作量，不做「任何热词都成立」的通用建议。"
            />
            <div className="grid gap-3 sm:grid-cols-2">
              {trend.opportunities.map((o, i) => (
                <div key={i} className="flex flex-col rounded-2xl border border-border bg-surface p-5">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${opportunityTypeMeta[o.type].cls}`}
                    >
                      {opportunityTypeMeta[o.type].label}
                    </span>
                    {o.effort ? (
                      <span className="text-[11px] text-ink-muted">约 {o.effort}</span>
                    ) : null}
                  </div>
                  <h3 className="mt-3 text-sm font-semibold leading-snug text-ink">{o.title}</h3>
                  <p className="mt-2 flex-1 text-xs leading-relaxed text-ink-secondary">{o.why}</p>
                  {o.evidence ? (
                    <p className="mt-3 border-t border-border pt-2 text-[11px] text-ink-muted">
                      依据：{o.evidence}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          {/* 05 下一步行动 */}
          <section className="flex flex-col gap-4">
            <SectionHeader
              no="05"
              title="下一步行动"
              desc="明确建议现在做什么，并给出依据与不确定性。不确定性不会被隐藏。"
            />
            <div className="flex flex-col gap-3">
              {trend.actions.map((a, i) => (
                <div key={i} className="rounded-2xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${verdictMeta[a.verdict].cls}`}>
                      {verdictMeta[a.verdict].label}
                    </span>
                  </div>
                  <p className="mt-2 text-sm font-medium leading-relaxed text-ink">{a.action}</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-ink-secondary">依据：{a.reason}</p>
                  {a.uncertainty ? (
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">不确定性：{a.uncertainty}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <p className="rounded-2xl border border-dashed border-border p-4 text-xs leading-relaxed text-ink-muted">
            口径说明：Google Trends 展示的是归一化相对热度，不能转换为月搜索量，因此这里不提供「月搜索次数」。
            低基线会放大增长率，基线为 0 或采样不足时显示「—」。
          </p>
        </div>

        {/* 侧栏 */}
        <aside className="flex flex-col gap-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <h2 className="text-sm font-semibold text-ink">评分构成</h2>
            <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-2">
              <span className="text-[11px] text-ink">
                综合得分 S = {OVERALL_WEIGHTS.trend} × T + {OVERALL_WEIGHTS.opportunity} × O
              </span>
              <span className="text-sm font-bold tabular-nums text-primary">
                {scored ? overall.toFixed(1) : "—"}
              </span>
            </div>
            <div className="mt-3 flex flex-col gap-4">
              <ScoreBreakdown title={`趋势强度 T = ${scored ? tv.toFixed(1) : "—"}`} rows={trendRows} />
              <ScoreBreakdown title={`机会潜力 O = ${scored ? op.toFixed(1) : "—"}`} rows={oppRows} />
            </div>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-ink-muted">
              权重是第一版假设，需要用历史表现回测校准；数据不足时不评分。
            </p>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-ink">数据来源</h2>
            <div className="mt-3 flex flex-col gap-2">
              {trend.sources.map((s) => (
                <SourceLink
                  key={s.url + s.label}
                  label={s.label}
                  url={s.url}
                  site={s.site}
                  extra={[sourceKindLabels[s.kind], s.publishedAt].filter(Boolean).join(" · ")}
                />
              ))}
            </div>
          </Card>

          {trend.relatedQueries?.length ? (
            <Card>
              <h2 className="text-sm font-semibold text-ink">相关查询</h2>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {trend.relatedQueries.map((q) => (
                  <span
                    key={q}
                    className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-secondary"
                  >
                    {q}
                  </span>
                ))}
              </div>
            </Card>
          ) : null}

          {trend.competitors?.length ? (
            <Card>
              <h2 className="text-sm font-semibold text-ink">现有产品 / 竞品</h2>
              <ul className="mt-3 flex flex-col gap-1.5 text-xs text-ink-secondary">
                {trend.competitors.map((c) => (
                  <li key={c}>· {c}</li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card>
            <h2 className="text-sm font-semibold text-ink">采集档案</h2>
            <dl className="mt-3 flex flex-col gap-2 text-xs">
              {[
                ["首次发现", formatDateShort(trend.firstSeenAt)],
                ["最近采集", formatDateShort(trend.lastSeenAt)],
                ["数据快照", formatDateShort(trend.updatedAt)],
                ["地区", trend.region],
                ["采样点", `${m.samples} 个 / 步长 ${trend.series.stepDays} 天`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3">
                  <dt className="text-ink-muted">{k}</dt>
                  <dd className="tabular-nums text-ink-secondary">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <h2 className="text-sm font-semibold text-ink">相近趋势</h2>
            <div className="mt-3 flex flex-col gap-2">
              {related.map((r: AITrend) => (
                <Link
                  key={r.slug}
                  href={`/trends/${r.slug}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2/40 px-2.5 py-2 transition hover:border-primary/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium text-ink">{r.normalizedName}</span>
                    <span className="block truncate text-[11px] text-ink-muted">
                      {trendCategoryLabels[r.category]}
                    </span>
                  </span>
                  <TrendStatusBadge status={r.status} />
                </Link>
              ))}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}