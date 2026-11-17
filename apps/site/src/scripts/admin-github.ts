/**
 * 后台「GitHub 榜」页签：采集 → 审核 → 看位次变化 → 发布。
 *
 * 与工具榜、趋势榜同一套路，但这里有两个和别处不同的点：
 *
 * 1. **容量是硬约束**。榜单固定 2000 条，插入高分段项目就会把末尾的挤出去，
 *    所以「进榜」和「出榜」必须成对讲清楚，不能只说「新增 68 条」。
 * 2. **显著变动的口径是分数，不是名次**。2000 条的榜单纯插入 68 条，
 *    后面上千条都会顺延一名，按名次算就是上千条噪音；只有「自己分数变了 ≥0.5」
 *    或「涉及前 50」才值得提醒。口径来自 @horizons/shared 的 diffRepoRanks，
 *    与发布脚本完全一致。
 *
 * 采集结果只写 content/github-staging.json，点「发布」之前线上榜单一个字都不会变。
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
  fullName: string;
  owner: string;
  description?: string;
  language?: string;
  topics: string[];
  stars: number;
  forks: number;
  score: number;
  grade: string;
  /** 加工空间 0-10 */
  dv: number | null;
  inBoard: boolean;
  currentRank: number | null;
  estimatedRank: number | null;
  delta: number | null;
  scoreDelta: number;
  rejected: boolean;
  check: { ok: boolean; reason: string };
}

interface RankChange {
  fullName: string;
  from: number | null;
  to: number | null;
  delta: number;
  scoreDelta: number;
  significant: boolean;
}

interface LastRun {
  at: string;
  candidates: number;
  qualified: number;
  fresh: number;
  entered: number;
  exited: number;
  shortfall: number;
  elapsedMs: number;
}

interface LastPublish {
  at: string;
  total: number;
  source: string;
  report: { entered: number; exited: number; ups: number; downs: number; significant: number };
}

interface StagingInfo {
  updatedAt: string;
  ruleVersion: string;
  scoreModel: string;
  target: number;
  boardRows: number;
  boardUpdatedAt: string | null;
  candidates: number;
  pending: number;
  rejected: number;
  updates: number;
  lastRun: LastRun | null;
  lastPublish: LastPublish | null;
  /** 发布后预计能凑到多少条 */
  projected: number;
  /** 距离 target 还差多少 */
  shortfall: number;
  boardBefore: number;
  boardAfter: number;
  entered: number;
  exited: number;
  up: number;
  down: number;
  significant: number;
  shifted: number;
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
  empty?: boolean;
  error?: string;
}

interface StagingResp {
  empty?: boolean;
  updatedAt?: string;
  target?: number;
  lastRun?: LastRun | null;
  lastPublish?: LastPublish | null;
  candidates: CandidateView[];
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
  target: number;
  incoming: number;
  inBoardRefresh: number;
  projected: number;
  shortfall: number;
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
  lastPublish: LastPublish | null;
}

interface PreviewResp {
  empty?: boolean;
  preview: Preview | null;
}

/* --------------------------------- 状态 --------------------------------- */

const PAGE_SIZE = 30;

const state = {
  filter: "all",
  q: "",
  page: 1,
  staging: null as StagingResp | null,
  preview: null as Preview | null,
  polling: 0 as number | undefined,
  mounted: false,
};

/* -------------------------------- 小工具 -------------------------------- */

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

/** 星标按万/千缩写，2000 行的表格里没必要写全 */
function fmtStars(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

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

/** 名次变化：只在「不是纯顺延」时给出，避免每行都显示 -1 */
function rankCell(row: CandidateView): string {
  const now = row.currentRank ? `#${row.currentRank}` : "—";
  const next = row.rejected ? "（已拒绝）" : row.estimatedRank ? `#${row.estimatedRank}` : "挤不进";
  const delta =
    row.delta !== null && row.delta !== 0 && !row.rejected
      ? `<span class="ml-1 text-[11px] ${row.delta > 0 ? "text-accent" : "text-danger"}">${row.delta > 0 ? "+" : ""}${row.delta}</span>`
      : "";
  return `<span class="tabular-nums text-ink-secondary">${now} → ${next}</span>${delta}`;
}

/* -------------------------------- 渲染 ---------------------------------- */

function renderOverview(data: Overview): void {
  $("gh-setup").classList.toggle("hidden", data.configured);

  if (!data.configured) {
    $("gh-setup-missing").textContent = `缺少：${data.missing.join("、")}`;
    for (const id of ["gh-kpi-board", "gh-kpi-candidates", "gh-kpi-pending", "gh-kpi-changes"]) {
      $(id).textContent = "—";
    }
    $("gh-fetch-btn").setAttribute("disabled", "true");
    $("gh-publish-btn").setAttribute("disabled", "true");
    return;
  }

  $("gh-fetch-btn").removeAttribute("disabled");
  const s = data.staging;

  if (!s) {
    // 候选池为空不代表榜单为空：正式榜还在线上跑，用统计快照显示真实条数
    $("gh-kpi-board").textContent = data.board ? fmtNum(data.board.total) : "—";
    $("gh-kpi-board-sub").textContent = data.board
      ? `正式榜 ${fmtNum(data.board.total)} 条${data.board.updatedAt ? ` · ${fmtTime(data.board.updatedAt)}` : ""}`
      : data.error
        ? `快照读取失败：${data.error}`
        : "还没有采集过";
    $("gh-kpi-candidates").textContent = "—";
    $("gh-kpi-candidates-sub").textContent = "点「采集」生成候选池";
    $("gh-kpi-pending").textContent = "—";
    $("gh-kpi-pending-sub").textContent = "—";
    $("gh-kpi-changes").textContent = "—";
    $("gh-kpi-changes-sub").textContent = "—";
    return;
  }

  $("gh-kpi-board").textContent = fmtNum(s.boardRows);
  $("gh-kpi-board-sub").textContent = s.boardUpdatedAt
    ? `快照 ${fmtTime(s.boardUpdatedAt)} · 目标 ${fmtNum(s.target)} 条`
    : `目标 ${fmtNum(s.target)} 条 · 候选池里没有榜单快照`;

  $("gh-kpi-candidates").textContent = fmtNum(s.candidates);
  $("gh-kpi-candidates-sub").textContent = s.lastRun
    ? `上次采集 ${fmtTime(s.lastRun.at)}：合格 ${fmtNum(s.lastRun.qualified)} · 新候选 ${fmtNum(s.lastRun.fresh)}`
    : "还没有采集记录";

  $("gh-kpi-pending").textContent = fmtNum(s.pending);
  $("gh-kpi-pending-sub").textContent = `在榜数值更新 ${fmtNum(s.updates)} 条 · 已拒绝 ${fmtNum(s.rejected)} 条`;

  $("gh-kpi-changes").textContent = fmtNum(s.significant);
  $("gh-kpi-changes-sub").textContent =
    s.shortfall > 0
      ? `进 ${fmtNum(s.entered)} · 出 ${fmtNum(s.exited)} · 仍缺 ${fmtNum(s.shortfall)} 条`
      : `进 ${fmtNum(s.entered)} · 出 ${fmtNum(s.exited)} · 发布后 ${fmtNum(s.projected)} 条`;
}

function renderJobs(jobs: Job[]): void {
  const box = $("gh-jobs");
  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。点上面的「采集」会在这里显示进度。</p>`;
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
          if (job.kind === "fetch") return `目标 ${p.target ?? "?"} 条${p.refreshCache ? " · 强制重搜" : ""}`;
          return `合并 ${p.incoming ?? "?"} 个候选 · 更新 ${p.updates ?? 0} 条`;
        } catch {
          return job.kind === "fetch" ? "采集" : "发布";
        }
      })();
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : "—";
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-14 shrink-0 text-ink-muted">${job.kind === "fetch" ? "采集" : "发布"}</span>
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
    if (q && !c.fullName.toLowerCase().includes(q) && !(c.description ?? "").toLowerCase().includes(q)) {
      return false;
    }
    if (state.filter === "new") return !c.inBoard && !c.rejected;
    if (state.filter === "board") return c.inBoard && !c.rejected;
    if (state.filter === "rejected") return c.rejected;
    return true;
  });
}

function renderStaging(data: StagingResp): void {
  state.staging = data;

  const meta = $("gh-staging-meta");
  if (data.empty) {
    meta.textContent = "候选池为空。采集一次后，新项目会先进到这里等你审核。";
  } else {
    const last = data.lastRun
      ? `｜上次采集合格 ${fmtNum(data.lastRun.qualified)} 个，耗时 ${Math.round(data.lastRun.elapsedMs / 1000)}s`
      : "";
    meta.textContent = `候选 ${data.candidates.length} 个 · 待发布 ${data.candidates.filter((c) => !c.rejected).length} · 已拒绝 ${data.candidates.filter((c) => c.rejected).length}${last}`;
  }

  const rows = data.empty ? [] : visibleCandidates(data);
  const body = $("gh-staging-body");
  const pager = $("gh-staging-pager");

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的候选项目</td></tr>`;
    pager.innerHTML = "";
    return;
  }

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > pages) state.page = pages;
  const slice = rows.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);

  body.innerHTML = slice
    .map((row) => {
      const status = row.rejected
        ? `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">已拒绝</span>`
        : row.inBoard
          ? `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">在榜刷新</span>`
          : `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">新候选</span>`;
      const scoreDelta =
        Math.abs(row.scoreDelta) >= 0.1
          ? `<span class="ml-1 text-[11px] ${row.scoreDelta > 0 ? "text-accent" : "text-danger"}">${row.scoreDelta > 0 ? "+" : ""}${row.scoreDelta.toFixed(1)}</span>`
          : "";
      return `<tr class="transition hover:bg-surface-2/50">
          <td class="max-w-[300px] px-4 py-2.5">
            <a href="https://github.com/${esc(row.fullName)}" target="_blank" rel="noopener" class="block max-w-full truncate text-left font-medium text-ink hover:text-primary">${esc(row.fullName)}</a>
            <div class="mt-0.5 truncate text-[11px] text-ink-muted">${esc(row.description || "（无简介）")}</div>
          </td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${fmtStars(row.stars)}</td>
          <td class="px-4 py-2.5 text-right text-xs font-medium tabular-nums text-ink">${row.score.toFixed(1)}${scoreDelta}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${esc(row.grade)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums ${row.dv === null ? "text-ink-muted" : "text-ink-secondary"}">${row.dv === null ? "—" : row.dv.toFixed(1)}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-xs">${rankCell(row)}</td>
          <td class="px-4 py-2.5">${status}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-right">
            <button type="button" data-gh-reject="${esc(row.fullName)}" data-gh-rejected="${row.rejected}" class="text-xs text-ink-muted transition hover:text-danger">${row.rejected ? "恢复" : "拒绝"}</button>
          </td>
        </tr>`;
    })
    .join("");

  const prev = state.page <= 1;
  const next = state.page >= pages;
  pager.innerHTML = `<span>共 ${rows.length} 个 · 第 ${state.page} / ${pages} 页</span>
      <span class="flex gap-3">
        <button type="button" data-gh-page="${state.page - 1}" class="${prev ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${prev ? "disabled" : ""}>上一页</button>
        <button type="button" data-gh-page="${state.page + 1}" class="${next ? "cursor-not-allowed opacity-40" : "text-primary hover:underline"}" ${next ? "disabled" : ""}>下一页</button>
      </span>`;
}

/** 发布预览：谁进榜、谁被挤出去、前 50 谁动了 —— 本页的核心 */
function renderPreview(data: PreviewResp): void {
  const p = data.preview;
  const btn = $("gh-publish-btn") as HTMLButtonElement;
  const summary = $("gh-publish-summary");
  const box = $("gh-publish-changes");

  if (!p) {
    summary.textContent = "候选池为空，先采集一轮。";
    box.innerHTML = `<p class="text-xs text-ink-muted">—</p>`;
    btn.disabled = true;
    return;
  }

  const untouched = p.incoming === 0;
  summary.textContent = untouched
    ? "没有待发布的候选项目"
    : `合并 ${p.incoming} 个候选（其中 ${p.inBoardRefresh} 条纯数值更新）；榜单 ${p.boardBefore} → ${p.boardAfter} 条（目标 ${p.target}）`;
  btn.disabled = untouched;

  const shortfall =
    p.shortfall > 0
      ? `<p class="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-ink-secondary">
          发布后仍只有 ${p.projected} 条，距离目标 ${p.target} 条还差 <strong class="text-ink">${p.shortfall}</strong> 条。
          想让榜单更满，就在采集时把「搜索页数」调大一些再跑一轮（候选池会累积）。
        </p>`
      : "";

  const last = p.lastPublish;
  const lastBlock = !last
    ? ""
    : `<details class="mt-4 rounded-lg border border-border px-3 py-2">
        <summary class="cursor-pointer text-xs text-ink-secondary">上次发布 ${fmtTime(last.at)}：进 ${last.report.entered} · 出 ${last.report.exited} · 显著 ${last.report.significant} · 榜单 ${fmtNum(last.total)} 条</summary>
        <p class="mt-2 text-[11px] text-ink-muted">候选池发布后会被清空，完整清单见那次发布的 GitHub 日志。</p>
      </details>`;

  if (untouched) {
    box.innerHTML = `<p class="text-xs text-ink-muted">候选池已经清空，线上榜单没有待合并的内容。</p>${lastBlock}`;
    return;
  }

  const counts = `<div class="mb-3 flex flex-wrap gap-2 text-[11px]">
      <span class="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">进榜 ${p.entered}</span>
      <span class="rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger">出榜 ${p.exited}</span>
      <span class="rounded-full bg-accent-soft px-2 py-0.5 font-semibold text-accent">上升 ${p.up}</span>
      <span class="rounded-full bg-danger-soft px-2 py-0.5 font-semibold text-danger">下降 ${p.down}</span>
      <span class="rounded-full bg-surface-2 px-2 py-0.5 text-ink-muted">仅顺延 ${p.shifted}</span>
    </div>`;

  // 排在前面的项目最要紧：按「原/新名次里更靠前的那个」升序
  const named = [...p.named].sort(
    (a, b) => Math.min(a.from ?? 1e9, a.to ?? 1e9) - Math.min(b.from ?? 1e9, b.to ?? 1e9),
  );

  if (!named.length) {
    box.innerHTML = `${shortfall}${counts}<p class="text-xs text-ink-muted">本次没有显著变化：新项目都排在末尾，也没有项目被挤出容量。</p>${lastBlock}`;
    return;
  }

  const list = named
    .slice(0, 60)
    .map(
      (c) => `<div class="flex flex-wrap items-center gap-2 border-b border-border px-1 py-1.5 text-xs last:border-b-0">
          ${changeBadge(c)}
          <span class="min-w-0 flex-1 truncate text-ink">${esc(c.fullName)}</span>
          <span class="shrink-0 tabular-nums text-ink-muted">${c.from ? `#${c.from}` : "—"} → ${c.to ? `#${c.to}` : "—"}</span>
          <span class="w-14 shrink-0 text-right tabular-nums ${c.scoreDelta > 0 ? "text-accent" : c.scoreDelta < 0 ? "text-danger" : "text-ink-muted"}">${c.scoreDelta > 0 ? "+" : ""}${c.scoreDelta.toFixed(1)} 分</span>
        </div>`,
    )
    .join("");

  const more =
    named.length > 60 ? `<p class="mt-2 text-[11px] text-ink-muted">还有 ${named.length - 60} 条显著变动，完整清单见发布日志。</p>` : "";

  box.innerHTML = `${shortfall}${counts}
      <div class="max-h-80 overflow-y-auto rounded-lg border border-border px-2">
        <div class="sticky top-0 flex items-center gap-2 bg-surface py-1.5 text-[11px] text-ink-muted">
          <span class="w-14 shrink-0">类型</span>
          <span class="min-w-0 flex-1">仓库</span>
          <span class="shrink-0">原名次 → 新名次</span>
          <span class="w-14 shrink-0 text-right">分数</span>
        </div>
        ${list}
      </div>
      <p class="mt-2 text-[11px] leading-relaxed text-ink-muted">
        只列「进榜 / 出榜 / 涉及前 50」或「自身综合分变化 ≥ 0.5」的 ${p.significant} 条；
        另有 ${p.shifted} 条名次变化由新项目插入顺延导致（通常只挪 1–2 名），不逐条列出。
      </p>
      ${more}
      ${lastBlock}`;
}

/* --------------------------------- 加载 --------------------------------- */

async function loadOverview(): Promise<void> {
  try {
    renderOverview(await apiGet<Overview>("/github/overview"));
  } catch (e) {
    $("gh-setup").classList.remove("hidden");
    $("gh-setup-missing").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadJobs(): Promise<void> {
  try {
    const data = await apiGet<{ jobs: Job[] }>("/github/jobs?limit=8");
    renderJobs(data.jobs ?? []);
  } catch {
    /* 任务列表失败不阻塞其它区域 */
  }
}

async function loadStaging(): Promise<void> {
  try {
    renderStaging(await apiGet<StagingResp>("/github/staging"));
  } catch (e) {
    $("gh-staging-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadPreview(): Promise<void> {
  try {
    const data = await apiGet<PreviewResp>("/github/publish/preview");
    state.preview = data.preview;
    renderPreview(data);
  } catch {
    $("gh-publish-summary").textContent = "发布预览读取失败";
    $("gh-publish-btn").setAttribute("disabled", "true");
  }
}

function reloadAll(): void {
  void loadOverview();
  void loadJobs();
  void loadStaging();
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

/* -------------------------------- 事件绑定 -------------------------------- */

/** 发布确认框：把最要紧的几条变化念出来，避免「点完才发现榜单被挤乱」 */
function confirmPublish(): boolean {
  const p = state.preview;
  if (!p) return false;

  const named = [...p.named].sort(
    (a, b) => Math.min(a.from ?? 1e9, a.to ?? 1e9) - Math.min(b.from ?? 1e9, b.to ?? 1e9),
  );
  const head = named
    .slice(0, 5)
    .map((c) => `· ${c.fullName}：${c.from ? `#${c.from}` : "新进"} → ${c.to ? `#${c.to}` : "出榜"}`)
    .join("\n");

  const lines = [
    `确认合并 ${p.incoming} 个候选？`,
    `榜单 ${p.boardBefore} → ${p.boardAfter} 条（目标 ${p.target}）。`,
    `进榜 ${p.entered} 条，出榜 ${p.exited} 条。`,
    p.significant
      ? `\n显著变化 ${p.significant} 条：\n${head}${named.length > 5 ? `\n· 其余 ${named.length - 5} 条见页面清单` : ""}`
      : "\n本次没有显著变化。",
    `另有 ${p.shifted} 条名次仅因插入顺延。`,
    p.shortfall > 0 ? `\n注意：发布后仍缺 ${p.shortfall} 条才到目标。` : "",
    "\n发布会自动触发一次站点构建。",
  ];
  return window.confirm(lines.join("\n"));
}

function bind(): void {
  const target = $("gh-fetch-target") as HTMLInputElement;
  const refresh = $("gh-fetch-refresh") as HTMLInputElement;
  const hint = $("gh-fetch-hint");

  const updateHint = (): void => {
    const n = Number(target.value) || 2000;
    hint.textContent = `目标 ${n} 条 · 149 个搜索词 × 5 页，全量约 45–60 分钟；3 小时缓存内增量只补新页，会快很多｜结果只进候选池`;
  };
  target.addEventListener("input", updateHint);
  refresh.addEventListener("change", updateHint);
  updateHint();

  $("gh-fetch-btn").addEventListener("click", async () => {
    const btn = $("gh-fetch-btn") as HTMLButtonElement;
    const n = Math.min(Math.max(Math.round(Number(target.value) || 2000), 500), 3000);
    if (n !== Number(target.value)) target.value = String(n);
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/github/fetch", { target: n, refreshCache: refresh.checked });
      btn.textContent = "已提交";
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "采集榜单";
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "采集榜单";
      window.alert(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("gh-staging-refresh").addEventListener("click", reloadAll);

  ($("gh-staging-filter") as HTMLSelectElement).addEventListener("change", (event) => {
    state.filter = (event.target as HTMLSelectElement).value;
    state.page = 1;
    if (state.staging) renderStaging(state.staging);
  });

  $("gh-staging-search").addEventListener(
    "input",
    debounce(() => {
      state.q = ($("gh-staging-search") as HTMLInputElement).value.trim();
      state.page = 1;
      if (state.staging) renderStaging(state.staging);
    }),
  );

  // 表格内容是动态渲染的，统一用事件委托
  $("gh-staging-body").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-gh-reject]");
    const fullName = btn?.dataset.ghReject;
    if (!fullName) return;
    const reject = btn?.dataset.ghRejected !== "true";
    void apiPost("/github/staging/reject", { fullName, rejected: reject })
      .then(reloadAll)
      .catch((e) => window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`));
  });

  $("gh-staging-pager").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-gh-page]");
    const page = Number(btn?.dataset.ghPage);
    if (!page || page === state.page) return;
    state.page = page;
    if (state.staging) renderStaging(state.staging);
  });

  $("gh-publish-btn").addEventListener("click", async () => {
    if (!confirmPublish()) return;
    const btn = $("gh-publish-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/github/publish", {});
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
}

/* --------------------------------- 入口 --------------------------------- */

/** 首次切到页签时挂载；重复调用只刷新数据 */
export function mountAdminGithub(): void {
  if (state.mounted) {
    reloadAll();
    return;
  }

  state.mounted = true;
  bind();
  reloadAll();
}