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

import {
  $,
  apiGet,
  apiPost,
  debounce,
  esc,
  fillVersionSelect,
  fmtNum,
  fmtStamp,
  fmtTime,
  pickedDataAt,
  versionNote,
  type VersionOption,
} from "./admin-shared";

/* --------------------------------- 类型 --------------------------------- */

interface Job {
  id: string;
  /** fetch 拉取 / refresh 更新选中 / enrich 富化 / publish 发布 / revert 回滚 */
  kind: "fetch" | "refresh" | "enrich" | "publish" | "revert";
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
  /** 候选池是否带可用的榜单基线；false 时「新进榜/掉名次」都不可信 */
  baseline?: boolean;
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
  /** 候选池是否带可用的榜单基线；false 时位次变化不可信 */
  baseline?: boolean;
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
  /** 记录被重写的时刻（带时分秒），列表的「更新时间」显示它 */
  updatedAt: string | null;
  /** 候选池里的状态（candidate/enriched/enriching/…），null 表示不在队列里 */
  staging: string | null;
  scores: { trend: number; opportunity: number; overall: number };
}

interface ListedResp {
  version: string;
  /** 当前生效版本：版本下拉默认停在这 */
  current?: string | null;
  /** 库里还留着的版本（倒序）+ 每版条数 */
  versions?: VersionOption[];
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

/** 线上榜单的每页条数：一屏能扫完，勾选粒度也正好落在「本页」这个量级 */
const LISTED_PAGE_SIZE = 20;

const state = {
  /** 当前子页签：数据抓取 / 线上榜单。线上榜单是全量算分，只在真要看时才拉 */
  view: "fetch" as "fetch" | "listed",
  filter: "all",
  q: "",
  page: 1,
  /** 线上榜单：数据、筛选与勾选（和候选池的选择分开，互不干扰） */
  listed: null as ListedResp | null,
  listedQ: "",
  /** all / stale(≥30 天) / old(≥60 天) / queued(已在候选池) */
  listedFilter: "all",
  /** 看哪一版快照（空 = 当前生效版本），用户在版本下拉里选 */
  listedVersion: "",
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
    for (const t of PUBLISH_TARGETS) $(t.btn).setAttribute("disabled", "true");
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
  // 基线缺失时这个数字来自正式榜统计，不是候选池的计分快照，别混着说
  const boardNote = s.baseline === false ? "正式榜统计" : "计分快照";
  $("trend-kpi-board-sub").textContent = s.boardUpdatedAt
    ? `${boardNote} ${fmtTime(s.boardUpdatedAt)}${limitNote}`
    : s.baseline === false
      ? `正式榜实时计数${limitNote}`
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

  /*
   * 没有榜单基线时，「新进榜 20」其实是「基线为空，所以全都算新进」——
   * 这种数字比不给更糟，直接降级成「—」并说明原因。
   */
  if (s.baseline === false) {
    $("trend-kpi-changes").textContent = "—";
    $("trend-kpi-changes-sub").textContent = "候选池缺少榜单基线，位次变化不可信；重新采集一次即可恢复";
  } else {
    $("trend-kpi-changes").textContent = fmtNum(s.significant);
    $("trend-kpi-changes-sub").textContent = s.lastPublish
      ? `上次发布 ${fmtTime(s.lastPublish.at)}：进 ${s.lastPublish.incoming} · 显著 ${s.lastPublish.significant} · 顺延 ${s.lastPublish.shifted}`
      : `新进榜 ${fmtNum(s.entered)}，其余按顺延处理`;
  }
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
    // 从未采集的按「很久没更新」算，落在所有未更新档里
    const age = ageDays(row.lastSeenAt) ?? 999;
    if (state.listedFilter === "d7") return age >= 7;
    if (state.listedFilter === "d10") return age >= 10;
    if (state.listedFilter === "d30") return age >= 30;
    if (state.listedFilter === "queued") return row.staging !== null;
    return true;
  });
}

/**
 * 分页切片（两个列表共用）。
 *
 * 「本页全选」必须和表格显示的是同一页，分页算法只留一份；
 * 越界页统一夹到最后一页，避免筛选后页码悬空。
 */
function pageSlice<T>(rows: T[], page: number, size: number): { slice: T[]; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  return { slice: rows.slice((current - 1) * size, current * size), pages };
}

/**
 * 表头勾选框反映「当前页」：整页都可勾且已勾 = 勾上；只勾了一部分 = 半选。
 * 跨页全选之后翻到别的页，也能一眼看出这一页选没选。
 */
function syncHeadCheck<T>(
  id: string,
  rows: T[],
  canPick: (row: T) => boolean,
  picked: (row: T) => boolean,
): void {
  const el = $(id) as HTMLInputElement | null;
  if (!el) return;
  const usable = rows.filter(canPick);
  const on = usable.filter(picked).length;
  el.checked = usable.length > 0 && on === usable.length;
  el.indeterminate = on > 0 && on < usable.length;
}

/**
 * 「全选」按钮：作用域是筛选后的全部结果（跨页）。
 *
 * 数量只写在 title 里——「全选（487）」会把工具条挤换行；
 * 想知道会选中多少，看右侧「更新选中（N）」的计数更直接。
 */
function syncAllPickBtn(id: string, allOn: boolean, total: number): void {
  const btn = $(id) as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = allOn && total > 0 ? "取消全选" : "全选";
  btn.title =
    total === 0
      ? "当前筛选结果里没有可勾选的词"
      : `全选当前筛选结果（跨页，共 ${total} 条）；再点一次取消`;
  btn.disabled = total === 0;
}

/** 表头「本页」按钮：只动当前这一页，整页勾满后变成「取消本页」 */
function syncPagePickBtn(id: string, allOn: boolean, total: number): void {
  const btn = $(id) as HTMLButtonElement | null;
  if (!btn) return;
  btn.textContent = allOn && total > 0 ? "取消本页" : "本页";
  btn.title = total === 0 ? "本页没有可勾选的词" : `勾选本页 ${total} 个；再点一次取消`;
  btn.disabled = total === 0;
}

/**
 * 单行勾选后只同步表头控件，不重渲染整张表（否则滚动位置会跳）。
 * 勾选框和「本页」看当前页，「全选」看筛选后的全部结果。
 */
function refreshListedPickHead(): void {
  if (!state.listed) return;
  const visible = visibleListed(state.listed);
  const { slice } = pageSlice(visible, state.listedPage, LISTED_PAGE_SIZE);
  const picked = (row: ListedTrend): boolean => state.listedSelected.has(row.slug);
  const on = (rows: ListedTrend[]): boolean =>
    rows.length > 0 && rows.every((row) => picked(row));
  syncHeadCheck("trends-listed-select-all", slice, listedPickable, picked);
  const page = slice.filter(listedPickable);
  syncPagePickBtn("trends-listed-pick-current", on(page), page.length);
  const pickable = visible.filter(listedPickable);
  syncAllPickBtn("trends-listed-pick-page", on(pickable), pickable.length);
}

function refreshStagingPickHead(): void {
  if (!state.staging) return;
  const visible = visibleCandidates(state.staging);
  const canPick = (row: CandidateView): boolean => row.enrichable && !row.rejected;
  const { slice } = pageSlice(visible, state.page, PAGE_SIZE);
  const picked = (row: CandidateView): boolean => state.selected.has(row.slug);
  const on = (rows: CandidateView[]): boolean =>
    rows.length > 0 && rows.every((row) => picked(row));
  syncHeadCheck("trends-select-all", slice, canPick, picked);
  const page = slice.filter(canPick);
  syncPagePickBtn("trends-pick-current", on(page), page.length);
  const pickable = visible.filter(canPick);
  syncAllPickBtn("trends-pick-page", on(pickable), pickable.length);
}

/** 当前页可勾选的线上词：和表格渲染走同一套筛选与分页 */
function currentListedPickable(): ListedTrend[] {
  if (!state.listed) return [];
  const { slice } = pageSlice(visibleListed(state.listed), state.listedPage, LISTED_PAGE_SIZE);
  return slice.filter(listedPickable);
}

/** 当前页可勾选的候选词（未富化、数据点达标、未拒绝） */
function currentStagingPickable(): CandidateView[] {
  if (!state.staging) return [];
  const { slice } = pageSlice(visibleCandidates(state.staging), state.page, PAGE_SIZE);
  return slice.filter((row) => row.enrichable && !row.rejected);
}

function renderListed(data: ListedResp): void {
  state.listed = data;
  const meta = $("trends-listed-meta");
  const body = $("trends-listed-body");
  const pager = $("trends-listed-pager");

  /* 下拉以服务端解析出的版本为准：选的版本被清理掉了会自动落回当前版本 */
  fillVersionSelect("trends-listed-version", data.versions, data.version);

  if (!data.items.length) {
    meta.textContent = data.detail ?? "线上还没有趋势词，先采集并发布一次";
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-ink-muted">线上榜单还没有趋势词</td></tr>`;
    pager.innerHTML = "";
    syncHeadCheck("trends-listed-select-all", [], listedPickable, () => false);
    syncPagePickBtn("trends-listed-pick-current", false, 0);
    syncAllPickBtn("trends-listed-pick-page", false, 0);
    syncListedBtn();
    return;
  }

  // 和筛选档位同口径：7 天 / 30 天，中间那档（10 天）看下拉筛就行
  const stale7 = data.items.filter((r) => (ageDays(r.lastSeenAt) ?? 999) >= 7).length;
  const stale30 = data.items.filter((r) => (ageDays(r.lastSeenAt) ?? 999) >= 30).length;
  const never = data.items.filter((r) => !r.lastSeenAt).length;
  /* 版本号取发布日期（20261119），后面跟上发布时刻：只说日期不知道是哪一轮发的 */
  meta.textContent =
    `${versionNote(data.version, pickedDataAt(data))} · 共 ${fmtNum(data.total)} 条（含别名）`
    + ` · 7 天未更新 ${fmtNum(stale7)}${never ? `（其中从未采集 ${fmtNum(never)}）` : ""}`
    + ` · 30 天未更新 ${fmtNum(stale30)}`
    + (data.refreshPending ? ` · 候选池待发布 ${fmtNum(data.refreshPending)}` : "");

  const rows = visibleListed(data);
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的词</td></tr>`;
    pager.innerHTML = "";
    syncHeadCheck("trends-listed-select-all", [], listedPickable, () => false);
    syncPagePickBtn("trends-listed-pick-current", false, 0);
    syncAllPickBtn("trends-listed-pick-page", false, 0);
    syncListedBtn();
    return;
  }

  const { slice, pages } = pageSlice(rows, state.listedPage, LISTED_PAGE_SIZE);
  state.listedPage = Math.min(state.listedPage, pages);

  /*
   * 整版的数据时间：这一版里最新一条是什么时候采的。
   *
   * 「更新时间」列显示的就是它，而不是每条自己的 updatedAt —— 一版 487 条里
   * 有的 10-29、有的 10-31，逐条显示的话版本号 20261031 永远和列里对不上，
   * 看着就像串了版。每条自己的时间退到 title，需要时鼠标一悬停就看得见。
   */
  const vDataAt = pickedDataAt(data);

  body.innerHTML = slice
    .map((row) => {
      const own = row.updatedAt ?? row.lastSeenAt;
      const stamp = vDataAt ?? own;
      const age = ageDays(stamp);
      const stage = row.staging ? STAGE_BADGES[row.staging] ?? { label: row.staging, cls: "bg-surface-2 text-ink-muted" } : null;

      /*
       * 状态列只说「这个词在队列里到哪一步了」——更新中 / 待富化 / 待发布 / 失败。
       * 新鲜度归「更新时间」列，两边别各说一遍年龄：以前状态列把候选池状态和
       * 「N 天前」二选一，同一个词要么看不到队列进度、要么看不到多久没动。
       */
      const status = stage
        ? `<span class="rounded-full px-2 py-0.5 text-[11px] font-semibold ${stage.cls}">${esc(stage.label)}</span>`
        : age === null
          ? `<span class="rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">从未采集</span>`
          : `<span class="text-xs text-ink-muted">—</span>`;

      /*
       * 更新时间：上行是本版采集时刻（各条相同，和版本号一天），下行是距今天数。
       * 「7 / 10 / 30 天未更新」的筛选仍按每条自己最后被采到的日期算，
       * 想找老数据还是用它 —— 那个信息没丢，只是不再显示在这一列上。
       */
      const ageNote =
        age === null
          ? ""
          : age >= 30
            ? `<span class="text-danger">${age} 天前</span>`
            : age >= 10
              ? `<span class="text-accent">${age} 天前</span>`
              : age >= 7
                ? `<span class="text-ink-secondary">${age} 天前</span>`
                : `<span class="text-ink-muted">${age === 0 ? "今天" : `${age} 天前`}</span>`;

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
          <td class="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-ink-secondary">
            <span class="block" title="${
              own && own !== stamp ? `本版采集时间；该条最后变化 ${esc(fmtStamp(own))}` : "本版采集时间"
            }">${esc(fmtStamp(stamp))}</span>
            ${ageNote ? `<span class="text-[11px]">${ageNote}</span>` : ""}
          </td>
          <td class="px-4 py-2.5">${status}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-right">
            <a href="/preview/trend/${encodeURIComponent(row.slug)}" target="_blank" rel="noopener" class="text-xs text-primary hover:underline" title="在新窗口预览：更新过的词显示候选池里的新内容，没更新的显示线上当前版本">预览</a>
            <button type="button" data-listed-refresh="${esc(row.slug)}" class="ml-3 text-xs text-primary transition hover:underline ${pickable ? "" : "cursor-not-allowed opacity-40"}" ${pickable ? "" : "disabled"}>更新</button>
          </td>
        </tr>`;
    })
    .join("");

  // 表头勾选框只反映本页：整页可勾且已勾 = 勾上，只勾了一部分 = 半选
  syncHeadCheck("trends-listed-select-all", slice, listedPickable, (row) => state.listedSelected.has(row.slug));
  // 「本页」动当前页，「全选」动筛选后的全部结果（跨页）
  const pagePickable = slice.filter(listedPickable);
  syncPagePickBtn(
    "trends-listed-pick-current",
    pagePickable.length > 0 && pagePickable.every((row) => state.listedSelected.has(row.slug)),
    pagePickable.length,
  );
  const pickable = rows.filter(listedPickable);
  syncAllPickBtn(
    "trends-listed-pick-page",
    pickable.length > 0 && pickable.every((row) => state.listedSelected.has(row.slug)),
    pickable.length,
  );

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
      + `结果只进候选池：跑完在本页签底部「待发布」里先看一遍新数据，点「发布」才会上线。`,
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
      // 跑完的词进候选池了，待发布清单要跟着变，否则用户看不出「更新成了什么」
      void loadPreview();
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

/*
 * 任务种类 → 中文标签 + 参数摘要。
 *
 * 以前这里只有「fetch 还是别的」两分支：更新选中 / 富化 / 回滚都被当成发布，
 * 文案又只会读 publish 的 incoming 字段，于是显示成「发布 · 合并 ? 个候选词」——
 * 那个问号不是数据缺失，是把 refresh 任务当发布来解释了。
 */
const JOB_KINDS: Record<string, string> = {
  fetch: "拉取",
  refresh: "更新",
  enrich: "富化",
  publish: "发布",
  revert: "回滚",
};

function jobDesc(job: Job): string {
  try {
    const p = JSON.parse(job.params) as Record<string, unknown>;
    const num = (v: unknown): number | null =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    const slugs = Array.isArray(p.slugs) ? p.slugs.length : null;
    switch (job.kind) {
      case "fetch":
        return `${num(p.budget) ?? "?"} 个 · ${typeof p.geo === "string" ? p.geo : "US"}`;
      case "refresh": {
        const n = slugs ?? num(p.count);
        return n === null ? "更新选中的词" : `更新 ${n} 个词`;
      }
      case "enrich": {
        const n = num(p.count) ?? slugs;
        return n === null ? "富化候选词" : `富化 ${n} 个词`;
      }
      case "revert": {
        const n = num(p.count) ?? slugs;
        return n === null ? "回滚候选词" : `回滚 ${n} 个词`;
      }
      default: {
        const n = num(p.incoming);
        return n === null ? "合并候选池" : `合并 ${n} 个候选词`;
      }
    }
  } catch {
    return JOB_KINDS[job.kind] ?? job.kind;
  }
}

function renderJobs(jobs: Job[]): void {
  const box = $("trends-jobs");
  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。拉取新词、更新词或发布会在这里显示进度。</p>`;
    return;
  }

  // 非终态即活跃：库里有 GitHub 的中间态（pending）时，只认 queued/running 会停止轮询
  schedulePolling(
    jobs.some((j) => j.status !== "success" && j.status !== "failure" && j.status !== "cancelled"),
  );

  box.innerHTML = jobs
    .map((job) => {
      const badge = statusBadge(job.status);
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : "—";
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-14 shrink-0 text-ink-muted">${esc(JOB_KINDS[job.kind] ?? job.kind)}</span>
          <span class="min-w-0 flex-1 truncate text-ink-secondary">${esc(jobDesc(job))}</span>
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
    syncHeadCheck("trends-select-all", [], () => false, () => false);
    syncPagePickBtn("trends-pick-current", false, 0);
    syncAllPickBtn("trends-pick-page", false, 0);
    syncEnrichBtn();
    return;
  }

  const { slice, pages } = pageSlice(rows, state.page, PAGE_SIZE);
  state.page = Math.min(state.page, pages);

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

      /*
       * 每行都有勾选框：不能勾的（已拒绝 / 数据不足 / 已富化的非在榜词）显示禁用态并说明原因，
       * 而不是干脆不渲染——否则同一列有的行有框有的行空白，看不出是「不能选」还是「漏了」。
       */
      const pickWhy = row.rejected
        ? "已拒绝，不能富化"
        : !row.enrichable
          ? row.dataPoints < 14
            ? `数据点只有 ${row.dataPoints} 个，不足 14 个不能富化`
            : "已富化，无需再富化"
          : "";
      const pick = `<span title="${esc(pickWhy)}"><input type="checkbox" data-trend-pick="${esc(row.slug)}" class="h-3.5 w-3.5 accent-primary disabled:opacity-40" ${state.selected.has(row.slug) ? "checked" : ""} ${pickWhy ? "disabled" : ""} /></span>`;
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

  // 和线上榜单同一套口径：勾选框与「本页」只看本页，跨页交给「全选」
  syncHeadCheck("trends-select-all", slice, (row) => row.enrichable && !row.rejected, (row) =>
    state.selected.has(row.slug),
  );
  const pagePickable = slice.filter((row) => row.enrichable && !row.rejected);
  syncPagePickBtn(
    "trends-pick-current",
    pagePickable.length > 0 && pagePickable.every((row) => state.selected.has(row.slug)),
    pagePickable.length,
  );
  const pickable = rows.filter((row) => row.enrichable && !row.rejected);
  syncAllPickBtn(
    "trends-pick-page",
    pickable.length > 0 && pickable.every((row) => state.selected.has(row.slug)),
    pickable.length,
  );

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

/**
 * 发布预览的两套挂载点：数据抓取页签的「发布预览」、线上榜单页签的「待发布」。
 * 同一份数据（/trends/publish/preview）、同一个发布接口，两边显示必须一致。
 */
const PUBLISH_TARGETS = [
  {
    btn: "trends-publish-btn",
    summary: "trends-publish-summary",
    box: "trends-publish-changes",
    idle: "发布",
  },
  {
    btn: "trends-listed-publish-btn",
    summary: "trends-listed-publish-summary",
    box: "trends-listed-publish-changes",
    idle: "发布",
  },
] as const;

/** 一份预览结果同时写到两个容器，避免一边刷新了另一边还停在旧内容 */
function paintPreview(summary: string, html: string, disabled: boolean): void {
  for (const t of PUBLISH_TARGETS) {
    const summaryEl = $(t.summary);
    const boxEl = $(t.box);
    const btn = $(t.btn) as HTMLButtonElement | null;
    if (summaryEl) summaryEl.textContent = summary;
    if (boxEl) boxEl.innerHTML = html;
    // 提交中的按钮别被 12 秒轮询刷回可点状态
    if (btn && !btn.dataset.busy) btn.disabled = disabled;
  }
}

/** 发布预览里「谁的位置变了」——这块是本页的核心 */
function renderPreview(data: PreviewResp): void {
  const p = data.preview;

  if (!p) {
    paintPreview("候选池为空，先拉取新词。", `<p class="text-xs text-ink-muted">—</p>`, true);
    return;
  }

  const untouched = p.incoming + p.exited === 0;
  const merged = untouched
    ? "没有待发布的候选词"
    : `合并 ${p.incoming} 个候选词（其中 ${p.inBoardRefresh} 个是在榜刷新）；榜单 ${p.boardBefore} → ${p.boardAfter} / ${p.boardLimit} 条`;
  // 基线缺失时「新进榜 / 在榜刷新」都算不出来，先说明再给数字
  const summary =
    p.baseline === false
      ? `候选池没有榜单基线，本次位次变化不可信（重新采集一次即可）· ${merged}`
      : merged;

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
    paintPreview(
      summary,
      `<p class="text-xs text-ink-muted">候选池已经清空，线上榜单没有待合并的内容。</p>${lastBlock}`,
      true,
    );
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
    paintPreview(
      summary,
      `${counts}<p class="text-xs text-ink-muted">本次没有显著位次变化：新词都排在末尾，也没有词出榜。</p>${lastBlock}`,
      false,
    );
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

  paintPreview(
    summary,
    `${counts}
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
      ${lastBlock}`,
    false,
  );
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
    const data = await apiGet<{ jobs: Job[] }>("/trends/jobs?limit=5").catch(() => null);
    if (!data) continue;
    renderJobs(data.jobs ?? []);
    const job = (data.jobs ?? []).find((j) => j.id === id);
    if (!job) return; // 记录被挤出前 5 条，无从判断，别无限等
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
    const data = await apiGet<{ jobs: Job[] }>("/trends/jobs?limit=5");
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
    /* 不带 version 就是「当前生效版本」，由服务端解析；选了旧版才带上 */
    const qs = state.listedVersion ? `?version=${encodeURIComponent(state.listedVersion)}` : "";
    renderListed(await apiGet<ListedResp>(`/trends/listed${qs}`));
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
    paintPreview("发布预览读取失败", `<p class="text-xs text-ink-muted">—</p>`, true);
  }
}

function reloadAll(): void {
  void loadOverview();
  void loadJobs();
  void loadStaging();
  void loadPreview();
  // 线上榜单是 367 条全量算分，人没在看这一页时不拉；切过去时再补一次
  if (state.view === "listed") void loadListed();
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

/**
 * 发布按钮的执行体。
 *
 * 数据抓取页签的「发布预览」和线上榜单页签的「待发布」是同一个动作
 * （整榜合并候选池），只是按钮位置不同——文案、禁用状态、提交后的刷新都共用这里，
 * 不会出现一边能点一边灰着。
 */
async function submitPublish(btnId: string, idle: string): Promise<void> {
  if (!confirmPublish()) return;
  const btn = $(btnId) as HTMLButtonElement;
  // dataset.busy 让 paintPreview 别把提交中的按钮刷回可点状态
  btn.dataset.busy = "1";
  btn.disabled = true;
  btn.textContent = "提交中…";
  try {
    await apiPost("/trends/publish", {});
    btn.textContent = "已提交";
    void loadJobs();
    // 发布任务跑完才会动线上数据，几秒后整体重拉一次即可
    window.setTimeout(() => {
      delete btn.dataset.busy;
      btn.textContent = idle;
      reloadAll();
    }, 4000);
  } catch (e) {
    delete btn.dataset.busy;
    btn.disabled = false;
    btn.textContent = idle;
    window.alert(`发布失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

function bind(): void {
  /*
   * 子页签：数据抓取（采集 + 候选池 + 发布预览）/ 线上榜单（当前版本 + 待发布）。
   * 切换只改显隐，数据各拉各的；线上榜单离开时不渲染，回来时补拉一次最新的。
   */
  document.querySelectorAll<HTMLElement>("[data-trends-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.trendsView === "listed" ? "listed" : "fetch";
      state.view = view;
      document
        .querySelectorAll<HTMLElement>("[data-trends-view]")
        .forEach((b) => (b.dataset.active = String(b === btn)));
      $("trends-view-fetch").hidden = view !== "fetch";
      $("trends-view-listed").hidden = view !== "listed";
      if (view === "listed") void loadListed();
    });
  });

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
   * 表头勾选框 = 本页全选：翻到这一页、扫一眼、合适的整页勾上。
   */
  ($("trends-select-all") as HTMLInputElement).addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    for (const row of currentStagingPickable()) {
      if (on) state.selected.add(row.slug);
      else state.selected.delete(row.slug);
    }
    if (state.staging) renderStaging(state.staging);
  });

  /*
   * 「本页」只动当前这一页：翻到某页、扫一眼、合适的整页勾上。
   * 整页已全勾时再点就是取消本页，和按钮文案一致。
   */
  $("trends-pick-current").addEventListener("click", () => {
    const rows = currentStagingPickable();
    const allOn = rows.length > 0 && rows.every((row) => state.selected.has(row.slug));
    for (const row of rows) {
      if (allOn) state.selected.delete(row.slug);
      else state.selected.add(row.slug);
    }
    if (state.staging) renderStaging(state.staging);
  });

  /*
   * 「全选」= 筛选后的**全部**候选（跨页），跳过数据不足/已拒绝的；
   * 提交时按 60/批 串行派发。会选中多少写在 title 里，右侧按钮上的计数同步更新。
   */
  $("trends-pick-page").addEventListener("click", () => {
    if (!state.staging) return;
    const rows = visibleCandidates(state.staging).filter((row) => row.enrichable && !row.rejected);
    const allOn = rows.length > 0 && rows.every((row) => state.selected.has(row.slug));
    for (const row of rows) {
      if (allOn) state.selected.delete(row.slug);
      else state.selected.add(row.slug);
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
    refreshStagingPickHead();
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
   * 表头勾选框 = 本页全选。表格右上角那个勾在用户认知里就是「这一页」，
   * 跨页全选必须由旁边的「全选（N）」按钮显式触发，否则一点就选走 467 个。
   */
  ($("trends-listed-select-all") as HTMLInputElement).addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    for (const row of currentListedPickable()) {
      if (on) state.listedSelected.add(row.slug);
      else state.listedSelected.delete(row.slug);
    }
    if (state.listed) renderListed(state.listed);
  });

  /*
   * 「本页」只动当前这一页：勾上这 20 条去看结果，不必翻页逐个点。
   */
  $("trends-listed-pick-current").addEventListener("click", () => {
    const rows = currentListedPickable();
    const allOn = rows.length > 0 && rows.every((row) => state.listedSelected.has(row.slug));
    for (const row of rows) {
      if (allOn) state.listedSelected.delete(row.slug);
      else state.listedSelected.add(row.slug);
    }
    if (state.listed) renderListed(state.listed);
  });

  /*
   * 「全选」= 筛选后的全部线上词（跨页），跳过正在跑/正在发布的。
   * 487 条里挑几十个靠翻 24 页勾不现实，但这个动作必须显式点。
   */
  $("trends-listed-pick-page").addEventListener("click", () => {
    if (!state.listed) return;
    const rows = visibleListed(state.listed).filter(listedPickable);
    const allOn = rows.length > 0 && rows.every((row) => state.listedSelected.has(row.slug));
    for (const row of rows) {
      if (allOn) state.listedSelected.delete(row.slug);
      else state.listedSelected.add(row.slug);
    }
    renderListed(state.listed);
  });

  ($("trends-listed-filter") as HTMLSelectElement).addEventListener("change", (event) => {
    state.listedFilter = (event.target as HTMLSelectElement).value;
    state.listedPage = 1;
    if (state.listed) renderListed(state.listed);
  });

  /* 换版本 = 换一份数据：已勾选的词属于上一版，留着会让「更新选中」摸到看不见的词 */
  $("trends-listed-version")?.addEventListener("change", (event) => {
    state.listedVersion = (event.target as HTMLSelectElement).value;
    state.listedSelected.clear();
    state.listedPage = 1;
    void loadListed();
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
    refreshListedPickHead();
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

  // 两个页签各有一个发布按钮，走同一份提交逻辑
  for (const t of PUBLISH_TARGETS) {
    $(t.btn).addEventListener("click", () => void submitPublish(t.btn, t.idle));
  }

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