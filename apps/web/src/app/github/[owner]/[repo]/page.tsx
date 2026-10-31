import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import type { GitHubRepo, TrafficTrendPoint } from "@horizons/shared";
import {
  githubRepos,
  getRepoByFullName,
  computeStarGrowth,
  isPermissiveLicense,
  categoryLabel,
  repoScore,
  scoreGradeTone,
  repoIntro,
} from "@/lib/data";
import { TrafficTrendChart } from "@/components/detail/TrafficTrendChart";
import { formatCount, formatDateZh } from "@/lib/format";

/* ------------------------------- 小组件 ------------------------------- */

function Chip({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "primary" | "warn" | "ok" }) {
  const cls =
    tone === "primary"
      ? "border-primary/30 bg-primary/10 text-primary"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
        : tone === "ok"
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
          : "border-border bg-surface-2 text-ink-secondary";
  return (
    <span className={`inline-flex h-[22px] items-center rounded-full border px-2.5 text-[11px] ${cls}`}>
      {children}
    </span>
  );
}

const PHASE_STYLE: Record<string, { dot: string; chip: string }> = {
  验证: { dot: "bg-sky-400", chip: "border-sky-400/30 bg-sky-400/10 text-sky-400" },
  起步: { dot: "bg-primary", chip: "border-primary/30 bg-primary/10 text-primary" },
  变现: { dot: "bg-emerald-500", chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-500" },
  增长: { dot: "bg-amber-500", chip: "border-amber-500/30 bg-amber-500/10 text-amber-500" },
};

const PHASE_ORDER = ["验证", "起步", "变现", "增长"] as const;

function Section({ no, title, desc, children }: { no: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-5 py-3.5">
        <span className="text-[11px] tabular-nums tracking-widest text-ink-muted">{no}</span>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {desc ? <p className="text-xs text-ink-muted">{desc}</p> : null}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "primary" | "ok" | "warn" | "muted" }) {
  const color =
    tone === "primary"
      ? "text-primary"
      : tone === "ok"
        ? "text-emerald-500"
        : tone === "warn"
          ? "text-amber-500"
          : "text-ink";
  return (
    <div className="rounded-xl border border-border bg-surface-2/60 px-3.5 py-2.5">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className={`mt-0.5 text-base font-semibold tabular-nums ${color}`}>{value}</div>
      {hint ? <div className="mt-0.5 text-[11px] text-ink-muted">{hint}</div> : null}
    </div>
  );
}

function Bars({ values, unit = "次" }: { values: number[]; unit?: string }) {
  if (!values.length) return <p className="text-xs text-ink-muted">暂无数据</p>;
  const max = Math.max(...values, 1);
  return (
    <div className="flex h-16 items-end gap-[2px]">
      {values.map((v, i) => (
        <div
          key={i}
          title={`${v} ${unit}`}
          className="flex-1 rounded-sm bg-primary/60"
          style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function toTrendPoints(repo: GitHubRepo): TrafficTrendPoint[] {
  return (repo.history ?? []).map((h) => ({ date: h.date, total: h.stars, organic: 0 }));
}

/* ------------------------------- 路由 ------------------------------- */

export function generateStaticParams() {
  return githubRepos.map((r) => ({ owner: r.owner, repo: r.repo }));
}

export async function generateMetadata({ params }: { params: Promise<{ owner: string; repo: string }> }): Promise<Metadata> {
  const { owner, repo } = await params;
  const r = getRepoByFullName(`${owner}/${repo}`);
  return { title: r ? `${r.fullName} · GitHub 榜` : "GitHub 榜" };
}

export default async function RepoPage({ params }: { params: Promise<{ owner: string; repo: string }> }) {
  const { owner, repo } = await params;
  const r = getRepoByFullName(`${owner}/${repo}`);
  if (!r) notFound();

  const ins = r.insight;
  const score = repoScore(r);
  const scoreTone: "ok" | "primary" | "warn" | "muted" =
    score.grade === "S" ? "ok" : score.grade === "A" ? "primary" : score.grade === "B" ? "warn" : "muted";
  const growth7 = computeStarGrowth(r, 7);
  const growth30 = computeStarGrowth(r, 30);
  const trend = toTrendPoints(r);
  const permissive = isPermissiveLicense(r);
  const commit = r.commitActivity ?? [];
  /* GitHub 返回的是各语言字节数，这里换算成占比后再展示 */
  const langTotal = Object.values(r.languages ?? {}).reduce((a, b) => a + b, 0);
  const languages: [string, number][] = Object.entries(r.languages ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => [name, langTotal > 0 ? Math.round((bytes / langTotal) * 100) : 0]);
  const diffTone = ins?.difficulty === "低" ? "ok" : ins?.difficulty === "高" ? "warn" : "muted";

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Hero */}
      <section className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-3">
              {r.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={r.avatarUrl} alt={r.owner} className="mt-0.5 h-11 w-11 rounded-xl border border-border" />
              ) : null}
              <div className="min-w-0">
                <h1 className="truncate text-xl font-bold tracking-tight text-ink sm:text-2xl">{r.fullName}</h1>
                <p className="mt-1 line-clamp-2 text-base font-medium text-primary">{repoIntro(r)}</p>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Chip tone={scoreTone}>
                综合得分 {score.score.toFixed(1)} · {score.grade} 级
              </Chip>
              <Chip tone="primary">⭐ 星标 {formatCount(r.stars)}</Chip>
              <Chip>🍴 复刻 {formatCount(r.forks)}</Chip>
              {r.language ? <Chip>{r.language}</Chip> : null}
              {r.license ? <Chip>{r.license.spdx ?? r.license.name}</Chip> : null}
              {ins ? <Chip tone={diffTone}>上手难度：{ins.difficulty}</Chip> : null}
              {ins ? <Chip>首版：{ins.timeToMvp}</Chip> : null}
              {ins ? <Chip>月成本：{ins.costToMvp}</Chip> : null}
            </div>

            <p className="mt-4 text-sm leading-relaxed text-ink-secondary">
              {ins?.whatZh ?? `${categoryLabel(r.categories[0] ?? "Other")}方向的开源项目，中文情报生成中。`}
            </p>

            {ins?.capabilities?.length ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {ins.capabilities.map((c) => (
                  <span key={c} className="rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-secondary">
                    {c}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-col gap-2 md:w-44">
            <a
              href={r.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary-hover"
            >
              在 GitHub 查看
            </a>
            {r.homepage ? (
              <a
                href={r.homepage}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-lg border border-border px-4 py-2 text-sm text-ink-secondary transition hover:text-ink"
              >
                官网 / 演示
              </a>
            ) : null}
            <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[11px] leading-relaxed text-ink-muted">
              数据来自 GitHub 官方接口
              <br />
              最近同步 {r.lastCrawledAt ? formatDateZh(r.lastCrawledAt) : "—"}
            </div>
          </div>
        </div>
      </section>

      {/* 关键指标条 */}
      <section className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8">
        <Stat
          label="综合得分"
          value={score.score.toFixed(1)}
          hint={`${score.grade} 级 · 满分 100`}
          tone={scoreTone}
        />
        <Stat label="星标" value={formatCount(r.stars)} tone="primary" />
        <Stat label="复刻" value={formatCount(r.forks)} />
        <Stat label="贡献者" value={r.contributorsCount !== undefined ? formatCount(r.contributorsCount) : "—"} />
        <Stat
          label="近 30 天增速"
          value={growth30 !== null ? `${growth30 > 0 ? "+" : ""}${growth30}%` : "—"}
          tone={growth30 !== null && growth30 >= 0 ? "ok" : "muted"}
        />
        <Stat label="上手难度" value={ins?.difficulty ?? "—"} tone={diffTone === "ok" ? "ok" : diffTone === "warn" ? "warn" : "muted"} />
        <Stat label="做出首版" value={ins?.timeToMvp ?? "—"} />
        <Stat label="首版月成本" value={ins?.costToMvp ?? "—"} />
      </section>

      {/* 主体：左内容 + 右数据 */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_336px]">
        <div className="space-y-5">
          {/* 能做什么 */}
          <Section no="01" title="能用来做出什么产品" desc="面向个人 / 小团队，基于它的能力可落地的方向">
            {ins?.buildIdeas?.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {ins.buildIdeas.map((idea, i) => (
                  <div key={i} className="rounded-xl border border-border bg-surface-2/40 p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] tabular-nums text-ink-muted">{String(i + 1).padStart(2, "0")}</span>
                      <h3 className="text-sm font-semibold text-ink">{idea.title}</h3>
                    </div>
                    <p className="mt-1 text-xs text-ink-muted">适合：{idea.audience}</p>
                    <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{idea.product}</p>
                    <dl className="mt-3 space-y-1 text-xs">
                      <div className="flex gap-1.5">
                        <dt className="shrink-0 text-ink-muted">变现</dt>
                        <dd className="text-ink-secondary">{idea.monetization}</dd>
                      </div>
                      <div className="flex gap-1.5">
                        <dt className="shrink-0 text-ink-muted">人力</dt>
                        <dd className="text-ink-secondary">{idea.effort}</dd>
                      </div>
                      {idea.stackHint ? (
                        <div className="flex gap-1.5">
                          <dt className="shrink-0 text-ink-muted">技术</dt>
                          <dd className="text-ink-secondary">{idea.stackHint}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">情报生成中。</p>
            )}
          </Section>

          {/* 怎么做 */}
          <Section no="02" title="怎么做" desc="按阶段推进：先验证，再起步，然后变现与增长">
            {ins?.buildSteps?.length ? (
              <div className="space-y-4">
                {/* 阶段概览 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {PHASE_ORDER.map((p, i) => {
                    const n = ins.buildSteps.filter((s) => s.phase === p).length;
                    if (!n) return null;
                    return (
                      <span key={p} className="flex items-center gap-1.5">
                        {i > 0 ? <span className="text-[11px] text-ink-muted">→</span> : null}
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${PHASE_STYLE[p]?.chip ?? ""}`}>
                          {p} · {n}
                        </span>
                      </span>
                    );
                  })}
                </div>

                {/* 时间轴 */}
                <ol className="relative ml-1 space-y-4 border-l border-border pl-5">
                  {ins.buildSteps.map((s, i) => {
                    const st = s.phase ? PHASE_STYLE[s.phase] : undefined;
                    return (
                      <li key={i} className="relative">
                        <span
                          className={`absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-surface ${st?.dot ?? "bg-ink-muted"}`}
                        />
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <h3 className="text-sm font-semibold text-ink">{s.step}</h3>
                          {s.phase ? (
                            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${st?.chip ?? ""}`}>{s.phase}</span>
                          ) : null}
                          {s.duration ? <span className="text-[11px] text-ink-muted">约 {s.duration}</span> : null}
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-ink-secondary">{s.detail}</p>
                        {s.output ? (
                          <p className="mt-1 text-[11px] text-ink-muted">
                            <span className="text-ink-secondary">产出：</span>
                            {s.output}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : (
              <p className="text-sm text-ink-muted">情报生成中。</p>
            )}
          </Section>

          {/* 能有什么效果 */}
          <Section no="03" title="能有什么效果" desc="可量化的预期，帮助你判断值不值得做">
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {(ins?.effects ?? []).map((e, i) => (
                <div key={i} className="rounded-xl border border-border bg-surface-2/40 px-3.5 py-2.5">
                  <div className="text-[11px] text-ink-muted">{e.metric}</div>
                  <div className="mt-0.5 text-base font-semibold text-primary">{e.value}</div>
                </div>
              ))}
            </div>
            {ins?.moat ? (
              <div className="mt-3 rounded-xl border border-primary/25 bg-primary/5 p-3.5">
                <p className="text-xs font-medium text-primary">护城河 / 差异化</p>
                <p className="mt-1 text-sm leading-relaxed text-ink">{ins.moat}</p>
              </div>
            ) : null}
          </Section>

          {/* 差异化 + 风险 */}
          <Section no="04" title="差异化与风险" desc="怎样避开同质化，以及要提前想清楚的坑">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-border bg-surface-2/40 p-4">
                <h3 className="text-xs font-medium text-ink-muted">差异化切入点</h3>
                <ul className="mt-2 space-y-1.5">
                  {(ins?.differentiators ?? []).map((d, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink-secondary">
                      <span className="text-emerald-500">+</span>
                      {d}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <h3 className="text-xs font-medium text-ink-muted">风险与门槛</h3>
                <ul className="mt-2 space-y-1.5">
                  {(ins?.risks ?? []).map((risk, i) => (
                    <li key={i} className="flex gap-2 text-sm text-ink-secondary">
                      <span className="text-amber-500">!</span>
                      {risk}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {ins?.techNotes ? (
              <div className="mt-3 rounded-xl border border-border px-3.5 py-2.5">
                <span className="text-xs text-ink-muted">技术要点：</span>
                <span className="text-sm text-ink-secondary">{ins.techNotes}</span>
              </div>
            ) : null}
          </Section>
        </div>

        {/* 右侧数据栏 */}
        <aside className="space-y-4 self-start lg:sticky lg:top-20">
          {/* 综合得分构成 */}
          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink">综合得分构成</h3>
              <span className="text-[11px] text-ink-muted">满分 100</span>
            </div>
            <div className="mt-2 flex items-end gap-2">
              <span className="text-3xl font-bold tabular-nums text-primary">{score.score.toFixed(1)}</span>
              <span
                className={`mb-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold ${scoreGradeTone[score.grade]}`}
              >
                {score.grade} 级
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-secondary">{score.summary}</p>
            <ul className="mt-3 space-y-2">
              {score.parts.map((p) => (
                <li key={p.key} title={p.note}>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-ink-secondary">
                      {p.label}
                      <span className="ml-1 text-ink-muted">{p.weight}%</span>
                    </span>
                    <span className="tabular-nums text-ink-muted">{p.points.toFixed(1)} 分</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${Math.max(2, Math.min(100, p.points))}%` }}
                    />
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-ink-muted">{p.note}</p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[10px] leading-relaxed text-ink-muted">
              横条长度＝该维度实际贡献的分值（占满分 100 的比例，权重越高最多能贡献越多），不是得分率。
              得分衡量的是「一个没多少经费的人，用它做出一款小而美、能收点钱的产品」的可能性——「轻启动机会」权重最高，重型基础设施项目会被降权。
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-ink">星标趋势（近 30 天）</h3>
              <div className="flex gap-2 text-[11px]">
                <span className={growth7 !== null && growth7 >= 0 ? "text-emerald-500" : "text-ink-muted"}>
                  7 天 {growth7 !== null ? `${growth7 > 0 ? "+" : ""}${growth7}%` : "—"}
                </span>
                <span className={growth30 !== null && growth30 >= 0 ? "text-emerald-500" : "text-ink-muted"}>
                  30 天 {growth30 !== null ? `${growth30 > 0 ? "+" : ""}${growth30}%` : "—"}
                </span>
              </div>
            </div>
            <div className="mt-2">
              {trend.length >= 2 ? <TrafficTrendChart points={trend} variant="stars" /> : <p className="py-6 text-center text-xs text-ink-muted">趋势积累中</p>}
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">提交活跃（近 52 周）</h3>
            <div className="mt-3">
              <Bars values={commit} unit="次提交" />
            </div>
            {commit.length ? (
              <p className="mt-2 text-[11px] text-ink-muted">
                近 4 周合计 {commit.slice(-4).reduce((a, b) => a + b, 0)} 次提交
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-ink-muted">未采集到提交数据</p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">语言占比</h3>
            {languages.length ? (
              <ul className="mt-3 space-y-2">
                {languages.map(([name, pct]) => (
                  <li key={name}>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-ink-secondary">{name}</span>
                      <span className="tabular-nums text-ink-muted">{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-ink-muted">该项目以 {r.language ?? "未知语言"} 为主</p>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-surface p-4">
            <h3 className="text-sm font-semibold text-ink">项目档案</h3>
            <dl className="mt-3 space-y-2 text-xs">
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">许可证</dt>
                <dd className="text-right text-ink-secondary">
                  {r.license ? (r.license.spdx ?? r.license.name) : "未知"}
                  <span className={permissive ? "ml-1 text-emerald-500" : "ml-1 text-amber-500"}>{permissive ? "可商用" : "需确认"}</span>
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">创建时间</dt>
                <dd className="text-right text-ink-secondary">{r.createdAt ? formatDateZh(r.createdAt) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">最近提交</dt>
                <dd className="text-right text-ink-secondary">{r.pushedAt ? formatDateZh(r.pushedAt) : "—"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-ink-muted">用途分类</dt>
                <dd className="text-right text-ink-secondary">{r.categories.map((c) => categoryLabel(c)).join(" / ")}</dd>
              </div>
            </dl>
          </div>

          {ins?.competitors?.length ? (
            <div className="rounded-2xl border border-border bg-surface p-4">
              <h3 className="text-sm font-semibold text-ink">竞品 / 参考</h3>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {ins.competitors.map((c) => (
                  <Chip key={c}>{c}</Chip>
                ))}
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}