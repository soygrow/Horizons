/**
 * 列表行 HTML 模板（唯一真源）
 *
 * 构建期由 scripts/build/artifacts.ts 预渲染每行 HTML，写入 index.json 的 `h` 字段：
 *  - 首屏 Astro 直接 set:html 输出，零 JS、不闪屏；
 *  - 客户端筛选/搜索只做「过滤 + 拼接 h」，不存在第二套模板，杜绝新旧不一致；
 *  - 类名位于 apps/site 内，Tailwind 可正常扫描。
 */
import { categoryLabel } from "./labels";
import { formatCount, formatDateShort } from "./format";
import type { RepoRow, ToolRow, TrendRow } from "./types";

/** 排名占位符：筛选后序号会变，由渲染方调用 fillRank 填入 */
export const RANK_TOKEN = "%R%";

export const fillRank = (html: string, n: number) =>
  html.replace(RANK_TOKEN, String(n).padStart(2, "0"));

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 必须与 components/ToolListHead.astro 的 TOOL_GRID 一致 */
export const TOOL_GRID =
  "grid-cols-[1.5rem_9.5rem_minmax(0,1fr)_6rem_5.5rem_4.5rem_4.5rem_5rem_4.5rem_5rem]";

/** 必须与 components/RepoListHead.astro 的 REPO_GRID 一致 */
export const REPO_GRID =
  "grid-cols-[2.5rem_minmax(0,2.4fr)_5.5rem_6.5rem_5rem_4.5rem_4.5rem_9rem_4.5rem_5rem]";

/** 必须与 components/TrendListHead.astro 的 TREND_GRID 一致 */
export const TREND_GRID =
  "grid-cols-[2.25rem_minmax(0,1.9fr)_5.5rem_5.5rem_6.5rem_4.5rem_minmax(0,1.7fr)_6.5rem_4.5rem_4.75rem]";

const ICON_PALETTE = [
  "bg-indigo-500/20 text-indigo-300",
  "bg-violet-500/20 text-violet-300",
  "bg-sky-500/20 text-sky-300",
  "bg-emerald-500/20 text-emerald-300",
  "bg-rose-500/20 text-rose-300",
  "bg-amber-500/20 text-amber-300",
];

function hash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

/** 工具图标：DuckDuckGo favicon，失败降级为首字母方块（与 ToolIcon.tsx 一致） */
export function iconHtml(domain: string, name: string, size: "md" | "lg" = "md"): string {
  const cls = size === "lg" ? "h-14 w-14 text-xl" : "h-10 w-10 text-base";
  const px = size === "lg" ? 56 : 40;
  const initial = esc((name || domain).charAt(0).toUpperCase());
  const color = ICON_PALETTE[hash(domain) % ICON_PALETTE.length];
  const id = `ico-${domain.replace(/[^a-z0-9]/gi, "")}`;
  return (
    `<span class="relative inline-flex shrink-0">` +
    `<img id="${id}" src="https://icons.duckduckgo.com/ip3/${esc(domain)}.ico" alt="${esc(name)} icon" ` +
    `width="${px}" height="${px}" loading="lazy" decoding="async" ` +
    `class="${cls} shrink-0 rounded-xl border border-border bg-surface object-contain p-1" ` +
    `onerror="this.style.display='none';var f=document.getElementById('${id}-fb');if(f)f.style.display='flex';">` +
    `<span id="${id}-fb" style="display:none" class="${cls} shrink-0 items-center justify-center rounded-xl font-semibold ${color}">${initial}</span>` +
    `</span>`
  );
}

/** sparkline：points 为 0-100 整数，算法与 Sparkline.astro 一致 */
export function sparklineSvg(points: number[] | null, width = 72, height = 26): string {
  const mid = height / 2;
  if (!points || points.length < 2) {
    return (
      `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="text-ink-muted" aria-label="趋势待积累">` +
      `<line x1="0" y1="${mid}" x2="${width}" y2="${mid}" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" />` +
      `</svg>`
    );
  }

  const step = width / (points.length - 1);
  // points 是 0-100 整数，绘制前归一化到 0-1（与 Sparkline.astro 的 p / 100 一致）
  const coords = points.map((p, i) => ({
    x: i * step,
    y: height - (p / 100) * (height - 4) - 2,
  }));
  let d = `M${coords[0].x.toFixed(1)},${coords[0].y.toFixed(1)}`;
  for (let i = 1; i < coords.length - 1; i++) {
    const xc = (coords[i].x + coords[i + 1].x) / 2;
    const yc = (coords[i].y + coords[i + 1].y) / 2;
    d += ` Q${coords[i].x.toFixed(1)},${coords[i].y.toFixed(1)} ${xc.toFixed(1)},${yc.toFixed(1)}`;
  }
  const last = coords[coords.length - 1];
  d += ` L${last.x.toFixed(1)},${last.y.toFixed(1)}`;

  return (
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" class="text-accent" aria-label="流量趋势">` +
    `<path d="${d} L${width},${height} L0,${height} Z" fill="currentColor" opacity="0.12" />` +
    `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />` +
    `<circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2" fill="currentColor" />` +
    `</svg>`
  );
}

/* ------------------------------ AI 工具榜行 ------------------------------ */

export function toolRowHtml(t: ToolRow): string {
  const momCls = t.mom === null ? "text-ink-muted" : t.mom >= 0 ? "text-accent" : "text-rose-400";
  const momText = t.mom !== null ? `${t.mom > 0 ? "+" : ""}${t.mom}%` : "n/a";
  const momTitle = t.mom === null ? ` title="上月无数据，无法计算环比"` : "";
  const drTitle = t.dr === null ? ` title="未采集到域名权重"` : "";

  return (
    `<a href="/tools/${esc(t.domain)}" target="_blank" rel="noopener noreferrer" ` +
    `class="group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${TOOL_GRID}">` +
    `<span class="text-center text-sm font-semibold text-ink-muted tabular-nums">${RANK_TOKEN}</span>` +
    `<div class="flex min-w-0 items-center justify-start gap-2.5">` +
    iconHtml(t.domain, t.name) +
    `<div class="min-w-0">` +
    `<div class="flex items-center gap-1.5"><h3 class="truncate text-sm font-semibold text-ink group-hover:text-primary">${esc(t.name)}</h3></div>` +
    `<p class="mt-0.5 truncate text-xs text-ink-muted">${esc(t.domain)}</p>` +
    `</div></div>` +
    `<p class="line-clamp-2 text-left text-sm leading-snug text-ink-secondary">${esc(t.desc)}</p>` +
    `<div class="flex justify-center">${sparklineSvg(t.spark, 88, 28)}</div>` +
    `<div class="flex flex-col items-center gap-1">` +
    t.cats
      .slice(0, 2)
      .map(
        (c) =>
          `<span class="whitespace-nowrap rounded-md border border-border px-1.5 py-0.5 text-[11px] text-ink-secondary">${esc(categoryLabel(c))}</span>`,
      )
      .join("") +
    `</div>` +
    `<div class="text-center text-sm text-ink-secondary tabular-nums">${t.visits !== null ? formatCount(t.visits) : "n/a"}</div>` +
    `<div${momTitle} class="text-center text-sm tabular-nums ${momCls}">${momText}</div>` +
    `<div class="text-center text-sm text-ink-secondary tabular-nums">${t.organic !== null ? formatCount(t.organic) : "n/a"}</div>` +
    `<div${drTitle} class="text-center text-sm text-ink-secondary tabular-nums">${t.dr !== null ? `${formatCount(t.dr)} ${esc(t.drLabel ?? "DR")}` : "n/a"}</div>` +
    `<div class="whitespace-nowrap text-center text-sm text-ink-secondary tabular-nums">${formatDateShort(t.launchedAt)}</div>` +
    `</a>`
  );
}

/* ------------------------------ GitHub 榜行 ------------------------------ */

const GRADE_TONE: Record<string, string> = {
  S: "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  A: "border-primary/40 bg-primary/10 text-primary",
  B: "border-amber-500/40 bg-amber-500/10 text-amber-500",
  C: "border-border bg-surface-2 text-ink-muted",
};

export function repoRowHtml(r: RepoRow): string {
  const diffCls =
    r.diff === "低"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
      : r.diff === "高"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-500"
        : "border-border bg-surface-2 text-ink-secondary";

  const g30Cls =
    r.g30 === null ? "text-ink-muted" : r.g30 >= 0 ? "text-emerald-500" : "text-rose-400";
  const g30Text = r.g30 !== null ? `${r.g30 > 0 ? "+" : ""}${r.g30}%` : "—";

  const days =
    r.pushedDaysAgo === null ? "—" : r.pushedDaysAgo === 0 ? "今天" : `${r.pushedDaysAgo} 天前`;

  const licenseCls = r.license
    ? r.permissive
      ? "text-emerald-500"
      : "text-amber-500"
    : "text-ink-muted";

  const scoreBar = Math.min(100, Math.max(4, r.score));

  return (
    `<a href="/github/${esc(r.owner)}/${esc(r.repo)}" target="_blank" rel="noopener noreferrer" ` +
    `class="group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${REPO_GRID}">` +
    `<span class="text-sm font-semibold text-ink-muted tabular-nums">${RANK_TOKEN}</span>` +
    `<div class="flex min-w-0 items-start gap-2.5">` +
    (r.avatar
      ? `<img src="${esc(r.avatar)}" alt="" loading="lazy" decoding="async" class="mt-0.5 h-7 w-7 shrink-0 rounded-md border border-border bg-surface-2 object-cover" />`
      : `<span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-[10px] font-semibold text-ink-muted">${esc((r.owner || "?").charAt(0).toUpperCase())}</span>`) +
    `<div class="min-w-0">` +
    `<div class="flex items-center gap-2">` +
    `<h3 class="truncate text-sm font-semibold text-ink group-hover:text-primary">${esc(r.fullName)}</h3>` +
    `<span class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${diffCls}">${esc(r.diff)}</span>` +
    `</div>` +
    `<p class="mt-0.5 line-clamp-2 text-xs leading-snug text-ink-secondary">${esc(r.intro)}</p>` +
    `</div></div>` +
    `<div class="text-center">` +
    `<div class="flex items-baseline justify-center gap-1">` +
    `<span class="text-sm font-bold tabular-nums text-ink">${r.score.toFixed(1)}</span>` +
    `<span class="rounded border px-1 text-[10px] font-semibold ${GRADE_TONE[r.grade] ?? GRADE_TONE.C}">${esc(r.grade)}</span>` +
    `</div>` +
    `<div class="mx-auto mt-1 h-1 w-14 overflow-hidden rounded-full bg-surface-2">` +
    `<div class="h-full rounded-full bg-primary" style="width:${scoreBar}%"></div>` +
    `</div></div>` +
    `<div class="flex justify-center">${sparklineSvg(r.spark, 88, 26)}</div>` +
    `<div class="text-center text-sm text-ink-secondary tabular-nums">${formatCount(r.stars)}</div>` +
    `<div class="text-center text-sm tabular-nums ${g30Cls}">${g30Text}</div>` +
    `<div class="truncate text-center text-xs text-ink-secondary">${r.lang ? esc(r.lang) : "—"}</div>` +
    (r.cats.length
      ? `<div class="grid grid-cols-2 gap-1">` +
        r.cats
          .map(
            (c) =>
              `<span title="${esc(categoryLabel(c))}" class="truncate rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-center text-[10px] leading-4 text-ink-secondary">${esc(categoryLabel(c))}</span>`,
          )
          .join("") +
        `</div>`
      : `<span class="block text-center text-xs text-ink-secondary">—</span>`) +
    `<div title="距项目最后一次提交（GitHub push）的天数" class="text-center text-xs text-ink-muted">${days}</div>` +
    `<div class="truncate text-center text-xs ${licenseCls}">${r.license ? esc(r.license) : "—"}</div>` +
    `</a>`
  );
}

/* ------------------------------ AI 趋势词行 ------------------------------ */

export function trendRowHtml(t: TrendRow): string {
  return (
    `<a href="/trends/${esc(t.slug)}" ` +
    `class="group grid items-center gap-3 border-b border-border px-4 py-3 transition hover:bg-surface-2 sm:px-5 ${TREND_GRID}">` +
    `<span class="text-sm font-semibold tabular-nums text-ink-muted">${RANK_TOKEN}</span>` +
    `<div class="min-w-0">` +
    `<h3 class="truncate text-sm font-semibold text-ink group-hover:text-primary">${esc(t.normalizedName)}</h3>` +
    `<p class="mt-0.5 truncate text-xs text-ink-muted"><span class="font-mono">${esc(t.keyword)}</span>` +
    (t.seenDays !== null ? `<span class="ml-2">首次发现 ${t.seenDays} 天</span>` : "") +
    `</p></div>` +
    `<span class="truncate text-xs text-ink-secondary" title="${esc(t.catLabel)}">${esc(t.catLabel)}</span>` +
    `<div class="min-w-0">` +
    `<span title="${esc(t.statusHint)}" class="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.statusCls}">` +
    `<span class="h-1.5 w-1.5 rounded-full ${t.statusDot}"></span>${esc(t.statusLabel)}</span>` +
    `</div>` +
    `<div class="flex flex-col items-start gap-0.5">` +
    sparklineSvg(t.spark, 84, 22) +
    `<span class="text-[11px] tabular-nums ${t.growthCls}">${esc(t.growthText)}` +
    `<span class="ml-1 text-ink-muted">基线 ${esc(t.baselineText)}</span></span>` +
    `</div>` +
    `<span title="${esc(t.confHint)}" class="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${t.confCls}">${esc(t.confLabel)}</span>` +
    `<p class="line-clamp-2 text-xs leading-snug text-ink-secondary">${esc(t.why)}</p>` +
    `<div class="flex flex-wrap gap-1">` +
    t.oppTypes
      .map(
        (o) =>
          `<span class="rounded-md border px-1.5 py-0.5 text-[10px] leading-4 ${o.cls}">${esc(o.label)}</span>`,
      )
      .join("") +
    `<span class="rounded-md border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] leading-4 text-ink-muted">${t.oppCount} 个方向</span>` +
    `</div>` +
    `<div class="flex flex-col items-center gap-0.5 text-[11px] tabular-nums">` +
    (t.scored
      ? `<span class="text-ink">趋势 <span class="font-semibold">${t.tv}</span></span>` +
        `<span class="text-ink-muted">机会 <span class="font-semibold text-ink-secondary">${t.op}</span></span>`
      : `<span class="text-ink-muted" title="采样点不足 14 个，暂不评分">数据不足</span>`) +
    `</div>` +
    `<span class="text-center text-[11px] tabular-nums text-ink-muted">${esc(t.updatedShort)}</span>` +
    `</a>`
  );
}