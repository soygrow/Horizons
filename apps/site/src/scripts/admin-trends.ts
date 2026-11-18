/**
 * 后台「趋势榜」页签。
 *
 * 与工具榜同一套路：真正干活的是 GitHub Actions，这里只做「拉取 → 审核 → 看位次变化 → 发布」。
 *
 * 这个面板最重要的不是把词列出来，而是**发布前把位次变化讲清楚**：
 * 一次发布往往牵动上百个词（插入一个词，后面全部顺延一名），全列等于没列，
 * 所以只展示「涉及前 50」或「变动 ≥ 3 名」的显著变动，其余单独报个条数。
 * 分级口径来自 @horizons/shared 的 diffRankRows，与发布脚本完全一致。
 */

import { $, apiGet, apiPost, debounce, esc, fmtNum, fmtTime } from "./admin-shared";

/* --------------------------------- 类型 --------------------------------- */

interface Job {
  id: string;
  kind: "fetch" | "publish";
  status: string;
  params: string;
  run_url: string | null;
  created_at: number;
}

interface CandidateView {
  slug: string;
  keyword: string;
  trend: number;
  /** 未富化时为 null：机会分要等 LLM 产出 */
  opportunity: number | null;
  overall: number | null;
  peak: number;
  lastValue: number;
  growth7: number | null;
  dataPoints: number;
  enrichStatus: "pending" | "failed" | null;
  /** 数据点 ≥14 即可勾选：未富化的词富化后入榜，在榜的词富化即刷新内容 */
  enrichable: boolean;
  inBoard: boolean;
  /** 已富化=合并后预计名次；未富化=按趋势分的参考名次 */
  estimatedRank: number | null;
  rankBasis: "overall" | "trend";
  issues: FieldIssue[];
  rejected: boolean;
  firstSeenAt: string;
  /** 刷新过的话有上一版摘要：用来判断新版是不是比旧版更差 */
  previous?: {
    at: string;
    why: string;
    opportunities: number;
    actions: number;
    relatedQueries: number;
  };
}

interface FieldIssue {
  block: string;
  fields: string[];
  level: "empty" | "fallback" | "suspect";
  detail: string;
}

interface QualitySummary {
  audited: number;
  dirty: number;
  clean: number;
  byLevel: { empty: number; fallback: number; suspect: number };
  byBlock: Record<string, number>;
  top: { label: string; count: number }[];
}

interface RankChange {
  slug: string;
  keyword: string;
  from: number | null;
  to: number | null;
  delta: number;
  significant: boolean;
}

interface LastPublish {
  at: string;
  incoming: number;
  removed: number;
  boardBefore?: number;
  boardAfter?: number;
  entered?: number;
  exited?: number;
  significant: number;
  shifted: number;
  /** 上一次发布时的前 40 条位次变动 */
  top?: { keyword: string; slug: string; from: number | null; to: number | null; delta: number }[];
}

interface LastRun {
  ok: number;
  failed: number;
  total: number;
  budget: number;
  geo: string;
}

interface StagingInfo {
  updatedAt: string;
  runAt: string;
  candidates: number;
  /** 已富化，可以直接发布 */
  ready?: number;
  /** 等富化 */
  pending: number;
  /** 数据点不足，不允许富化 */
  blocked?: number;
  rejected: number;
  boardRows: number;
  boardUpdatedAt: string | null;
  lastRun: LastRun | null;
  lastPublish: LastPublish | null;
  entered: number;
  significant: number;
}

/** 正式榜统计快照，候选池为空时也能显示真实在榜条数 */
interface BoardStat {
  total: number;
  updatedAt: string | null;
  source: string;
}

interface Overview {
  configured: boolean;
  missing: string[];
  staging: StagingInfo | null;
  jobs: Job[];
  /** 正式榜快照；候选池被清空或不存在时仍然有值 */
  board?: BoardStat | null;
  /** 榜单代表词上限 */
  boardLimit?: number;
  empty?: boolean;
  error?: string;
}

interface StagingResp {
  empty?: boolean;
  updatedAt: string | null;
  runAt: string | null;
  lastRun: LastRun | null;
  lastPublish: LastPublish | null;
  candidates: CandidateView[];
  stats?: { ready: number; pending: number; blocked: number };
  quality?: QualitySummary | null;
  report: {
    boardBefore: number;
    boardAfter: number;
    entered: number;
    exited: number;
    up: number;
    down: number;
    significant: number;
    shifted: number;
  } | null;
}

interface Preview {
  updatedAt: string;
  /** 榜单代表词上限（与发布脚本同一常量） */
  boardLimit: number;
  /** 合并后会因超上限被淘汰的词数（含别名） */
  trimmed: number;
  incoming: number;
  inBoardRefresh: number;
  boardBefore: number;
  boardAfter: number;
  entered: number;
  exited: number;
  up: number;
  down: number;
  significant: number;
  shifted: number;
  top: RankChange[];
  named: RankChange[];
  candidates: CandidateView[];
  lastPublish: LastPublish | null;
}

interface PreviewResp {
  empty?: boolean;
  preview: Preview | null;
}

/** 线上榜单里的一行：当前版本已发布的词 */
interface ListedTrend {
  slug: string;
  keyword: string;
  rank: number;
  category: string | null;
  confidence: string | null;
  /** 非空表示别名，名次继承代表词 */
  variantOf: string | null;
  firstSeenAt: string | null;
  /** 上次采到数据的日期，判断「该不该更新」就看它 */
  lastSeenAt: string | null;
  /** 候选池里的状态（candidate/enriched/enriching/…），null 表示不在队列里 */
  staging: string | null;
  scores: { trend: number; opportunity: number; overall: number };
}

interface ListedResp {
  version: string;
  total: number;
  /** 候选池里已刷新、等发布的词数 */
  refreshPending: number;
  items: ListedTrend[];
  detail?: string;
}

interface TrendSplit {
  slug: string;
  keyword: string;
  normalizedName?: string;
  status?: string;
  confidence?: string;
  category?: string;
  region?: string;
  why?: string;
  intentSummary?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  series?: { start: string; stepDays: number; values: number[] };
  trendParts?: Record<string, number>;
  oppParts?: Record<string, number>;
  editorNote?: { audience: string; entryAngle: string; whyAccepted: string };
  evidence?: { claim: string; claimType: string; date?: string; detail?: string }[];
  sources?: { label: string; url: string; kind: string }[];
  relatedQueries?: string[];
  competitors?: string[];
  variantOf?: string;
  opportunities?: { title: string; why?: string }[];
  actions?: { action: string }[];
  /** 刷新前留下的上一版内容，仅候选池里有；发布时会被剥离 */
  previousSnapshot?: {
    at: string;
    why?: string;
    intentSummary?: string;
    relatedQueries?: string[];
    opportunities?: { title: string; why?: string }[];
    actions?: { action: string }[];
  };
}

interface DetailResp {
  item: TrendSplit;
  view: CandidateView | null;
  boardRow: { slug: string; keyword: string; trend: number; opportunity: number; enough: boolean } | null;
}

/* --------------------------------- 状态 --------------------------------- */

const PAGE_SIZE = 30;

/** 线上榜单的每页条数：单批重采上限 40，翻两页刚好覆盖一批 */
const LISTED_PAGE_SIZE = 30;

const state = {
  filter: "all",
  q: "",
  page: 1,
  /** 线上榜单：数据、筛选与勾选（和候选池的选择分开，互不干扰） */
  listed: null as ListedResp | null,
  listedQ: "",
  /** all / stale(≥30 天) / old(≥60 天) / queued(已在候选池) */
  listedFilter: "all",
  listedPage: 1,
  listedSelected: new Set<string>(),
  /** 勾选待富化的 slug，刷新后保留——富化是一次远程任务，选择不能被轮询清掉 */
  selected: new Set<string>(),
  staging: null as StagingResp | null,
  preview: null as Preview | null,
  detailSlug: "",
  detailRejected: false,
  polling: 0 as number | undefined,
  mounted: false,
};

/* -------------------------------- 小工具 -------------------------------- */

const TREND_LABELS: Record<string, string> = {
  growth: "增长",
  persistence: "持续",
  breakout: "爆发",
  novelty: "新颖",
  reliability: "可靠",
};

const OPP_LABELS: Record<string, string> = {
  demand: "需求",
  wedge: "切入",
  seo: "SEO",
  feasibility: "可行",
  timing: "时机",
};

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "success":
      return { label: "成功", cls: "bg-accent-soft text-accent" };
    case "running":
      return { label: "运行中", cls: "bg-primary-soft text-primary" };
    case "failure":
      return { label: "失败", cls: "bg-danger-soft text-danger" };
    case "cancelled":
      return { label: "已取消", cls: "bg-surface-2 text-ink-muted" };
    default:
      return { label: "排队中", cls: "bg-surface-2 text-ink-muted" };
  }
}

/** 发布预览里每一条位次变化的类型徽章 */
function changeBadge(c: RankChange): string {
  if (c.from === null) {
    return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">新进榜</span>`;
  }
  if (c.to === null) {
    return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">出榜</span>`;
  }
  if (c.delta > 0) {
    return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">上升</span>`;
  }
  return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">下降</span>`;
}

/** 折线图：候选词的热度序列，最多取 120 个点，避免 SVG 太长 */
function sparkline(values: number[], width = 560, height = 90): string {
  if (!values.length) return `<p class="text-xs text-ink-muted">没有序列数据</p>`;
  const every = Math.max(1, Math.ceil(values.length / 120));
  const list = values.length > 120 ? values.filter((_, i) => i % every === 0) : values;
  const max = Math.max(...list, 1);
  const step = width / Math.max(list.length - 1, 1);
  const points = list
    .map((v, i) => `${(i * step).toFixed(1)},${(height - (v / max) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="h-24 w-full rounded-lg bg-surface-2">
      <polyline points="${points}" fill="none" stroke="var(--c-primary)" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>`;
}

function partBars(parts: Record<string, number> | undefined, labels: Record<string, string>): string {
  if (!parts) return "";
  return Object.entries(labels)
    .map(([key, label]) => {
      const v = Math.max(0, Math.min(100, Number(parts[key] ?? 0)));
      return `<div class="flex items-center gap-2">
          <span class="w-10 shrink-0 text-[11px] text-ink-muted">${esc(label)}</span>
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span class="block h-full rounded-full bg-primary/70" style="width:${v}%"></span>
          </span>
          <span class="w-8 shrink-0 text-right text-[11px] tabular-nums text-ink-secondary">${v}</span>
        </div>`;
    })
    .join("");
}

/* -------------------------------- 渲染 ---------------------------------- */

function renderOverview(data: Overview): void {
  $("trends-setup").classList.toggle("hidden", data.configured);

  if (!data.configured) {
    $("trends-setup-missing").textContent = `缺少：${data.missing.join("、")}`;
    for (const id of ["trend-kpi-board", "trend-kpi-candidates", "trend-kpi-pending", "trend-kpi-changes"]) {
      $(id).textContent = "—";
    }
    $("trends-fetch-btn").setAttribute("disabled", "true");
    $("trends-publish-btn").setAttribute("disabled", "true");
    return;
  }

  $("trends-fetch-btn").removeAttribute("disabled");
  const s = data.staging;
  if (!s) {
    // 候选池为空不代表榜单为空：正式榜还在线上跑，用统计快照显示真实条数
    $("trend-kpi-board").textContent = data.board ? fmtNum(data.board.total) : "—";
    $("trend-kpi-board-sub").textContent = data.board
      ? `正式榜 ${fmtNum(data.board.total)} 条${data.board.updatedAt ? ` · ${fmtTime(data.board.updatedAt)}` : ""}`
      : data.error
        ? `快照读取失败：${data.error}`
        : "还没有计分快照";
    $("trend-kpi-candidates").textContent = "—";
    $("trend-kpi-candidates-sub").textContent = "拉取一次后生成候选池";
    $("trend-kpi-pending").textContent = "—";
    $("trend-kpi-pending-sub").textContent = "—";
    $("trend-kpi-changes").textContent = "—";
    $("trend-kpi-changes-sub").textContent = "—";
    return;
  }

  $("trend-kpi-board").textContent = fmtNum(s.boardRows);
  const limitNote = data.boardLimit ? ` · 上限 ${fmtNum(data.boardLimit)} 条` : "";
  $("trend-kpi-board-sub").textContent = s.boardUpdatedAt
    ? `计分快照 ${fmtTime(s.boardUpdatedAt)}${limitNote}`
    : `候选池里没有榜单快照${limitNote}`;

  $("trend-kpi-candidates").textContent = fmtNum(s.candidates);
  $("trend-kpi-candidates-sub").textContent = s.lastRun
    ? `上次采集成功 ${fmtNum(s.lastRun.ok)} / 失败 ${fmtNum(s.lastRun.failed)}（${esc(s.lastRun.geo)}）`
    : "还没有采集记录";

  $("trend-kpi-pending").textContent = fmtNum(s.ready ?? s.pending);
  $("trend-kpi-pending-sub").textContent = [
    `待富化 ${fmtNum(s.pending)}`,
    s.blocked ? `数据不足 ${fmtNum(s.blocked)}` : "",
    `已拒绝 ${fmtNum(s.rejected)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  $("trend-kpi-changes").textContent = fmtNum(s.significant);
  $("trend-kpi-changes-sub").textContent = s.lastPublish
    ? `上次发布 ${fmtTime(s.lastPublish.at)}：进 ${s.lastPublish.incoming} · 显著 ${s.lastPublish.significant} · 顺延 ${s.lastPublish.shifted}`
    : `新进榜 ${fmtNum(s.entered)}，其余按顺延处理`;
}

/* ------------------------------- 线上榜单 -------------------------------- */

/** 单批重采上限，与后端 MAX_REFRESH_SLUGS 一致 */
const REFRESH_BATCH = 40;

/** 候选池状态 → 徽章。staging 非空就说明这个词已经在队列里了 */
const STAGE_BADGES: Record<string, { label: string; cls: string }> = {
  enriching: { label: "更新中", cls: "bg-primary-soft text-primary" },
  candidate: { label: "待富化", cls: "bg-accent-soft text-accent" },
  enriched: { label: "待发布", cls: "bg-accent-soft text-accent" },
  enrich_failed: { label: "富化失败", cls: "bg-danger/10 text-danger" },
  publishing: { label: "发布中", cls: "bg-primary-soft text-primary" },
  publish_failed: { label: "发布失败", cls: "bg-danger/10 text-danger" },
  rejected: { label: "已拒绝", cls: "bg-surface-2 text-ink-muted" },
};

/** 距离上次采集多少天；null 表示没有可用日期 */
function ageDays(date: string | null): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** 这个词现在能不能勾选：正在跑的、正在发布的别再提交一遍 */
function listedPickable(row: ListedTrend): boolean {
  return row.staging !== "enriching" && row.staging !== "publishing";
}

function visibleListed(data: ListedResp): ListedTrend[] {
  const q = state.listedQ.toLowerCase();
  return data.items.filter((row) => {
    if (q && !row.keyword.toLowerCase().includes(q) && !row.slug.includes(q)) return false;
    const age = ageDays(row.lastSeenAt) ?? 999;
    if (state.listedFilter === "stale") return age >= 30;
    if (state.listedFilter === "old") return age >= 60;
    if (state.listedFilter === "queued") return row.staging !== null;
    return true;
  });
}

function renderListed(data: ListedResp): void {
  state.listed = data;
  const meta = $("trends-listed-meta");
  const body = $("trends-listed-body");
  const pager = $("trends-listed-pager");

  if (!data.items.length) {
    meta.textContent = data.detail ?? "线上还没有趋势词，先采集并发布一次";
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-ink-muted">线上榜单还没有趋势词</td></tr>`;
    pager.innerHTML = "";
    syncListedBtn();
    return;
  }

  const stale = data.items.filter((r) => (ageDays(r.lastSeenAt) ?? 999) >= 30).length;
  const never = data.items.filter((r) => !r.lastSeenAt).length;
  meta.textContent =
    `版本 ${data.version || "—"} · 共 ${fmtNum(data.total)} 条（含别名）`
    + ` · 30 天未采集 ${fmtNum(stale)}${never ? `（其中从未采集 ${fmtNum(never)}）` : ""}`
    + (data.refreshPending ? ` · 候选池待发布 ${fmtNum(data.refreshPending)}` : "");

  const rows = visibleListed(data);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的词</td></tr>`;
    pager.innerHTML = "";
    syncListedBtn();
    return;
  }

  const pages = Math.max(1, Math.ceil(rows.length / LISTED_PAGE_SIZE));
  if (state.listedPage > pages) state.listedPage = pages;
  const slice = rows.slice((state.listedPage - 1) * LISTED_PAGE_SIZE, state.listedPage * LISTED_PAGE_SIZE);

  body.innerHTML = slice
    .map((row) => {
      const age = ageDays(row.lastSeenAt);
      const stage = row.staging ? STAGE_BADGES[row.staging] ?? { label: row.staging, cls: "bg-surface-2 text-ink-muted" } : null;

      /*
       * 状态列只回答一个问题：这个词现在要不要更新。
       * 有候选池状态就先说状态（更新中/待发布），否则按新鲜度说事。
       */
      const status = stage
        ? `<span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${stage.cls}">${esc(stage.label)}</span>`
        : age === null
          ? `<span class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">从未采集</span>`
          : age >= 60
            ? `<span class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">${age} 天未更新</span>`
            : age >= 30
              ? `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">${age} 天未更新</span>`
              : `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">${age} 天前</span>`;

      const pickable = listedPickable(row);
      const pick = `<input type="checkbox" data-listed-pick="${esc(row.slug)}" class="h-3.5 w-3.5 accent-primary" ${state.listedSelected.has(row.slug) ? "checked" : ""} ${pickable ? "" : "disabled"} />`;
      const score = (n: number) => (Number.isFinite(n) && n > 0 ? n.toFixed(1) : `<span class="text-ink-muted">—</span>`);

      return `<tr class="transition hover:bg-surface-2/50">
          <td class="px-3 py-2.5">${pick}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${
            row.variantOf ? `<span class="text-ink-muted" title="别名，名次继承 ${esc(row.variantOf)}">—</span>` : `#${row.rank}`
          }</td>
          <td class="max-w-[280px] px-4 py-2.5">
            <span class="block truncate font-medium text-ink">${esc(row.keyword)}</span>
            <div class="mt-0.5 truncate text-[11px] text-ink-muted">${esc(row.slug)}${
              row.variantOf ? ` · 别名 → ${esc(row.variantOf)}` : ""
            }</div>
          </td>
          <td class="px-4 py-2.5 text-xs text-ink-secondary">${esc(row.category ?? "—")}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${score(row.scores.trend)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${score(row.scores.opportunity)}</td>
          <td class="px-4 py-2.5 text-right text-xs font-medium tabular-nums text-ink">${score(row.scores.overall)}</td>
          <td class="px-4 py-2.5 text-xs tabular-nums text-ink-muted">${esc(fmtTime(row.lastSeenAt))}</td>
          <td class="px-4 py-2.5">${status}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-right">
            <a href="/preview/trend/${encodeURIComponent(row.slug)}" target="_blank" rel="noopener" class="text-xs text-primary hover:underline" title="在新窗口预览详情页">预览</a>
            <button type="button" data-listed-refresh="${esc(row.slug)}" class="ml-3 text-xs text-primary transition hover:underline ${pickable ? "" : "cursor-not-allowed opacity-40"}" ${pickable ? "" : "disabled"}>更新</button>
          </td>
        </tr>`;
    })
    .join("");

  const prev = state.listedPage <= 1;
  const next = state.listedPage >= pages;
  pager.innerHTML = `<span>共 ${rows.length} 条 · 第 ${state.listedPage} / ${pages} 页</span>
      <span class="flex gap-3">
        <button type="button" data-listed-page="${state.listedPage - 1}" class="${prev ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${prev ? "disabled" : ""}>上一页</button>
        <button type="button" data-listed-page="${state.listedPage + 1}" class="${next ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${next ? "disabled" : ""}>下一页</button>
      </span>`;

  syncListedBtn();
}

/** 勾选里剔掉已经不在列表或不可勾的词，按钮数字才不会骗人 */
function syncListedBtn(): void {
  const btn = $("trends-listed-refresh") as HTMLButtonElement | null;
  if (!btn) return;
  const rows = state.listed?.items ?? [];
  for (const slug of [...state.listedSelected]) {
    const row = rows.find((r) => r.slug === slug);
    if (!row || !listedPickable(row)) state.listedSelected.delete(slug);
  }
  const n = state.listedSelected.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `更新选中（${n}）` : "更新选中";
}

/**
 * 更新线上词：一次只派一批，等这一批跑完再派下一批。
 *
 * 和富化同一个原因——同 concurrency group 只保留一个排队任务，
 * 连发会让中间那批被顶掉，而且静默（不报错，日志里也不会出现）。
 */
async function runListedRefresh(slugs: string[]): Promise<void> {
  const btn = $("trends-listed-refresh") as HTMLButtonElement | null;
  const unique = [...new Set(slugs)];
  if (!unique.length) return;

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += REFRESH_BATCH) {
    batches.push(unique.slice(i, i + REFRESH_BATCH));
  }

  const ok = window.confirm(
    `将重采 ${unique.length} 个线上词${batches.length > 1 ? `（分 ${batches.length} 批，逐批串行跑）` : ""}。\n\n`
      + `每个词一次 Google Trends 曲线 + 一次 LLM 富化，约 40~60 秒。\n`
      + `结果只进候选池，需要到「发布预览」点一「更新榜单」才会上线。`,
  );
  if (!ok) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }
  let sent = 0;
  let done = 0;
  try {
    for (let i = 0; i < batches.length; i++) {
      if (btn) {
        btn.textContent = batches.length > 1 ? `更新中…（第 ${i + 1}/${batches.length} 批）` : "提交中…";
      }
      const resp = await apiPost<{ jobId?: string; count?: number }>("/trends/refresh", {
        slugs: batches[i],
      });
      sent += resp.count ?? batches[i].length;
      done = i + 1;
      for (const s of batches[i]) state.listedSelected.delete(s);
      void loadJobs();
      if (i < batches.length - 1 && resp.jobId) await waitJobDone(resp.jobId);
    }
    if (btn) btn.textContent = `已提交 ${sent} 个`;
    void loadJobs();
    window.setTimeout(() => {
      if (btn) btn.disabled = false;
      void loadListed();
      void loadStaging();
    }, 4000);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "更新选中";
    }
    syncListedBtn();
    const msg = e instanceof Error ? e.message : String(e);
    window.alert(
      sent > 0
        ? `已提交 ${sent} 个（前 ${done} 批），第 ${done + 1} 批有中断：${msg}`
        : `提交失败：${msg}`,
    );
  }
}

function renderJobs(jobs: Job[]): void {
  const box = $("trends-jobs");
  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。点上面的「拉取新词」会在这里显示进度。</p>`;
    return;
  }

  // 非终态即活跃：库里有 GitHub 的中间态（pending）时，只认 queued/running 会停止轮询
  schedulePolling(
    jobs.some((j) => j.status !== "success" && j.status !== "failure" && j.status !== "cancelled"),
  );

  box.innerHTML = jobs
    .map((job) => {
      const badge = statusBadge(job.status);
      const params = (() => {
        try {
          const p = JSON.parse(job.params) as Record<string, unknown>;
          if (job.kind === "fetch") return `${p.budget ?? "?"} 个 · ${p.geo ?? "US"}`;
          return `合并 ${p.incoming ?? "?"} 个候选词`;
        } catch {
          return job.kind === "fetch" ? "拉取" : "发布";
        }
      })();
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : "—";
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-14 shrink-0 text-ink-muted">${job.kind === "fetch" ? "拉取" : "发布"}</span>
          <span class="min-w-0 flex-1 truncate text-ink-secondary">${esc(params)}</span>
          <span class="shrink-0 rounded-full px-2 py-0.5 font-semibold ${badge.cls}">${badge.label}</span>
          <span class="w-24 shrink-0 text-right text-ink-muted">${fmtTime(job.created_at)}</span>
          <span class="w-10 shrink-0 text-right">${link}</span>
        </div>`;
    })
    .join("");
}

function visibleCandidates(data: StagingResp): CandidateView[] {
  const q = state.q.toLowerCase();
  return data.candidates.filter((c) => {
    if (q && !c.keyword.toLowerCase().includes(q)) return false;
    if (state.filter === "pending") return c.enrichStatus !== null && !c.rejected;
    if (state.filter === "ready") return c.enrichStatus === null && !c.rejected;
    if (state.filter === "blocked") return c.enrichStatus !== null && !c.enrichable && !c.rejected;
    if (state.filter === "new") return !c.inBoard && !c.rejected;
    if (state.filter === "board") return c.inBoard && !c.rejected;
    if (state.filter === "rejected") return c.rejected;
    return true;
  });
}

function renderStaging(data: StagingResp): void {
  state.staging = data;

  const meta = $("trends-staging-meta");
  if (data.empty) {
    meta.textContent = "候选池为空。拉取一次后，新词会先进到这里等你审核。";
  } else {
    const last = data.lastRun ? `｜上次采集 ${data.lastRun.ok}/${data.lastRun.total}（${data.lastRun.geo}）` : "";
    const s = data.stats;
    const counts = s
      ? `候选 ${data.candidates.length} · 可发布 ${s.ready} · 待富化 ${s.pending}${s.blocked ? ` · 数据不足 ${s.blocked}` : ""} · 已拒绝 ${data.candidates.filter((c) => c.rejected).length}`
      : `候选 ${data.candidates.length} · 已拒绝 ${data.candidates.filter((c) => c.rejected).length}`;
    const q = data.quality;
    // 体检只算已富化的词，没有可发布内容时整行不显示
    const health =
      q && q.audited > 0
        ? `<span class="mt-0.5 block">内容体检 ${q.dirty}/${q.audited} 个词有缺口（空 ${q.byLevel.empty} · 兜底 ${q.byLevel.fallback} · 可疑 ${q.byLevel.suspect}）${
            q.top[0] ? `｜最常见：${esc(q.top[0].label)} ×${q.top[0].count}` : ""
          }</span>`
        : "";
    meta.innerHTML = `${esc(counts)}${esc(last)}${health}`;
  }

  const rows = data.empty ? [] : visibleCandidates(data);
  const body = $("trends-staging-body");
  const pager = $("trends-staging-pager");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的候选词</td></tr>`;
    pager.innerHTML = "";
    syncEnrichBtn();
    return;
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const slice = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  body.innerHTML = slice
    .map((row) => {
      const status = row.rejected
        ? `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">已拒绝</span>`
        : row.enrichStatus === "failed"
          ? `<span class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">富化失败</span>`
          : row.enrichStatus && !row.enrichable
            ? `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted" title="序列只有 ${row.dataPoints} 个点，少于 14 个不足以判断">数据不足</span>`
            : row.enrichStatus
              ? `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">待富化</span>`
              : row.inBoard
                ? row.previous
                  ? `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary" title="内容已刷新，可对比并回滚上一版">已刷新</span>`
                  : `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">在榜刷新</span>`
                : `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">已富化</span>`;

      const pick = row.enrichable && !row.rejected
        ? `<input type="checkbox" data-trend-pick="${esc(row.slug)}" class="h-3.5 w-3.5 accent-primary" ${state.selected.has(row.slug) ? "checked" : ""} />`
        : "";
      const rank = row.estimatedRank
        ? row.rankBasis === "trend"
          ? `<span title="只按趋势分排，不含机会分，富化后可能变动">~#${row.estimatedRank}</span>`
          : `#${row.estimatedRank}`
        : "—";
      const opp = row.opportunity === null ? `<span class="text-ink-muted">—</span>` : row.opportunity.toFixed(1);
      const all = row.overall === null ? `<span class="text-ink-muted">—</span>` : row.overall.toFixed(1);

      /*
       * 体检列：和工具榜同一套口径（empty 没值 / fallback 模板句 / suspect 太短）。
       * 未富化的词不跑体检（占位字段必然空），显示「—」而不是「干净」，
       * 否则会把「还没做」误读成「做得好」。
       */
      const issues = row.issues ?? [];
      const gapCell = row.enrichStatus
        ? `<span class="text-xs text-ink-muted" title="富化后才有体检结果">—</span>`
        : issues.length > 0
          ? `<span class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger" title="${esc(
              issues
                .slice(0, 4)
                .map((i) => `[${i.level}] ${i.block}：${i.detail}`)
                .join("\n"),
            )}">${issues.length} 处</span>`
          : `<span class="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success" title="各区块都有实值，没有模板兜底">干净</span>`;

      return `<tr class="transition hover:bg-surface-2/50">
          <td class="px-3 py-2.5">${pick}</td>
          <td class="max-w-[260px] px-4 py-2.5">
            <button type="button" data-trend-open="${esc(row.slug)}" class="block max-w-full truncate text-left font-medium text-ink hover:text-primary">${esc(row.keyword)}</button>
            <div class="mt-0.5 truncate text-[11px] text-ink-muted">${esc(row.slug)} · ${row.dataPoints} 个点${
              row.issues?.length ? ` · <span class="text-danger">${row.issues.length} 处待补</span>` : ""
            }</div>
          </td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${row.trend.toFixed(1)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${opp}</td>
          <td class="px-4 py-2.5 text-right text-xs font-medium tabular-nums text-ink">${all}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-muted">${fmtNum(row.peak)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${rank}</td>
          <td class="px-4 py-2.5">${gapCell}</td>
          <td class="px-4 py-2.5">${status}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-right">
            <button type="button" data-trend-open="${esc(row.slug)}" class="text-xs text-primary hover:underline">详情</button>
            <a href="/preview/trend/${encodeURIComponent(row.slug)}" target="_blank" rel="noopener" class="ml-3 text-xs text-primary hover:underline" title="在新窗口预览详情页（与线上同一套布局，需管理员登录）">预览</a>
            <button type="button" data-trend-reject="${esc(row.slug)}" data-trend-rejected="${row.rejected}" class="ml-3 text-xs text-ink-muted transition hover:text-danger">${row.rejected ? "恢复" : "拒绝"}</button>
          </td>
        </tr>`;
    })
    .join("");

  const prev = state.page <= 1;
  const next = state.page >= pages;
  pager.innerHTML = `<span>共 ${rows.length} 个 · 第 ${state.page} / ${pages} 页</span>
      <span class="flex gap-3">
        <button type="button" data-trend-page="${state.page - 1}" class="${prev ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${prev ? "disabled" : ""}>上一页</button>
        <button type="button" data-trend-page="${state.page + 1}" class="${next ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${next ? "disabled" : ""}>下一页</button>
      </span>`;

  syncEnrichBtn();
}

/** 富化按钮的可用性只看「勾选里还剩几个真能富化的」——轮询刷新后可能已被别的标签页富化 */
function syncEnrichBtn(): void {
  const btn = $("trends-enrich-btn") as HTMLButtonElement | null;
  if (!btn) return;
  const list = state.staging?.candidates ?? [];
  // 已富化/已拒绝/数据不足的从选择里剔除，避免按钮显示的数量骗人
  for (const slug of [...state.selected]) {
    const row = list.find((c) => c.slug === slug);
    if (!row || !row.enrichable || row.rejected) state.selected.delete(slug);
  }
  const n = state.selected.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 ? `富化选中（${n}）` : "富化选中";
}

/** 发布预览里「谁的位置变了」——这块是本页的核心 */
function renderPreview(data: PreviewResp): void {
  const p = data.preview;
  const btn = $("trends-publish-btn") as HTMLButtonElement;
  const summary = $("trends-publish-summary");
  const box = $("trends-publish-changes");

  if (!p) {
    summary.textContent = "候选池为空，先拉取新词。";
    box.innerHTML = `<p class="text-xs text-ink-muted">—</p>`;
    btn.disabled = true;
    return;
  }

  const untouched = p.incoming + p.exited === 0;
  summary.textContent = untouched
    ? "没有待发布的候选词"
    : `合并 ${p.incoming} 个候选词（其中 ${p.inBoardRefresh} 个是在榜刷新）；榜单 ${p.boardBefore} → ${p.boardAfter} / ${p.boardLimit} 条`;
  btn.disabled = untouched;

  // 发布后候选池会被清空，所以「上次动了谁」靠 staging 里的摘要回放
  const last = p.lastPublish;
  const lastBlock = !last
    ? ""
    : (() => {
        const rows = (last.top ?? [])
          .slice(0, 20)
          .map(
            (c) => `<div class="flex items-center gap-2 border-b border-border px-1 py-1 text-xs last:border-b-0">
                <span class="min-w-0 flex-1 truncate text-ink-secondary">${esc(c.keyword)}</span>
                <span class="shrink-0 tabular-nums text-ink-muted">${c.from ? `#${c.from}` : "新进"} → ${c.to ? `#${c.to}` : "出榜"}</span>
                <span class="w-10 shrink-0 text-right tabular-nums ${c.delta > 0 ? "text-accent" : c.delta < 0 ? "text-danger" : "text-ink-muted"}">${c.delta > 0 ? "+" : ""}${c.delta}</span>
              </div>`,
          )
          .join("");
        return `<details class="mt-4 rounded-lg border border-border px-3 py-2">
            <summary class="cursor-pointer text-xs text-ink-secondary">上次发布 ${fmtTime(last.at)}：进 ${last.incoming} · 显著 ${last.significant} · 顺延 ${last.shifted}${last.removed ? ` · 下架 ${last.removed}` : ""}</summary>
            ${rows || `<p class="mt-2 text-[11px] text-ink-muted">上次发布没有显著位次变化。</p>`}
            <p class="mt-2 text-[11px] text-ink-muted">这里只回放前 20 条，完整清单见那次发布的 GitHub 日志。</p>
          </details>`;
      })();

  if (untouched) {
    box.innerHTML = `<p class="text-xs text-ink-muted">候选池已经清空，线上榜单没有待合并的内容。</p>${lastBlock}`;
    return;
  }

  const counts = `<div class="mb-3 flex flex-wrap gap-2 text-[11px]">
      <span class="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">新进榜 ${p.entered}</span>
      <span class="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">上升 ${p.up}</span>
      <span class="rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger">下降 ${p.down}</span>
      <span class="rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger">出榜 ${p.exited}</span>
      <span class="rounded-full bg-surface-2 px-2 py-0.5 text-ink-muted">仅顺延 ${p.shifted}</span>
      ${
        p.trimmed
          ? `<span class="rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger">超上限淘汰 ${p.trimmed}</span>`
          : ""
      }
    </div>`;

  // 排在前面的词位次变化最要紧，按「原/新名次里更靠前的那个」升序
  const named = [...p.named].sort(
    (a, b) => Math.min(a.from ?? 1e9, a.to ?? 1e9) - Math.min(b.from ?? 1e9, b.to ?? 1e9),
  );

  if (!named.length) {
    box.innerHTML = `${counts}<p class="text-xs text-ink-muted">本次没有显著位次变化：新词都排在末尾，也没有词出榜。</p>${lastBlock}`;
    return;
  }

  const list = named
    .slice(0, 60)
    .map(
      (c) => `<div class="flex flex-wrap items-center gap-2 border-b border-border px-1 py-1.5 text-xs last:border-b-0">
          ${changeBadge(c)}
          <span class="min-w-0 flex-1 truncate text-ink">${esc(c.keyword)}</span>
          <span class="shrink-0 tabular-nums text-ink-muted">${c.from ? `#${c.from}` : "—"} → ${c.to ? `#${c.to}` : "—"}</span>
          <span class="w-10 shrink-0 text-right tabular-nums ${c.delta > 0 ? "text-accent" : c.delta < 0 ? "text-danger" : "text-ink-muted"}">${c.delta > 0 ? "+" : ""}${c.delta}</span>
        </div>`,
    )
    .join("");

  const more =
    named.length > 60
      ? `<p class="mt-2 text-[11px] text-ink-muted">还有 ${named.length - 60} 条显著变动，完整清单见发布日志。</p>`
      : "";

  box.innerHTML = `${counts}
      <div class="max-h-80 overflow-y-auto rounded-lg border border-border px-2">
        <div class="sticky top-0 flex items-center gap-2 bg-surface py-1.5 text-[11px] text-ink-muted">
          <span class="w-14 shrink-0">类型</span>
          <span class="min-w-0 flex-1">关键词</span>
          <span class="shrink-0">原名次 → 新名次</span>
          <span class="w-10 shrink-0 text-right">变化</span>
        </div>
        ${list}
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-ink-muted">
        只列「涉及前 50 名」或「变动 ≥ 3 名」的 ${p.significant} 条；另有 ${p.shifted} 条名次变化
        由新词插入顺延导致（通常只挪 1–2 名），不逐条列出。
      </p>
      ${more}
      ${lastBlock}`;
}

/* --------------------------------- 加载 --------------------------------- */

async function loadOverview(): Promise<void> {
  try {
    renderOverview(await apiGet<Overview>("/trends/overview"));
  } catch (e) {
    $("trends-setup").classList.remove("hidden");
    $("trends-setup-missing").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 单次富化的词数上限，与后端 admin-trends.ts 的 60 保持一致 */
const ENRICH_BATCH = 60;

/** 任务终态；refreshJob 从 GitHub 拿回来只会是这三种之一，另加 skipped 兜底 */
const JOB_TERMINAL = new Set(["success", "failure", "cancelled", "skipped"]);

/**
 * 等某个任务跑到终态。
 *
 * 只在「还有下一批」时调用：同一 concurrency group 里 GitHub 只留一个排队任务，
 * 连发会互相顶掉。轮询 jobs 接口即可（服务端 listJobs 每次都去 GitHub 现查状态）。
 * 超时后抛错，让用户知道其余批次没派出去，而不是按钮转圈到底。
 */
async function waitJobDone(id: string): Promise<void> {
  if (!id) return;
  // 60 词约 30 分钟，留到 45 分钟；再久说明 workflow 卡了，不该继续堵着用户
  const deadline = Date.now() + 45 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => window.setTimeout(r, 15_000));
    const data = await apiGet<{ jobs: Job[] }>("/trends/jobs?limit=8").catch(() => null);
    if (!data) continue;
    renderJobs(data.jobs ?? []);
    const job = (data.jobs ?? []).find((j) => j.id === id);
    if (!job) return; // 记录被挤出前 8 条，无从判断，别无限等
    if (!JOB_TERMINAL.has(job.status)) continue;
    void loadStaging();
    void loadListed();
    if (job.status !== "success") {
      throw new Error(`上一批执行${job.status === "cancelled" ? "被取消" : "失败"}，剩余批次未派发`);
    }
    return;
  }
  throw new Error("等待上一批超时（45 分钟），剩余批次未派发");
}

async function loadJobs(): Promise<void> {
  try {
    const data = await apiGet<{ jobs: Job[] }>("/trends/jobs?limit=8");
    renderJobs(data.jobs ?? []);
  } catch {
    /* 任务列表失败不阻塞其它区域 */
  }
}

async function loadStaging(): Promise<void> {
  try {
    renderStaging(await apiGet<StagingResp>("/trends/staging"));
  } catch (e) {
    $("trends-staging-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadListed(): Promise<void> {
  try {
    renderListed(await apiGet<ListedResp>("/trends/listed"));
  } catch (e) {
    $("trends-listed-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadPreview(): Promise<void> {
  try {
    const data = await apiGet<PreviewResp>("/trends/publish/preview");
    state.preview = data.preview;
    renderPreview(data);
  } catch {
    $("trends-publish-summary").textContent = "发布预览读取失败";
    $("trends-publish-btn").setAttribute("disabled", "true");
  }
}

function reloadAll(): void {
  void loadOverview();
  void loadJobs();
  void loadStaging();
  void loadListed();
  void loadPreview();
}

/** 有任务在跑就每 12 秒刷一次，跑完自动停 */
function schedulePolling(shouldRun: boolean): void {
  if (shouldRun && !state.polling) {
    state.polling = window.setInterval(reloadAll, 12_000);
  } else if (!shouldRun && state.polling) {
    window.clearInterval(state.polling);
    state.polling = undefined;
  }
}

/* -------------------------------- 详情抽屉 -------------------------------- */

function field(label: string, value: string): string {
  return `<div class="flex gap-3 border-b border-border py-2 last:border-b-0">
      <dt class="w-20 shrink-0 text-xs text-ink-muted">${esc(label)}</dt>
      <dd class="min-w-0 flex-1 break-words text-xs text-ink-secondary">${value}</dd>
    </div>`;
}

async function openDetail(slug: string): Promise<void> {
  const boxEl = $("trends-detail");
  state.detailSlug = slug;
  boxEl.classList.remove("hidden");
  boxEl.classList.add("flex");
  $("trends-detail-keyword").textContent = "加载中…";
  $("trends-detail-slug").textContent = slug;
  $("trends-detail-body").innerHTML = `<p class="text-xs text-ink-muted">正在读取…</p>`;

  try {
    const data = await apiGet<DetailResp>(`/trends/staging/${encodeURIComponent(slug)}`);
    const t = data.item;
    const v = data.view;
    state.detailRejected = Boolean(v?.rejected);

    $("trends-detail-keyword").textContent = t.keyword;
    $("trends-detail-slug").textContent = [t.normalizedName, t.category, t.region, t.variantOf ? `别名 → ${t.variantOf}` : ""]
      .filter(Boolean)
      .join(" · ");

    const values = t.series?.values ?? [];
    const rows = [
      field("状态", `${esc(t.status ?? "—")}${t.confidence ? ` · 置信 ${esc(t.confidence)}` : ""}`),
      field(
        "分数",
        `趋势 ${v ? v.trend.toFixed(1) : "—"} · 机会 ${v?.opportunity != null ? v.opportunity.toFixed(1) : "未富化"} · 综合 ${v?.overall != null ? v.overall.toFixed(1) : "未富化"}`,
      ),
      field(
        "名次",
        v?.estimatedRank
          ? v.rankBasis === "trend"
            ? `~#${v.estimatedRank}（仅按趋势分，富化后会变）`
            : `#${v.estimatedRank}`
          : v?.rejected
            ? "（已拒绝）"
            : "—",
      ),
      field("峰值 / 当前", `${fmtNum(v?.peak ?? 0)} / ${fmtNum(v?.lastValue ?? 0)}`),
      field(
        "7 日增长",
        typeof v?.growth7 === "number" ? `${v.growth7 > 0 ? "+" : ""}${v.growth7.toFixed(1)}%` : "—",
      ),
      field("首次发现", fmtTime(t.firstSeenAt)),
      field("最近采集", fmtTime(t.lastSeenAt)),
      field("数据点", `${values.length} 个${values.length >= 14 ? "（够排位）" : "（不足 14，不参与排名）"}`),
      field("结论", esc(t.why ?? "—")),
      field("需求侧", esc(t.intentSummary ?? "—")),
    ];

    const issues = v?.issues ?? [];
    const health = issues.length
      ? `<h4 class="mb-1 mt-4 text-xs font-semibold text-ink">内容体检 <span class="font-normal text-danger">${issues.length} 处</span></h4>
         <ul class="space-y-1.5">${issues
           .map((i) => {
             const tag = i.level === "empty" ? "缺失" : i.level === "fallback" ? "兜底" : "可疑";
             const cls =
               i.level === "empty" ? "text-danger" : i.level === "fallback" ? "text-accent" : "text-ink-muted";
             return `<li class="text-xs text-ink-secondary"><span class="${cls}">[${tag}]</span> ${esc(i.block)} · ${esc(i.fields.join(" / "))}：${esc(i.detail)}</li>`;
           })
           .join("")}</ul>`
      : "";

    // 刷新过的词留了旧内容快照：先看新旧差异，再决定是否回滚
    const prev = t.previousSnapshot;
    const prevBox = prev
      ? `<h4 class="mb-1 mt-4 flex items-center gap-2 text-xs font-semibold text-ink">
           上一版内容 <span class="font-normal text-ink-muted">${esc(fmtTime(prev.at))}</span>
           <button type="button" data-trend-revert="${esc(t.slug)}" class="ml-auto rounded-md border border-border px-2 py-0.5 text-[11px] font-medium text-ink-secondary transition hover:border-danger hover:text-danger">回滚到上一版</button>
         </h4>
         <dl>
           ${field("旧结论", esc(prev.why ?? "—"))}
           ${field("旧条目", `机会 ${prev.opportunities?.length ?? 0} · 行动 ${prev.actions?.length ?? 0} · 相关查询 ${prev.relatedQueries?.length ?? 0}`)}
           ${field("当前条目", `机会 ${t.opportunities?.length ?? 0} · 行动 ${t.actions?.length ?? 0} · 相关查询 ${t.relatedQueries?.length ?? 0}`)}
         </dl>
         <p class="mt-1 text-[11px] text-ink-muted">回滚只覆盖内容字段，曲线与趋势分仍用这一轮的新数据。</p>`
      : "";

    const note = t.editorNote
      ? `<h4 class="mb-1 mt-4 text-xs font-semibold text-ink">收录判定</h4>
         <dl>${field("谁付钱", esc(t.editorNote.audience))}${field("切入口", esc(t.editorNote.entryAngle))}${field("收录理由", esc(t.editorNote.whyAccepted))}</dl>`
      : "";

    const evidence = t.evidence?.length
      ? `<h4 class="mb-1 mt-4 text-xs font-semibold text-ink">证据</h4>
         <ul class="space-y-1.5">${t.evidence
           .slice(0, 8)
           .map(
             (e) =>
               `<li class="text-xs text-ink-secondary">· ${esc(e.claim)}${
                 e.date ? `<span class="ml-1 text-[11px] text-ink-muted">${esc(e.date)}</span>` : ""
               }</li>`,
           )
           .join("")}</ul>`
      : "";

    const lists = [
      t.relatedQueries?.length ? field("相关查询", t.relatedQueries.map((x) => esc(x)).join(" · ")) : "",
      t.competitors?.length ? field("竞品", t.competitors.map((x) => esc(x)).join(" · ")) : "",
      t.sources?.length
        ? field(
            "数据源",
            t.sources
              .slice(0, 6)
              .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener" class="text-primary hover:underline">${esc(s.label)}</a>`)
              .join(" · "),
          )
        : "",
    ].filter(Boolean);

    $("trends-detail-body").innerHTML = `<dl>${rows.join("")}</dl>
        ${health}
        ${prevBox}
        <h4 class="mb-1 mt-4 text-xs font-semibold text-ink">兴趣序列</h4>
        ${sparkline(values)}
        <div class="mt-3 grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold text-ink">趋势强度</div>
            ${partBars(t.trendParts, TREND_LABELS)}
          </div>
          <div class="space-y-1.5">
            <div class="text-[11px] font-semibold text-ink">机会潜力</div>
            ${partBars(t.oppParts, OPP_LABELS)}
          </div>
        </div>
        ${note}
        ${evidence}
        ${lists.length ? `<dl class="mt-3">${lists.join("")}</dl>` : ""}
        <details class="mt-4">
          <summary class="cursor-pointer text-xs text-ink-muted">原始 JSON</summary>
          <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-secondary">${esc(JSON.stringify(t, null, 2))}</pre>
        </details>`;

    ($("trends-detail-reject") as HTMLButtonElement).textContent = v?.rejected ? "恢复这个词" : "拒绝这个词";
  } catch (e) {
    $("trends-detail-body").innerHTML = `<p class="text-xs text-danger">读取失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function closeDetail(): void {
  const boxEl = $("trends-detail");
  boxEl.classList.add("hidden");
  boxEl.classList.remove("flex");
  state.detailSlug = "";
}

/* -------------------------------- 事件绑定 -------------------------------- */

async function rejectSlug(slug: string, reject: boolean): Promise<void> {
  await apiPost(`/trends/staging/${encodeURIComponent(slug)}/reject`, { rejected: reject });
}

/** 发布确认框里把最要紧的几条位次变化念出来，避免「点完才发现榜单被挤乱」 */
function confirmPublish(): boolean {
  const p = state.preview;
  if (!p) return false;

  const named = [...p.named].sort(
    (a, b) => Math.min(a.from ?? 1e9, a.to ?? 1e9) - Math.min(b.from ?? 1e9, b.to ?? 1e9),
  );
  const head = named
    .slice(0, 5)
    .map((c) => `· ${c.keyword}：${c.from ? `#${c.from}` : "新进"} → ${c.to ? `#${c.to}` : "出榜"}`)
    .join("\n");

  const lines = [
    `确认合并 ${p.incoming} 个候选词？`,
    `榜单 ${p.boardBefore} → ${p.boardAfter} / ${p.boardLimit} 条。`,
    p.significant ? `\n显著位次变动 ${p.significant} 条：\n${head}${named.length > 5 ? `\n· 其余 ${named.length - 5} 条见页面清单` : ""}` : "\n本次没有显著位次变化。",
    `另有 ${p.shifted} 条名次仅因插入顺延。`,
    p.trimmed ? `\n榜单已达上限，将淘汰尾部 ${p.trimmed} 个词（含随代表词下架的别名）。` : "",
    "\n发布会自动触发一次站点构建。",
  ];
  return window.confirm(lines.join("\n"));
}

function bind(): void {
  const budget = $("trends-fetch-budget") as HTMLSelectElement;
  const geo = $("trends-fetch-geo") as HTMLSelectElement;
  const hint = $("trends-fetch-hint");

  const updateHint = (): void => {
    const n = Number(budget.value) || 80;
    const minutes = Math.max(1, Math.round((n * 9) / 60));
    hint.textContent = `约 ${n} 个词，单个 5–13 秒，预计 ${minutes} 分钟｜结果只进候选池`;
  };
  budget.addEventListener("change", updateHint);
  updateHint();

  $("trends-fetch-btn").addEventListener("click", async () => {
    const btn = $("trends-fetch-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/trends/fetch", { budget: Number(budget.value), geo: geo.value });
      btn.textContent = "已提交";
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "拉取新词";
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "拉取新词";
      window.alert(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("trends-staging-refresh").addEventListener("click", reloadAll);

  $("trends-enrich-btn").addEventListener("click", async () => {
    const btn = $("trends-enrich-btn") as HTMLButtonElement;
    const slugs = [...state.selected];
    if (slugs.length === 0) return;
    /*
     * 单批 60：后端上限也是 60，且富化 workflow 超时 40 分钟
     * （60 词 × 每词一次 LLM ≈ 30 分钟），再大会被腰斩。
     */
    const batches: string[][] = [];
    for (let i = 0; i < slugs.length; i += ENRICH_BATCH) {
      batches.push(slugs.slice(i, i + ENRICH_BATCH));
    }
    const ok = window.confirm(
      `将富化 ${slugs.length} 个词${batches.length > 1 ? `（分 ${batches.length} 批，逐批串行跑）` : ""}。\n\n`
        + `每词一次 LLM 调用；缺相关查询的词会补一次 Trends 请求。\n`
        + `富化只写候选池，线上榜单不受影响。`,
    );
    if (!ok) return;
    btn.disabled = true;
    let sent = 0;
    let done = 0;
    try {
      for (let i = 0; i < batches.length; i++) {
        btn.textContent =
          batches.length > 1 ? `富化中…（第 ${i + 1}/${batches.length} 批）` : "提交中…";
        const resp = await apiPost<{ jobId?: string; count?: number }>("/trends/enrich", {
          slugs: batches[i],
        });
        sent += resp.count ?? batches[i].length;
        done = i + 1;
        for (const s of batches[i]) state.selected.delete(s);
        void loadJobs();
        /*
         * 四条流水线共用 concurrency group = trends-staging，而 GitHub 对同一 group
         * 只保留**一个**排队任务：连着派三批，第 2 批的 pending 会被第 3 批顶掉，
         * 那批词就永远不会跑（还不报错）。所以除最后一批外，必须等这一批真正结束。
         */
        if (i < batches.length - 1 && resp.jobId) await waitJobDone(resp.jobId);
      }
      state.selected.clear();
      btn.textContent = `已提交 ${sent} 个`;
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        void loadStaging();
        syncEnrichBtn();
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "富化选中";
      const msg = e instanceof Error ? e.message : String(e);
      // 409 = 这批还在富化中，不是失败；把已派发的部分说清楚
      window.alert(
        sent > 0
          ? `已提交 ${sent} 个（前 ${done} 批），第 ${done + 1} 批有中断：${msg}`
          : `提交失败：${msg}`,
      );
      syncEnrichBtn();
    }
  });

  /*
   * 全选作用于**全部**筛选后的候选（跨页），跳过数据不足/已拒绝的。
   * 只选当前页的话，候选 200 个要翻 7 次页点 7 次，日常操作基本不可用；
   * 跨页勾选后由提交按钮按 60/批 串行派发。
   */
  ($("trends-select-all") as HTMLInputElement).addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    if (!state.staging) return;
    for (const row of visibleCandidates(state.staging)) {
      if (!row.enrichable || row.rejected) continue;
      if (on) state.selected.add(row.slug);
      else state.selected.delete(row.slug);
    }
    renderStaging(state.staging);
  });

  ($("trends-staging-filter") as HTMLSelectElement).addEventListener("change", (event) => {
    state.filter = (event.target as HTMLSelectElement).value;
    state.page = 1;
    if (state.staging) renderStaging(state.staging);
  });

  $("trends-staging-search").addEventListener(
    "input",
    debounce(() => {
      state.q = ($("trends-staging-search") as HTMLInputElement).value.trim();
      state.page = 1;
      if (state.staging) renderStaging(state.staging);
    }),
  );

  // 表格内容是动态渲染的，统一用事件委托
  $("trends-staging-body").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const open = target.closest<HTMLElement>("[data-trend-open]");
    if (open?.dataset.trendOpen) {
      void openDetail(open.dataset.trendOpen);
      return;
    }

    const reject = target.closest<HTMLElement>("[data-trend-reject]");
    if (reject?.dataset.trendReject) {
      const slug = reject.dataset.trendReject;
      void rejectSlug(slug, reject.dataset.trendRejected !== "true")
        .then(reloadAll)
        .catch((e) => window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`));
    }
  });

  $("trends-staging-body").addEventListener("change", (event) => {
    const box = (event.target as HTMLElement).closest<HTMLInputElement>("[data-trend-pick]");
    const slug = box?.dataset.trendPick;
    if (!slug) return;
    if (box!.checked) state.selected.add(slug);
    else state.selected.delete(slug);
    syncEnrichBtn();
  });

  $("trends-staging-pager").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-trend-page]");
    const page = Number(btn?.dataset.trendPage);
    if (!page || page === state.page) return;
    state.page = page;
    if (state.staging) renderStaging(state.staging);
  });

  /* --------------------------- 线上榜单的交互 --------------------------- */

  /*
   * 全选作用于筛选后的全部线上词（跨页），跳过正在跑/正在发布的。
   * 与候选池同一套理由：367 条里挑几十个，靠翻 13 页勾不现实。
   */
  ($("trends-listed-select-all") as HTMLInputElement).addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    if (!state.listed) return;
    for (const row of visibleListed(state.listed)) {
      if (!listedPickable(row)) continue;
      if (on) state.listedSelected.add(row.slug);
      else state.listedSelected.delete(row.slug);
    }
    renderListed(state.listed);
  });

  ($("trends-listed-filter") as HTMLSelectElement).addEventListener("change", (event) => {
    state.listedFilter = (event.target as HTMLSelectElement).value;
    state.listedPage = 1;
    if (state.listed) renderListed(state.listed);
  });

  $("trends-listed-search").addEventListener(
    "input",
    debounce(() => {
      state.listedQ = ($("trends-listed-search") as HTMLInputElement).value.trim();
      state.listedPage = 1;
      if (state.listed) renderListed(state.listed);
    }),
  );

  $("trends-listed-body").addEventListener("change", (event) => {
    const box = (event.target as HTMLElement).closest<HTMLInputElement>("[data-listed-pick]");
    const slug = box?.dataset.listedPick;
    if (!slug) return;
    if (box!.checked) state.listedSelected.add(slug);
    else state.listedSelected.delete(slug);
    syncListedBtn();
  });

  $("trends-listed-body").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-listed-refresh]");
    const slug = btn?.dataset.listedRefresh;
    if (!slug || btn?.disabled) return;
    void runListedRefresh([slug]);
  });

  $("trends-listed-pager").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-listed-page]");
    const page = Number(btn?.dataset.listedPage);
    if (!page || page === state.listedPage) return;
    state.listedPage = page;
    if (state.listed) renderListed(state.listed);
  });

  $("trends-listed-refresh").addEventListener("click", () => {
    void runListedRefresh([...state.listedSelected]);
  });

  $("trends-publish-btn").addEventListener("click", async () => {
    if (!confirmPublish()) return;
    const btn = $("trends-publish-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/trends/publish", {});
      btn.textContent = "已提交";
      void loadJobs();
      window.setTimeout(() => {
        btn.textContent = "更新榜单";
        void loadPreview();
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "更新榜单";
      window.alert(`发布失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("trends-detail-close").addEventListener("click", closeDetail);
  $("trends-detail").addEventListener("click", (event) => {
    if (event.target === $("trends-detail")) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detailSlug) closeDetail();
  });

  // 回滚按钮在抽屉里动态渲染，用事件委托接住
  $("trends-detail-body").addEventListener("click", async (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      "[data-trend-revert]",
    );
    if (!btn || btn.disabled) return;
    const slug = btn.dataset.trendRevert;
    if (!slug) return;

    const label = $("trends-detail-keyword").textContent ?? slug;
    if (
      !window.confirm(
        `把「${label}」回滚到上一版内容？\n\n只覆盖内容字段，曲线与趋势分保持不变。`,
      )
    ) {
      return;
    }

    btn.disabled = true;
    btn.textContent = "回滚中…";
    try {
      await apiPost("/trends/revert", { slugs: [slug] });
      closeDetail();
      reloadAll();
    } catch (e) {
      window.alert(`回滚失败：${e instanceof Error ? e.message : String(e)}`);
      btn.disabled = false;
      btn.textContent = "回滚到上一版";
    }
  });

  $("trends-detail-reject").addEventListener("click", async () => {
    const slug = state.detailSlug;
    if (!slug) return;
    const btn = $("trends-detail-reject") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await rejectSlug(slug, !state.detailRejected);
      closeDetail();
      reloadAll();
    } catch (e) {
      window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/* --------------------------------- 入口 --------------------------------- */

/** 首次切到页签时挂载；重复调用只刷新数据 */
export function mountAdminTrends(): void {
  if (state.mounted) {
    reloadAll();
    return;
  }

  state.mounted = true;
  bind();
  reloadAll();
}