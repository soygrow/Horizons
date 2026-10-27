import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { tools, getToolByDomain } from "@/lib/data";
import { CopyDataButton } from "@/components/detail/CopyDataButton";
import { FavoriteButton } from "@/components/detail/FavoriteButton";
import { ScreenshotLightbox } from "@/components/detail/ScreenshotLightbox";
import { TrafficTrendChart } from "@/components/detail/TrafficTrendChart";
import { buildSiteMarkdown } from "@/lib/site-markdown";
import { getDict, format as tf } from "@/lib/i18n";
import { formatCount } from "@/lib/format";

const dict = getDict("zh");

/* ------------------------------- 通用小组件 ------------------------------- */

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-[22px] w-fit items-center rounded-full border border-border bg-surface-2 px-2.5 text-xs text-ink-secondary">
      {children}
    </span>
  );
}

function SectionHeader({ no, title, desc }: { no: string; title: string; desc: string }) {
  return (
    <header className="flex flex-col gap-2 border-b border-border pb-5">
      <span className="text-xs tabular-nums tracking-widest text-ink-muted">{no}</span>
      <h2 className="text-xl font-semibold text-ink">{title}</h2>
      <p className="max-w-2xl text-sm text-ink-muted">{desc}</p>
    </header>
  );
}

/** 指标卡（value 为空时显示「待获取」） */
function Stat({ label, value, success }: { label: string; value?: string; success?: boolean }) {
  const pending = !value;
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
      <span className="text-xs text-ink-muted">{label}</span>
      <span
        className={`text-lg font-semibold tabular-nums ${
          pending ? "text-ink-muted" : success ? "text-success" : "text-ink"
        }`}
      >
        {pending ? dict.analysis.pending : value}
      </span>
    </div>
  );
}

function formatDuration(sec?: number): string | undefined {
  if (sec === undefined || sec === null) return undefined;
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
}

/** 「待获取」占位块 */
function Pending({ text = dict.analysis.pending }: { text?: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-border">
      <span className="text-sm text-ink-muted">{text}</span>
    </div>
  );
}

/** 横向条形（排名分布用 count，渠道/国家用 share 百分比） */
function Bars({ items }: { items: { label: string; value: number; suffix?: string }[] }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-ink-secondary">{it.label}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(it.value / max) * 100}%` }} />
          </div>
          <span className="w-14 text-right text-xs tabular-nums text-ink-muted">
            {it.value}{it.suffix ?? ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 产品表现 · 洞察卡片（标题 + 副标题 + 正文，可选结论标签） */
function InsightCard({
  title,
  sub,
  text,
  tag,
}: {
  title: string;
  sub: string;
  text?: string;
  tag?: string;
}) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <span className="shrink-0 text-xs text-ink-muted">{sub}</span>
      </div>
      <p className="mt-3 text-sm leading-relaxed break-words text-ink-secondary">
        {text ?? dict.performanceInsight.pending}
      </p>
      {tag ? (
        <span className="mt-4 inline-flex w-fit items-center rounded-full bg-success-soft px-3 py-1 text-xs font-medium text-success">
          {tag}
        </span>
      ) : null}
    </div>
  );
}

/** 流量情况子模块卡片（左数据右解读的「左」块） */
function SubCard({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium text-ink">{title}</h3>
        {extra}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Favicon({ domain }: { domain: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt=""
      className="h-4 w-4 shrink-0 rounded-sm bg-surface-2"
      loading="lazy"
    />
  );
}

const VERDICT_STYLE: Record<string, string> = {
  "值得入场": "bg-success-soft text-success",
  "谨慎": "bg-warning-soft text-warning",
  "别碰": "bg-danger-soft text-danger",
};

/** 左右布局容器（65:35） */
function Split({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[65fr_35fr] lg:gap-8">
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
}

/* --------------------------------- 数据组装 -------------------------------- */

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
  if (!tool) return { title: "站点未找到" };
  return { title: `${tool.domain} - 值不值得做`, description: tool.description };
}

export default async function ToolDetailPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await params;
  const tool = getToolByDomain(domain);
  if (!tool) notFound();

  const ai = tool.aiInsight;
  const td = tool.trafficDecrypt;
  const tm = tool.trafficMetrics;
  const m = tool.metrics;
  const b = tool.backlinks;
  const audit = tool.siteAudit;
  const ps = tool.pageStructure;
  const obs = tool.observations;
  const opp = tool.opportunity;
  const mb = tool.monetizationBlueprint;
  const gp = tool.growthPlaybook;
  const bb = tool.buildBlueprint;
  const sparks = tool.ideaSparks;
  const pi = tool.performanceInsight;
  const ds = tool.dataSnapshot;
  const collectedAt = tool.collectedAt;
  const fmtTime = (s?: string) => (s ? s.slice(0, 19).replace("T", " ") : "");
  const markdown = buildSiteMarkdown(tool);

  const t = dict.opportunity;
  const competitors = obs?.competitors ?? [];
  const keywords = tool.keywords ?? [];
  const relatedKeywords = tool.relatedKeywords ?? [];
  const rankDistribution = tool.rankDistribution ?? [];
  const trend = tool.trend ?? [];
  const channelShares = tool.channelShares ?? {};
  const geo = tool.geoDistribution ?? [];
  const ranks = tool.ranks;

  // 渠道份额（按从大到小排序，值已是 %）
  const channelItems = Object.entries(channelShares)
    .map(([key, value]) => ({
      key,
      label: dict.traffic.channels[key as keyof typeof dict.traffic.channels] ?? key,
      value: value ?? 0,
    }))
    .sort((a, b) => b.value - a.value);

  const heroShots = [
    tool.screenshotDesktopUrl ? { src: tool.screenshotDesktopUrl, caption: dict.hero.desktop } : null,
    tool.screenshotMobileUrl ? { src: tool.screenshotMobileUrl, caption: dict.hero.mobile } : null,
  ].filter((s): s is { src: string; caption: string } => s !== null);

  const NAV: [string, string][] = [
    ["#performance", dict.anchorNav.performance],
    ["#opportunity", dict.anchorNav.opportunity],
    ["#traffic", dict.anchorNav.traffic],
    ["#business", dict.anchorNav.business],
    ["#playbook", dict.anchorNav.playbook],
    ["#ideas", dict.anchorNav.ideas],
  ];

  return (
    <div className="flex flex-col">
      {/* ------------------------------ Hero 头部 ------------------------------ */}
      <section className="border-b border-border bg-frost py-8 md:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6">
          <header className="flex flex-col-reverse gap-8 lg:flex-row lg:items-center lg:gap-14">
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
                <h1 className="max-w-full truncate text-3xl font-semibold text-ink">{tool.domain}</h1>
                <a
                  href={tool.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex h-9 shrink-0 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white transition hover:bg-primary-hover"
                >
                  {dict.hero.visitSite}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                </a>
                <FavoriteButton domain={tool.domain} />
                <CopyDataButton markdown={markdown} />
              </div>

              <p className="max-w-2xl text-lg leading-relaxed text-ink-secondary">{tool.description}</p>

              <div className="flex flex-col gap-3">
                {tool.featureTags?.length ? (
                  <div className="flex flex-wrap items-center gap-2.5">
                    {tool.featureTags.map((t) => <Badge key={t}>{t}</Badge>)}
                  </div>
                ) : null}
                {tool.categoryTags?.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {tool.categoryTags.map((t) => <Badge key={t}>{t}</Badge>)}
                  </div>
                ) : null}
              </div>
            </div>

            {heroShots.length > 0 ? (
              <div className="w-full shrink-0 lg:w-[520px]">
                <div className="flex items-start gap-3">
                  {heroShots.map((s, i) => (
                    <figure key={s.src} className="flex min-w-0 flex-col gap-2" style={{ width: i === 0 ? "72%" : "28%" }}>
                      <ScreenshotLightbox shots={[s]} />
                      <figcaption className="text-center text-xs text-ink-muted">{s.caption}</figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : (
              <div className="hidden aspect-[16/10] w-full shrink-0 items-center justify-center rounded-xl border border-dashed border-border text-sm text-ink-muted lg:flex lg:w-[520px]">
                {dict.hero.screenshotPending}
              </div>
            )}
          </header>
        </div>
      </section>

      {/* ---------------------------- sticky 锚点导航 ---------------------------- */}
      <nav className="sticky inset-x-0 top-16 z-30 border-b border-border bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl px-4 sm:px-6">
          <span className="hidden max-w-[12rem] shrink-0 truncate py-2.5 text-sm font-medium text-ink lg:block">{tool.domain}</span>
          <span className="hidden h-4 w-px shrink-0 self-center bg-border lg:block" />
          <ul className="flex min-w-0 items-center gap-1 overflow-x-auto">
            {NAV.map(([href, label]) => (
              <li key={href} className="shrink-0">
                <a href={href} className="block whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-ink-secondary transition hover:bg-surface-2 hover:text-ink">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <div className="mx-auto flex max-w-7xl flex-col gap-16 px-4 py-12 sm:px-6">
        {/* ------------------------ 01 产品表现 ------------------------ */}
        <section id="performance" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.performance.no}
            title={dict.sections.performance.title}
            desc={dict.sections.performance.desc}
          />
          {/* 数据时间说明：数据快照期数 + 最后更新时间（-my-5 收紧上下留白） */}
          {(ds?.period || collectedAt) && (
            <div className="-my-5 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-ink-muted">
              {ds?.period && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-ink-secondary">{dict.sections.performance.snapshot}</span>
                  {ds.period}
                </span>
              )}
              {collectedAt && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-ink-secondary">{dict.sections.performance.updated}</span>
                  {fmtTime(collectedAt)}
                </span>
              )}
            </div>
          )}
          {/* 7 项核心指标（通栏单行，无外框） */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label={dict.metrics.monthlyVisits} value={m?.monthlyVisits !== undefined ? formatCount(m.monthlyVisits) : undefined} />
            <Stat
              label={dict.metrics.monthlyVisitsGrowth}
              value={m?.momGrowth !== undefined ? `${m.momGrowth > 0 ? "+" : ""}${m.momGrowth}%` : undefined}
              success={(m?.momGrowth ?? 0) > 0}
            />
            <Stat label={dict.metrics.organicSearchVisits} value={m?.organicVisits !== undefined ? formatCount(m.organicVisits) : undefined} />
            <Stat
              label={dict.metrics.organicShare}
              value={
                m?.organicVisits !== undefined && m?.monthlyVisits
                  ? `${Math.round((m.organicVisits / m.monthlyVisits) * 1000) / 10}%`
                  : undefined
              }
            />
            <Stat label={dict.metrics.directVisits} value={tm?.directVisits !== undefined ? formatCount(tm.directVisits) : undefined} />
            <Stat
              label={dict.metrics.domainWeight}
              value={
                m?.domainWeight !== undefined
                  ? m.domainWeightLabel && m.domainWeightLabel !== "权重"
                    ? `${formatCount(m.domainWeight)}（${m.domainWeightLabel}）`
                    : formatCount(m.domainWeight)
                  : undefined
              }
            />
            <Stat label={dict.metrics.registeredAt} value={m?.registeredAt} />
          </div>

          {/* 数据下方：结构化分析 */}
          <div className="flex flex-col gap-4">
            {/* 顶部高光结论：产品画像四要素 */}
            <div className="rounded-2xl border border-border bg-surface p-6">
              <div className="mb-5 flex items-center gap-2.5">
                <span className="h-4 w-1 rounded-full bg-primary" aria-hidden />
                <h3 className="text-sm font-semibold text-ink">{dict.performanceInsight.highlightTag}</h3>
              </div>
              <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
                {[
                  { k: dict.performanceInsight.what, v: pi?.overview?.what },
                  { k: dict.performanceInsight.pain, v: pi?.overview?.pain },
                  { k: dict.performanceInsight.can, v: pi?.overview?.can },
                  { k: dict.performanceInsight.trait, v: pi?.overview?.trait },
                ].map(({ k, v }) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs font-medium text-ink-muted">{k}</dt>
                    <dd className="mt-1.5 text-sm leading-relaxed break-words text-ink">
                      {v ?? <span className="text-ink-muted">{dict.performanceInsight.pending}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* 中间三列：业务与护城河 */}
            <div className="grid gap-4 md:grid-cols-3">
              <InsightCard title={dict.performanceInsight.wedge} sub={dict.performanceInsight.wedgeSub} text={pi?.wedge} />
              <InsightCard title={dict.performanceInsight.model} sub={dict.performanceInsight.modelSub} text={pi?.model} />
              <InsightCard title={dict.performanceInsight.moat} sub={dict.performanceInsight.moatSub} text={pi?.moat} />
            </div>

            {/* 底部三列：数据与创业机会 */}
            <div className="grid gap-4 md:grid-cols-3">
              <InsightCard title={dict.performanceInsight.trafficTruth} sub={dict.performanceInsight.trafficTruthSub} text={pi?.trafficTruth} />
              <InsightCard title={dict.performanceInsight.growthEdge} sub={dict.performanceInsight.growthEdgeSub} text={pi?.growthEdge} />
              <InsightCard
                title={dict.performanceInsight.newPlayerEntry}
                sub={dict.performanceInsight.newPlayerEntrySub}
                text={pi?.newPlayerEntry}
                tag={pi?.entryTag}
              />
            </div>
          </div>
        </section>

        {/* ------------------------ 02 值不值得做 ------------------------ */}
        <section id="opportunity" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.opportunity.no}
            title={dict.sections.opportunity.title}
            desc={dict.sections.opportunity.desc}
          />
          <div className="rounded-2xl border border-border bg-surface p-6 sm:p-8">
            {opp ? (
              <>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-4xl font-bold tabular-nums leading-none text-ink">{opp.score}</span>
                    <span className="text-base text-ink-muted">{t.scoreOf}</span>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-3.5 py-1 text-base font-semibold ${VERDICT_STYLE[opp.verdict] ?? "bg-surface-2 text-ink-secondary"}`}>
                    {opp.verdict}
                  </span>
                  {opp.reason ? (
                    <p className="min-w-[14rem] flex-1 text-sm leading-relaxed text-ink-secondary">{opp.reason}</p>
                  ) : null}
                </div>
                <div className="mt-7 flex flex-col gap-1">
                  <h4 className="text-sm font-semibold text-ink">{t.dimensions}</h4>
                  <p className="text-xs text-ink-muted">{t.dimensionsHint}</p>
                </div>
                <div className="mt-4 grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-5">
                  {opp.dimensions?.map((d) => (
                    <div key={d.label} className="flex flex-col gap-1.5">
                      <div className="flex items-baseline justify-between text-xs">
                        <span className="font-medium text-ink-secondary">{d.label}</span>
                        <span className="font-semibold tabular-nums text-ink">{d.score}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
                      </div>
                      {d.note ? <p className="text-xs leading-relaxed text-ink-muted">{d.note}</p> : null}
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <Pending text={`${t.scoreLabel} · ${dict.analysis.pending}`} />
            )}
          </div>
        </section>

        {/* ------------------------ 03 流量情况（讲流量故事） ------------------------ */}
        <section id="traffic" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.traffic.no}
            title={dict.sections.traffic.title}
            desc={dict.sections.traffic.desc}
          />
          <Split
            left={
              <div className="flex flex-col gap-5">
                {/* 3.1 流量趋势 */}
                <SubCard
                  title={dict.traffic.trend}
                  extra={<span className="text-sm text-ink-muted">{tf(dict.traffic.monthsRange, { count: trend.length })}</span>}
                >
                  {trend.length >= 2 ? <TrafficTrendChart points={trend} /> : <Pending text={dict.traffic.noHistory} />}
                </SubCard>

                {/* 3.2 流量结构 */}
                <SubCard title={dict.traffic.sources}>
                  {channelItems.length ? (
                    <Bars items={channelItems.map((c) => ({ label: c.label, value: c.value, suffix: "%" }))} />
                  ) : (
                    <Pending text={`${dict.traffic.sources} · ${dict.analysis.pending}`} />
                  )}
                </SubCard>

                {/* 3.3 主要国家 */}
                <SubCard title={dict.traffic.countries}>
                  {geo.length ? (
                    <Bars items={geo.map((g) => ({ label: g.country, value: g.share, suffix: "%" }))} />
                  ) : (
                    <Pending text={`${dict.traffic.countries} · ${dict.analysis.pending}`} />
                  )}
                </SubCard>

                {/* 3.4 搜索与排名 */}
                <SubCard title={dict.traffic.searchRanks}>
                  <div className="flex flex-col gap-5">
                    {ranks?.global || ranks?.country ? (
                      <div className="grid grid-cols-2 gap-4">
                        <div className="rounded-lg border border-border p-4">
                          <span className="text-xs text-ink-muted">{dict.traffic.globalRank}</span>
                          <p className="text-2xl font-semibold tabular-nums text-ink">{ranks.global ? ranks.global.toLocaleString("en-US") : "—"}</p>
                        </div>
                        <div className="rounded-lg border border-border p-4">
                          <span className="text-xs text-ink-muted">{dict.traffic.countryRank}</span>
                          <p className="text-2xl font-semibold tabular-nums text-ink">{ranks.country ? ranks.country.toLocaleString("en-US") : "—"}</p>
                        </div>
                      </div>
                    ) : null}
                    {keywords.length ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead className="text-xs text-ink-muted">
                            <tr>
                              <th className="py-2 font-medium">{dict.keywords.term}</th>
                              <th className="whitespace-nowrap py-2 text-right font-medium">{dict.keywords.volume}</th>
                              <th className="whitespace-nowrap py-2 text-right font-medium">{dict.keywords.cpc}</th>
                              <th className="whitespace-nowrap py-2 text-right font-medium">{dict.keywords.traffic}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {keywords.slice(0, 8).map((k) => (
                              <tr key={k.term} className="border-t border-border">
                                <td className="py-2.5 text-ink">{k.term}</td>
                                <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-ink-secondary">{k.volume ? formatCount(k.volume) : "—"}</td>
                                <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-ink-secondary">{k.cpc ? `$${k.cpc}` : "—"}</td>
                                <td className="whitespace-nowrap py-2.5 text-right tabular-nums text-ink-secondary">{k.traffic ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                    {rankDistribution.length ? (
                      <div>
                        <span className="text-xs text-ink-muted">{dict.traffic.rankDistribution}</span>
                        <div className="mt-2">
                          <Bars items={rankDistribution.map((r) => ({ label: r.label, value: r.count, suffix: " 个" }))} />
                        </div>
                      </div>
                    ) : null}
                    {!keywords.length && !rankDistribution.length && !ranks?.global && !ranks?.country ? (
                      <Pending text={`${dict.traffic.searchRanks} · ${dict.analysis.pending}`} />
                    ) : null}
                  </div>
                </SubCard>
              </div>
            }
            right={
              <div className="lg:sticky lg:top-32 lg:self-start">
                <div className="flex flex-col gap-4">
                  {td ? (
                    <>
                      <div className="rounded-2xl border border-border bg-surface px-5 py-4">
                        <div className="flex items-center gap-2">
                          <span aria-hidden>💡</span>
                          <h3 className="text-sm font-semibold text-ink">{dict.trafficDecrypt.overview}</h3>
                        </div>
                        <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{td.overview}</p>
                      </div>
                      {td.sections?.map((s) => (
                        <div key={s.title} className="rounded-2xl border border-border bg-surface px-5 py-4">
                          <h3 className="text-sm font-semibold text-ink">{s.title}</h3>
                          {s.highlights?.length ? (
                            <div className="mt-2.5 flex flex-wrap gap-2">
                              {s.highlights.map((h) => (
                                <Badge key={h}>{h}</Badge>
                              ))}
                            </div>
                          ) : null}
                          <p className="mt-3 text-xs font-semibold text-ink-muted">{dict.trafficDecrypt.insight}</p>
                          <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{s.insight}</p>
                          <p className="mt-3 text-xs font-semibold text-ink-muted">{dict.trafficDecrypt.takeaway}</p>
                          <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{s.takeaway}</p>
                        </div>
                      ))}
                    </>
                  ) : (
                    <Pending text={`${dict.sections.traffic.title} · ${dict.analysis.pending}`} />
                  )}
                </div>
              </div>
            }
          />
        </section>

        {/* ------------------------ 04 这门生意 ------------------------ */}
        <section id="business" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.business.no}
            title={dict.sections.business.title}
            desc={dict.sections.business.desc}
          />
          <div className="flex flex-col gap-6">
            {/* 变现蓝图（通栏，避免左栏留白） */}
            <div className="rounded-2xl border border-border bg-surface p-6">
              <h3 className="text-base font-semibold text-ink">{t.monetization}</h3>
              {mb ? (
                <div className="mt-4 flex flex-col gap-5">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl bg-surface-2 px-4 py-3">
                      <span className="text-xs text-ink-muted">{t.model}</span>
                      <p className="mt-1 text-sm font-medium leading-relaxed break-words text-ink">
                        {mb.model}
                      </p>
                    </div>
                    <div className="rounded-xl bg-surface-2 px-4 py-3">
                      <span className="text-xs text-ink-muted">{t.payment}</span>
                      {mb.monthlyRevenueSignal ? (
                        <>
                          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink">
                            {formatCount(mb.monthlyRevenueSignal)}
                          </p>
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {t.paymentNote}
                          </p>
                          {mb.paymentDetected?.length ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {mb.paymentDetected.map((p) => <Badge key={p}>{p}</Badge>)}
                            </div>
                          ) : null}
                        </>
                      ) : mb.paymentDetected?.length ? (
                        <div className="mt-1.5 flex flex-wrap gap-2">
                          {mb.paymentDetected.map((p) => <Badge key={p}>{p}</Badge>)}
                        </div>
                      ) : (
                        <p className="mt-1 text-sm text-ink-muted">未检测到</p>
                      )}
                    </div>
                  </div>
                  {mb.tiers?.length ? (
                    <div>
                      <span className="text-xs text-ink-muted">{t.tiers}</span>
                      <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                        {mb.tiers.map((tier) => (
                          <li
                            key={tier}
                            className="rounded-lg border border-border px-3 py-2 text-sm leading-relaxed break-words text-ink-secondary"
                          >
                            {tier}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {mb.pricingAdvice ? (
                    <div className="rounded-lg border border-primary/20 bg-primary-soft px-4 py-3">
                      <span className="text-xs font-medium text-primary">{t.pricingAdvice}</span>
                      <p className="mt-1 text-sm leading-relaxed break-words text-ink-secondary">
                        {mb.pricingAdvice}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4"><Pending text={`${t.monetization} · ${dict.analysis.pending}`} /></div>
              )}
            </div>

            {/* 增长复盘（通栏三栏，避免窄栏挤压文字） */}
            <div className="rounded-2xl border border-border bg-surface p-6">
              <h3 className="text-base font-semibold text-ink">{t.growth}</h3>
              {gp ? (
                <div className="mt-4 flex flex-col gap-5">
                  {gp.coldStart ? (
                    <div className="rounded-xl bg-surface-2 px-4 py-3">
                      <span className="text-xs text-ink-muted">{t.coldStart}</span>
                      <p className="mt-1 text-sm leading-relaxed break-words text-ink-secondary">
                        {gp.coldStart}
                      </p>
                    </div>
                  ) : null}
                  <div className="grid gap-6 border-t border-border pt-5 md:grid-cols-2 xl:grid-cols-3">
                    {gp.channels?.length ? (
                      <div className="flex min-w-0 flex-col gap-3">
                        <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-primary">{t.channels}</h4>
                        <ul className="flex flex-col gap-2.5">
                          {gp.channels.map((c) => (
                            <li key={c} className="flex items-start gap-2 text-sm">
                              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                              <span className="min-w-0 flex-1 leading-relaxed break-words text-ink-secondary">{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {gp.copyable?.length ? (
                      <div className="flex min-w-0 flex-col gap-3">
                        <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-success">{t.copyable}</h4>
                        <ul className="flex flex-col gap-2.5">
                          {gp.copyable.map((c) => (
                            <li key={c} className="flex items-start gap-2 text-sm">
                              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success-soft text-success" aria-hidden>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
                              </span>
                              <span className="min-w-0 flex-1 leading-relaxed break-words text-ink-secondary">{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {gp.avoid?.length ? (
                      <div className="flex min-w-0 flex-col gap-3">
                        <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-danger">{t.avoid}</h4>
                        <ul className="flex flex-col gap-2.5">
                          {gp.avoid.map((c) => (
                            <li key={c} className="flex items-start gap-2 text-sm">
                              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger" aria-hidden>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                              </span>
                              <span className="min-w-0 flex-1 leading-relaxed break-words text-ink-secondary">{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="mt-4"><Pending text={`${t.growth} · ${dict.analysis.pending}`} /></div>
              )}
            </div>
          </div>
        </section>

        {/* ------------------------ 05 怎么复制 ------------------------ */}
        <section id="playbook" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.playbook.no}
            title={dict.sections.playbook.title}
            desc={dict.sections.playbook.desc}
          />
          <Split
            left={
              <div className="rounded-2xl border border-border bg-surface p-6">
                <h3 className="text-base font-semibold text-ink">{t.build}</h3>
                {bb ? (
                  <div className="mt-4 flex flex-col gap-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <span className="text-xs text-ink-muted">{t.devTime}</span>
                        <p className="text-sm font-medium text-ink">{bb.devTime}</p>
                      </div>
                      <div>
                        <span className="text-xs text-ink-muted">{t.monthlyCost}</span>
                        <p className="text-sm font-medium text-ink">{bb.monthlyCost}</p>
                      </div>
                    </div>
                    {bb.techStack?.length ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink-muted">{t.techStack}</span>
                        {bb.techStack.map((s) => <Badge key={s}>{s}</Badge>)}
                      </div>
                    ) : null}
                    {bb.thirdParty?.length ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink-muted">{t.thirdParty}</span>
                        {bb.thirdParty.map((s) => <Badge key={s}>{s}</Badge>)}
                      </div>
                    ) : null}
                    {bb.mvpScope ? (
                      <div>
                        <span className="text-xs text-ink-muted">{t.mvpScope}</span>
                        <p className="mt-1 text-sm leading-relaxed text-ink-secondary">{bb.mvpScope}</p>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-4"><Pending text={`${t.build} · ${dict.analysis.pending}`} /></div>
                )}
              </div>
            }
            right={
              <div className="rounded-2xl border border-border bg-surface p-6">
                <h3 className="text-base font-semibold text-ink">{dict.evidence.pageAudit}</h3>
                {audit ? (
                  <div className="mt-4 flex flex-col gap-4">
                    <div className="flex flex-wrap gap-2">
                      {audit.techStack?.map((s) => <Badge key={s}>{s}</Badge>)}
                      {audit.analytics?.map((s) => <Badge key={s}>{s}</Badge>)}
                    </div>
                    {ps ? (
                      <details className="group rounded-lg border border-border">
                        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-ink">
                          {dict.monetization.pageDetail}
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="transition group-open:rotate-180">
                            <path d="m6 9 6 6 6-6" />
                          </svg>
                        </summary>
                        <div className="border-t border-border p-4">
                          <dl className="grid gap-3 md:grid-cols-2">
                            {audit.wordCount !== undefined ? (
                              <div>
                                <dt className="text-xs text-ink-muted">{dict.monetization.wordCount}</dt>
                                <dd className="text-sm tabular-nums text-ink">{audit.wordCount}</dd>
                              </div>
                            ) : null}
                            {audit.pageLang ? (
                              <div>
                                <dt className="text-xs text-ink-muted">{dict.monetization.pageLang}</dt>
                                <dd className="text-sm text-ink">{audit.pageLang}</dd>
                              </div>
                            ) : null}
                            {audit.internalLinks !== undefined ? (
                              <div>
                                <dt className="text-xs text-ink-muted">{dict.monetization.internalLinks}</dt>
                                <dd className="text-sm tabular-nums text-ink">{audit.internalLinks}</dd>
                              </div>
                            ) : null}
                            {audit.outboundLinks !== undefined ? (
                              <div>
                                <dt className="text-xs text-ink-muted">{dict.monetization.outboundLinks}</dt>
                                <dd className="text-sm tabular-nums text-ink">{audit.outboundLinks}</dd>
                              </div>
                            ) : null}
                            {audit.structuredData?.length ? (
                              <div className="md:col-span-2">
                                <dt className="text-xs text-ink-muted">{dict.monetization.structuredData}</dt>
                                <dd className="mt-1 flex flex-wrap gap-2">
                                  {audit.structuredData.map((s) => <Badge key={s}>{s}</Badge>)}
                                </dd>
                              </div>
                            ) : null}
                          </dl>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-4"><Pending text={`${dict.evidence.pageAudit} · ${dict.analysis.pending}`} /></div>
                )}
              </div>
            }
          />
        </section>

        {/* ------------------------ 06 你能做什么 ------------------------ */}
        <section id="ideas" className="flex scroll-mt-36 flex-col gap-10">
          <SectionHeader
            no={dict.sections.ideas.no}
            title={dict.sections.ideas.title}
            desc={dict.sections.ideas.desc}
          />
          {sparks?.length ? (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {sparks.map((s) => (
                <div key={s.title} className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface p-5 transition hover:border-primary/40">
                  <h4 className="text-sm font-semibold text-ink">{s.title}</h4>
                  {s.angle ? <Badge>{s.angle}</Badge> : null}
                  {s.why ? <p className="text-sm leading-relaxed text-ink-secondary">{s.why}</p> : null}
                  {s.source ? (
                    <div className="mt-auto flex items-start gap-1.5 border-t border-border pt-2.5 text-xs text-ink-muted">
                      <span className="shrink-0 font-medium text-primary">{dict.analysis.ideaSource}</span>
                      <span>{s.source}</span>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <Pending text={`${t.sparks} · ${dict.analysis.pending}`} />
          )}

          {competitors.length ? (
            <div className="rounded-2xl border border-border bg-surface p-6">
              <h3 className="text-base font-semibold text-ink">{dict.observations.competitors}</h3>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {competitors.map((c) => (
                  <a
                    key={c}
                    href={`https://${c}`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-4 py-3 transition hover:border-primary/40 hover:bg-surface"
                  >
                    <Favicon domain={c} />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{c}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0 text-ink-muted">
                      <path d="M7 7h10v10" />
                      <path d="M7 17 17 7" />
                    </svg>
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
