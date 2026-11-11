/**
 * 后台「工具榜」页签。
 *
 * 只做界面与交互：真正干活的是 API 里的 GitHub Actions 触发，
 * 这里负责把「抓取 → 待发布 → 更新榜单」三步串起来，并把结果画出来。
 */

/* -------------------------------- 基础工具 -------------------------------- */

import { $, apiGet, apiPost, debounce, esc, fmtNum, fmtTime } from "./admin-shared";

function fmtVisits(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString("zh-CN");
}

/* --------------------------------- 类型 --------------------------------- */

interface Job {
  id: string;
  kind: "fetch" | "enrich" | "audit" | "publish";
  status: string;
  params: string;
  run_url: string | null;
  created_at: number;
}

interface ToolStats {
  generatedAt: string;
  target: number;
  candidates: number;
  qualified: number;
  listed: number;
  core: number;
  watch: number;
  withTraffic: number;
  staging: { pending: number; approved: number; enriched: number; rejected: number };
  gap: number;
}

interface Overview {
  configured: boolean;
  missing: string[];
  stats: ToolStats | null;
  /** 数据库里的在榜条数，统计快照缺失时仍然有值 */
  board?: { total: number; updatedAt: string | null } | null;
  jobs: Job[];
  error?: string;
}

interface StagingRow {
  domain: string;
  name: string;
  url: string | null;
  description: string | null;
  phUpvotes: number;
  monthlyVisits: number | null;
  heatScore: number;
  categories: string[];
  firstSeenAt: string | null;
  tier: "core" | "watch" | "reject" | null;
  /** 采集时的判定理由，例如「A4 月访问 320 < 1,000」 */
  reason: string | null;
  stage: "candidate" | "approved" | "enriched" | "published";
  /** 富化后仍缺的页面维度（key 列表） */
  fieldGaps: string[];
  rejected: boolean;
}

interface StagingResp {
  updatedAt: string | null;
  lastRun: { at: string; requested: number; added: number; skipped: number; enriched: number } | null;
  total: number;
  pending: number;
  approved: number;
  enriched: number;
  rejected: number;
  page: number;
  pageSize: number;
  items: StagingRow[];
}

interface AuditDropped {
  domain: string;
  name: string;
  reason: string;
  monthlyVisits?: number;
}

interface PreviewResp {
  pending: number;
  approved: number;
  enriched: number;
  candidates: number;
  rejected: number;
  estimate: { candidatesAfter: number; listedBefore: number; listedAfter?: number; dropCount?: number } | null;
  /** null = 还没跑过存量重判，下榜清单未知 */
  audit: {
    generatedAt: string | null;
    total: number;
    dropCount: number;
    dropped: AuditDropped[];
    degraded: Array<{ domain: string; name: string; monthlyVisits?: number }>;
    refreshedTraffic: boolean;
    probed: boolean;
  } | null;
}

interface FieldIssue {
  key: string;
  label: string;
  reason: string;
}

interface FieldReport {
  generatedAt: string;
  total: number;
  itemsWithIssues?: number;
  dimensions: Array<{
    key: string;
    label: string;
    /** 空置：没采到 */
    missing: number;
    missingRatio: number;
    missingDomains?: string[];
    /** 异常：有值但不合法 */
    invalid?: number;
    invalidRatio?: number;
    invalidSamples?: Array<{ domain: string; reason: string }>;
  }>;
  entryIssues?: Array<{ domain: string; label: string; reason: string }>;
  items: Array<{
    domain: string;
    name: string;
    gapCount: number;
    gaps: string[];
    issueCount?: number;
    issues?: FieldIssue[];
  }>;
}

/* --------------------------------- 状态 --------------------------------- */

const state = {
  page: 1,
  q: "",
  tier: "all",
  staging: null as StagingResp | null,
  stats: null as ToolStats | null,
  detailDomain: "",
  detailRejected: false,
  /** 批量操作选中的域名 */
  selected: new Set<string>(),
  polling: 0 as number | undefined,
  mounted: false,
};

/* -------------------------------- 渲染 ---------------------------------- */

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

function tierBadge(tier: "core" | "watch" | "reject" | null): string {
  if (tier === "core") {
    return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">主榜</span>`;
  }
  if (tier === "watch") {
    return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">观察</span>`;
  }
  if (tier === "reject") {
    return `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">不收录</span>`;
  }
  return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted">未判定</span>`;
}

function stageBadge(stage: StagingRow["stage"]): string {
  switch (stage) {
    case "approved":
      return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">待富化</span>`;
    case "enriched":
      return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">可发榜</span>`;
    case "published":
      return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted">已发榜</span>`;
    default:
      return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-muted">待确认</span>`;
  }
}

/** 抓取表单底部的预估文案：候选池变化 + Apify 流量成本 */
function updateFetchEstimate(): void {
  const count = Number(($("tools-fetch-count") as HTMLSelectElement).value) || 60;
  const enrich = ($("tools-fetch-enrich") as HTMLInputElement).checked;
  const before = state.stats?.candidates;
  const pool =
    before == null
      ? `新增约 ${fmtNum(count)} 条候选`
      : `候选池 ${fmtNum(before)} → 约 ${fmtNum(before + count)} 条（去重前）`;
  const cost = enrich
    ? `流量富化约 $${(count * 0.003).toFixed(2)}`
    : "不补流量：只有 PH 点赞 ≥ 300 的能进榜";
  $("tools-fetch-estimate").textContent = [pool, cost, "跑完先落在「待发布」，不影响线上"].join("｜");
}

function renderOverview(data: Overview): void {
  $("tools-setup").classList.toggle("hidden", data.configured);

  if (!data.configured) {
    $("tools-setup-missing").textContent = `缺少：${data.missing.join("、")}`;
    for (const id of ["tool-kpi-listed", "tool-kpi-candidates", "tool-kpi-pending", "tool-kpi-gap"]) {
      $(id).textContent = "—";
    }
    $("tools-fetch-btn").setAttribute("disabled", "true");
    $("tools-publish-btn").setAttribute("disabled", "true");
    return;
  }

  $("tools-fetch-btn").removeAttribute("disabled");
  const s = data.stats;
  state.stats = s;
  updateFetchEstimate();
  if (!s) {
    // 统计快照缺失不代表榜单为空：正式榜还在线上跑，用库里的条数兜底
    $("tool-kpi-listed").textContent = data.board ? fmtNum(data.board.total) : "—";
    $("tool-kpi-listed-sub").textContent = data.board
      ? `正式榜 ${fmtNum(data.board.total)} 条${data.board.updatedAt ? ` · ${fmtTime(data.board.updatedAt)}` : ""}`
      : "还没有快照，抓取或发布一次后生成";
    return;
  }

  $("tool-kpi-listed").textContent = `${fmtNum(s.listed)} / ${fmtNum(s.target)}`;
  $("tool-kpi-listed-sub").textContent = `主榜 ${fmtNum(s.core)} · 观察区 ${fmtNum(s.watch)}`;
  $("tool-kpi-candidates").textContent = fmtNum(s.candidates);
  $("tool-kpi-candidates-sub").textContent = `达标 ${fmtNum(s.qualified)} · 有流量 ${fmtNum(s.withTraffic)}`;
  $("tool-kpi-pending").textContent = fmtNum(s.staging.pending);
  $("tool-kpi-pending-sub").textContent = `已拒绝 ${fmtNum(s.staging.rejected)}`;
  $("tool-kpi-gap").textContent = fmtNum(s.gap);

  const ratio = s.candidates > 0 ? Math.round((s.qualified / s.candidates) * 100) : 0;
  $("tool-kpi-gap-sub").textContent = `达标率 ${ratio}% · 快照 ${fmtTime(s.generatedAt)}`;
}

function kindLabelOf(kind: string): string {
  switch (kind) {
    case "fetch":
      return "抓取";
    case "enrich":
      return "富化";
    case "audit":
      return "重判";
    case "publish":
      return "发布";
    default:
      return kind;
  }
}

function renderJobs(jobs: Job[]): void {
  const box = $("tools-jobs");
  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。点上面的「开始抓取」会在这里显示进度。</p>`;
    return;
  }

  schedulePolling(jobs.some((j) => j.status === "queued" || j.status === "running"));

  box.innerHTML = jobs
    .map((job) => {
      const badge = statusBadge(job.status);
      const params = (() => {
        try {
          const p = JSON.parse(job.params) as Record<string, unknown>;
          if (job.kind === "fetch") {
            const order = p.order === "votes" ? "按点赞" : "最新";
            return `${p.count ?? "?"} 个 · ${order}${p.enrich ? " · 补流量" : ""}`;
          }
          if (job.kind === "enrich") {
            const n = Array.isArray(p.domains) ? p.domains.length : Number(p.limit ?? 0);
            return n ? `富化 ${n} 条` : "富化已确认条目";
          }
          if (job.kind === "audit") {
            return `${p.traffic ? "刷新流量" : "不刷流量"} · ${p.probe ? "探活" : "不探活"}`;
          }
          return typeof p.note === "string" && p.note ? p.note : "合并待发布 → 榜单";
        } catch {
          return kindLabelOf(job.kind);
        }
      })();
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : "—";
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-14 shrink-0 text-ink-muted">${kindLabelOf(job.kind)}</span>
          <span class="min-w-0 flex-1 truncate text-ink-secondary">${esc(params)}</span>
          <span class="shrink-0 rounded-full px-2 py-0.5 font-semibold ${badge.cls}">${badge.label}</span>
          <span class="w-24 shrink-0 text-right text-ink-muted">${fmtTime(job.created_at)}</span>
          <span class="w-10 shrink-0 text-right">${link}</span>
        </div>`;
    })
    .join("");
}

function renderStaging(data: StagingResp): void {
  state.staging = data;

  const meta = $("tools-staging-meta");
  if (!data.pending) {
    meta.textContent = "队列为空。抓取一次后，新工具会先进到这里等你审核。";
  } else {
    const last = data.lastRun
      ? `｜上次 +${data.lastRun.added}${fmtTime(data.lastRun.at)}`
      : "";
    meta.textContent =
      `待确认 ${data.pending} · 已确认 ${data.approved} · 可发榜 ${data.enriched} · 已拒绝 ${data.rejected}` +
      `｜筛选后 ${data.total} 个${last}`;
  }

  // 选中项只保留当前列表里还存在的，避免删改后残留
  const visible = new Set(data.items.map((r) => r.domain));
  for (const d of state.selected) if (!visible.has(d)) state.selected.delete(d);
  const all = $("tools-select-all") as HTMLInputElement | null;
  if (all) all.checked = data.items.length > 0 && data.items.every((r) => state.selected.has(r.domain));

  const body = $("tools-staging-body");
  if (!data.items.length) {
    body.innerHTML = `<tr><td colspan="9" class="px-4 py-10 text-center text-xs text-ink-muted">没有符合条件的条目</td></tr>`;
  } else {
    body.innerHTML = data.items
      .map((row) => {
        const checked = state.selected.has(row.domain) ? " checked" : "";
        const reason = row.rejected ? "已拒绝：不再抓取" : (row.reason ?? "—");
        const missing =
          row.stage === "approved" || row.stage === "enriched"
            ? row.fieldGaps.length
              ? `${row.fieldGaps.length} 项`
              : "完整"
            : "—";
        return `<tr class="transition hover:bg-surface-2/50">
            <td class="px-2 py-2.5">
              <input type="checkbox" data-tool-select="${esc(row.domain)}" class="h-3.5 w-3.5 rounded border-border"${checked} aria-label="选择 ${esc(row.name)}" />
            </td>
            <td class="max-w-[240px] px-4 py-2.5">
              <button type="button" data-tool-open="${esc(row.domain)}" class="block max-w-full truncate text-left font-medium text-ink hover:text-primary">${esc(row.name)}</button>
              <div class="mt-0.5 max-w-full truncate text-[11px] text-ink-muted">${esc(row.description ?? "")}</div>
            </td>
            <td class="px-4 py-2.5 text-xs text-ink-secondary">${esc(row.domain)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${fmtNum(row.phUpvotes)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${fmtVisits(row.monthlyVisits)}</td>
            <td class="max-w-[200px] px-4 py-2.5">
              ${tierBadge(row.tier)}
              <div class="mt-1 max-w-full truncate text-[11px] text-ink-muted" title="${esc(reason)}">${esc(reason)}</div>
            </td>
            <td class="px-4 py-2.5">${stageBadge(row.stage)}</td>
            <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${missing}</td>
            <td class="whitespace-nowrap px-4 py-2.5 text-right">
              <button type="button" data-tool-open="${esc(row.domain)}" class="text-xs text-primary hover:underline">详情</button>
              <button type="button" data-tool-reject="${esc(row.domain)}" data-tool-rejected="${row.rejected}" class="ml-3 text-xs text-ink-muted transition hover:text-danger">${row.rejected ? "恢复" : "拒绝"}</button>
            </td>
          </tr>`;
      })
      .join("");
  }

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  $("tools-staging-pager").innerHTML = `<span>第 ${data.page} / ${pages} 页</span>
      <span class="flex gap-3">
        <button type="button" data-tool-page="${data.page - 1}" ${data.page <= 1 ? 'class="cursor-not-allowed opacity-40" disabled' : 'class="text-primary hover:underline"'}>上一页</button>
        <button type="button" data-tool-page="${data.page + 1}" ${data.page >= pages ? 'class="cursor-not-allowed opacity-40" disabled' : 'class="text-primary hover:underline"'}>下一页</button>
      </span>`;
}

/** 下榜清单：存量重判的产出，没跑过就明确说「未知」而不是显示 0 */
function renderAudit(audit: PreviewResp["audit"]): void {
  const box = $("tools-audit");
  if (!box) return;

  if (!audit) {
    box.innerHTML = `<p class="text-ink-muted">还没重判过存量，下榜清单未知。点「重判存量」体检已在榜的条目，找出站点失效或流量跌破 1,000 的，再决定是否随本次发布一起下架。</p>`;
    return;
  }

  const head = `<p class="mb-1 font-medium text-ink">榜单变化（存量 ${fmtNum(audit.total)} 条）</p>`;
  const mode = `${audit.refreshedTraffic ? "已刷新流量" : "未刷新流量"}／${audit.probed ? "已探活" : "未探活"}`;

  if (!audit.dropCount) {
    const degraded = audit.degraded.length
      ? `<p class="mt-1 text-[11px] text-ink-muted">降级 ${audit.degraded.length} 条（主榜→观察）：${audit.degraded
          .slice(0, 6)
          .map((d) => esc(d.domain))
          .join("、")}</p>`
      : "";
    box.innerHTML = `${head}<p class="text-accent">没有条目需要下榜。</p>${degraded}<p class="mt-1 text-[11px] text-ink-muted">${mode}</p>`;
    return;
  }

  const rows = audit.dropped
    .map(
      (d) => `<div class="flex items-start justify-between gap-3 py-0.5">
        <span class="text-ink-secondary">${esc(d.domain)}</span>
        <span class="text-right text-[11px] text-danger">${esc(d.reason)}</span>
      </div>`,
    )
    .join("");

  box.innerHTML = `${head}<p class="mb-1 text-danger">将下榜 ${audit.dropCount} 条：</p>${rows}${
    audit.dropCount > audit.dropped.length
      ? `<p class="mt-1 text-[11px] text-ink-muted">… 其余 ${audit.dropCount - audit.dropped.length} 条见 content/tools-audit.json</p>`
      : ""
  }<p class="mt-1 text-[11px] text-ink-muted">${mode}</p>`;
}

function renderPreview(data: PreviewResp): void {
  const btn = $("tools-publish-btn");
  const text = $("tools-publish-preview");

  renderAudit(data.audit);

  const picked = state.selected.size;

  if (!data.pending) {
    text.textContent = data.approved
      ? `已确认 ${data.approved} 个还没富化，先点「开始富化」。`
      : "没有已富化的条目：候选 → 确认收录 → 富化 → 才能发榜。";
    btn.setAttribute("disabled", "true");
    return;
  }

  btn.removeAttribute("disabled");

  const e = data.estimate;
  const parts = [
    picked ? `已选 ${picked} 个，将只发布其中已富化的条目` : `将发布全部 ${data.pending} 个已富化条目`,
  ];
  if (e) {
    if (e.dropCount) parts.push(`同时下榜 ${e.dropCount} 条`);
    if (e.listedAfter !== undefined) {
      parts.push(`榜单 ${fmtNum(e.listedBefore)} → ${fmtNum(e.listedAfter)} 条`);
    }
  }
  const tail = data.audit ? "，发布后自动触发站点构建。" : "。下榜清单还没算，建议先点「重判存量」。";
  text.textContent = parts.join("，") + tail;
}

/** 字段体检面板：空置（补采可修）与异常（必须人工核对）分开看 */
function renderFieldReport(report: FieldReport | null): void {
  const box = $("tools-field-report");
  if (!report || !report.total) {
    box.innerHTML = `<p>还没有富化结果。确认收录后点「开始富化」，这里会显示各字段的空置与异常统计。</p>`;
    return;
  }

  const rows = report.dimensions
    .map((d) => {
      const invalid = d.invalid ?? 0;
      const invalidRatio = d.invalidRatio ?? 0;
      const missTone =
        d.missingRatio >= 50 ? "text-danger" : d.missingRatio > 0 ? "text-accent" : "text-ink-muted";
      const badTone = invalid > 0 ? "text-danger" : "text-ink-muted";
      return `<div class="flex items-center justify-between gap-3 py-0.5">
          <span class="text-ink-secondary">${esc(d.label)}</span>
          <span class="flex gap-4 tabular-nums">
            <span class="${missTone}">空 ${d.missing}（${d.missingRatio}%）</span>
            <span class="${badTone}">异常 ${invalid}（${invalidRatio}%）</span>
          </span>
        </div>`;
    })
    .join("");

  // 只列异常原因样例：空置的原因一目了然，异常的原因必须给出来才知道怎么修
  const samples = report.dimensions
    .filter((d) => (d.invalid ?? 0) > 0 && d.invalidSamples?.length)
    .flatMap((d) =>
      (d.invalidSamples ?? []).slice(0, 2).map(
        (s) => `<div class="flex items-start justify-between gap-3 py-0.5">
            <span class="text-ink-secondary">${esc(s.domain)}</span>
            <span class="text-right text-[11px] text-danger">${esc(d.label)}：${esc(s.reason)}</span>
          </div>`,
      ),
    )
    .join("");

  const entryIssues = (report.entryIssues ?? [])
    .slice(0, 5)
    .map(
      (e) => `<div class="flex items-start justify-between gap-3 py-0.5">
        <span class="text-ink-secondary">${esc(e.domain)}</span>
        <span class="text-right text-[11px] text-danger">${esc(e.label)}：${esc(e.reason)}</span>
      </div>`,
    )
    .join("");

  const worst = [...report.items]
    .sort((a, b) => b.gapCount + (b.issueCount ?? 0) - (a.gapCount + (a.issueCount ?? 0)))
    .slice(0, 5);
  const worstText = worst.length
    ? `<p class="mt-2 text-[11px] text-ink-muted">问题最多：${worst
        .map((i) => `${esc(i.domain)}（空 ${i.gapCount}／异常 ${i.issueCount ?? 0}）`)
        .join("、")}</p>`
    : "";

  const issueBlock =
    samples || entryIssues
      ? `<p class="mb-1 mt-2 font-medium text-ink">需要人工核对的异常</p>${samples}${entryIssues}`
      : "";

  box.innerHTML =
    `<p class="mb-1 font-medium text-ink">字段体检（已确认/已富化 ${report.total} 条` +
    `${report.itemsWithIssues ? `，${report.itemsWithIssues} 条有问题` : ""}）</p>` +
    `<p class="mb-1 text-[11px] text-ink-muted">空置＝没采到，补采可修；异常＝有值但不合法，补采也修不好</p>` +
    rows +
    issueBlock +
    worstText;
}

/* --------------------------------- 加载 --------------------------------- */

async function loadOverview(): Promise<void> {
  try {
    renderOverview(await apiGet<Overview>("/tools/overview"));
  } catch (e) {
    $("tools-setup").classList.remove("hidden");
    $("tools-setup-missing").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadJobs(): Promise<void> {
  try {
    const data = await apiGet<{ jobs: Job[] }>("/tools/jobs?limit=8");
    renderJobs(data.jobs ?? []);
  } catch {
    /* 任务列表失败不阻塞其它区域 */
  }
}

async function loadStaging(): Promise<void> {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: "50",
    tier: state.tier,
  });
  if (state.q) params.set("q", state.q);
  try {
    renderStaging(await apiGet<StagingResp>(`/tools/staging?${params.toString()}`));
  } catch (e) {
    $("tools-staging-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadPreview(): Promise<void> {
  try {
    renderPreview(await apiGet<PreviewResp>("/tools/publish/preview"));
  } catch {
    $("tools-publish-preview").textContent = "发布预览读取失败";
    $("tools-publish-btn").setAttribute("disabled", "true");
  }
  void loadFieldReport();
}

async function loadFieldReport(): Promise<void> {
  try {
    const res = await apiGet<{ report: FieldReport | null }>("/tools/field-report");
    renderFieldReport(res.report);
  } catch {
    renderFieldReport(null);
  }
}

/** 有任务在跑就每 12 秒刷一次，跑完自动停 */
function schedulePolling(shouldRun: boolean): void {
  if (shouldRun && !state.polling) {
    state.polling = window.setInterval(() => {
      void loadJobs();
      void loadOverview();
      void loadStaging();
    }, 12_000);
  } else if (!shouldRun && state.polling) {
    window.clearInterval(state.polling);
    state.polling = undefined;
  }
}

/* -------------------------------- 详情抽屉 -------------------------------- */

interface DetailResp {
  tool: Record<string, unknown> & {
    domain: string;
    name?: string;
    url?: string;
    description?: string;
    phUpvotes?: number;
    categories?: string[];
    firstSeenAt?: string;
    heatScore?: number;
    trafficMetrics?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  };
  tier: "core" | "watch" | null;
  rejected: boolean;
}

function field(label: string, value: string): string {
  return `<div class="flex gap-3 border-b border-border py-2 last:border-b-0">
      <dt class="w-24 shrink-0 text-xs text-ink-muted">${esc(label)}</dt>
      <dd class="min-w-0 flex-1 break-words text-xs text-ink-secondary">${value}</dd>
    </div>`;
}

async function openDetail(domain: string): Promise<void> {
  const box = $("tools-detail");
  state.detailDomain = domain;
  box.classList.remove("hidden");
  box.classList.add("flex");
  $("tools-detail-name").textContent = "加载中…";
  $("tools-detail-domain").textContent = domain;
  $("tools-detail-body").innerHTML = `<p class="text-xs text-ink-muted">正在读取…</p>`;

  try {
    const data = await apiGet<DetailResp>(`/tools/staging/${encodeURIComponent(domain)}`);
    const t = data.tool;
    state.detailRejected = data.rejected;

    $("tools-detail-name").textContent = t.name ?? t.domain;
    $("tools-detail-domain").textContent = t.domain;

    const visits = (t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits) as number | undefined;
    const growth = (t.trafficMetrics?.monthlyVisitsGrowth ?? t.metrics?.momGrowth) as number | undefined;

    const rows = [
      field(
        "链接",
        t.url
          ? `<a href="${esc(t.url)}" target="_blank" rel="noopener" class="text-primary hover:underline">${esc(t.url)}</a>`
          : "—",
      ),
      field("描述", esc(t.description ?? "—")),
      field("收录判定", `${tierBadge(data.tier)}${data.rejected ? ' <span class="ml-1 text-[11px] text-ink-muted">（已拒绝）</span>' : ""}`),
      field("PH 赞", fmtNum(t.phUpvotes ?? 0)),
      field("月访问", fmtVisits(visits)),
      field("环比", typeof growth === "number" ? `${growth > 0 ? "+" : ""}${growth.toFixed(1)}%` : "—"),
      field("分类", (t.categories ?? []).map((c) => esc(c)).join(" · ") || "—"),
      field("首次发现", fmtTime(t.firstSeenAt)),
      field("热度分", fmtNum(t.heatScore)),
    ];

    const metrics = t.trafficMetrics ?? t.metrics;
    const metricRows = metrics
      ? Object.entries(metrics)
          .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
          .map(([k, v]) => field(k, esc(String(v))))
          .join("")
      : "";

    $("tools-detail-body").innerHTML = `<dl>${rows.join("")}</dl>
        ${metricRows ? `<h4 class="mb-1 mt-4 text-xs font-semibold text-ink">流量指标</h4><dl>${metricRows}</dl>` : ""}
        <details class="mt-4">
          <summary class="cursor-pointer text-xs text-ink-muted">原始 JSON</summary>
          <pre class="mt-2 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-secondary">${esc(JSON.stringify(t, null, 2))}</pre>
        </details>`;

    ($("tools-detail-reject") as HTMLButtonElement).textContent = data.rejected
      ? "恢复这个工具"
      : "拒绝这个工具";
  } catch (e) {
    $("tools-detail-body").innerHTML = `<p class="text-xs text-danger">读取失败：${esc(e instanceof Error ? e.message : String(e))}</p>`;
  }
}

function closeDetail(): void {
  const box = $("tools-detail");
  box.classList.add("hidden");
  box.classList.remove("flex");
  state.detailDomain = "";
}

/* -------------------------------- 事件绑定 -------------------------------- */

async function rejectDomains(domains: string[], reject: boolean): Promise<void> {
  await apiPost("/tools/staging/reject", { domains, reject });
}

/** 确认收录 / 取消确认：只改 stage，不花钱、不抓取 */
async function approveDomains(domains: string[], approve: boolean): Promise<void> {
  await apiPost("/tools/staging/approve", { domains, approve });
}

/** 触发富化：DFS 单次 $0.075、单站约 $0.30，所以必须先生成确认再花钱 */
async function enrichDomains(domains: string[]): Promise<void> {
  await apiPost("/tools/enrich", {
    domains,
    limit: Math.max(1, Math.min(domains.length || 10, 20)),
    note: `后台富化 ${domains.length || "全部已确认"} 个`,
  });
}

function bind(): void {
  $("tools-fetch-count").addEventListener("change", updateFetchEstimate);
  $("tools-fetch-enrich").addEventListener("change", updateFetchEstimate);
  updateFetchEstimate();

  $("tools-fetch-btn").addEventListener("click", async () => {
    const btn = $("tools-fetch-btn") as HTMLButtonElement;
    const count = Number(($("tools-fetch-count") as HTMLSelectElement).value);
    const order = ($("tools-fetch-order") as HTMLSelectElement).value;
    const topic =
      ($("tools-fetch-topic") as HTMLInputElement).value.trim() || "artificial-intelligence";
    const enrich = ($("tools-fetch-enrich") as HTMLInputElement).checked;

    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/tools/jobs", { count, order, topic, enrich });
      btn.textContent = "已提交";
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "开始抓取";
      }, 4000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "开始抓取";
      window.alert(`提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-publish-btn").addEventListener("click", async () => {
    const btn = $("tools-publish-btn") as HTMLButtonElement;
    const enabled = state.staging?.enriched ?? 0;
    const picked = [...state.selected];
    const scope = picked.length ? `选中的 ${picked.length} 个` : `全部 ${enabled} 个已富化条目`;
    if (
      !window.confirm(
        `确认发布${scope}？\n未富化的条目不会进榜，发布后触发一次站点构建。`,
      )
    ) {
      return;
    }

    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await apiPost("/tools/publish", { note: `后台发布 ${scope}`, domains: picked });
      state.selected.clear();
      btn.textContent = "已提交";
      void loadJobs();
      void loadStaging();
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

  $("tools-staging-refresh").addEventListener("click", () => {
    void loadStaging();
    void loadPreview();
    void loadOverview();
  });

  ($("tools-staging-tier") as HTMLSelectElement).addEventListener("change", (event) => {
    state.tier = (event.target as HTMLSelectElement).value;
    state.page = 1;
    void loadStaging();
  });

  $("tools-staging-search").addEventListener(
    "input",
    debounce(() => {
      state.q = ($("tools-staging-search") as HTMLInputElement).value.trim();
      state.page = 1;
      void loadStaging();
    }),
  );

  // 表格内容是动态渲染的，统一用事件委托
  $("tools-staging-body").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const open = target.closest<HTMLElement>("[data-tool-open]");
    if (open?.dataset.toolOpen) {
      void openDetail(open.dataset.toolOpen);
      return;
    }

    const reject = target.closest<HTMLElement>("[data-tool-reject]");
    if (reject?.dataset.toolReject) {
      const domain = reject.dataset.toolReject;
      const wasRejected = reject.dataset.toolRejected === "true";
      void rejectDomains([domain], !wasRejected)
        .then(() => {
          void loadStaging();
          void loadPreview();
          void loadOverview();
        })
        .catch((e) => window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`));
    }
  });

  // 勾选（表格内容动态渲染，同样用委托）
  $("tools-staging-body").addEventListener("change", (event) => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-tool-select]");
    if (!input?.dataset.toolSelect) return;
    if (input.checked) state.selected.add(input.dataset.toolSelect);
    else state.selected.delete(input.dataset.toolSelect);
    void loadPreview();
  });

  $("tools-select-all").addEventListener("change", (event) => {
    const on = (event.target as HTMLInputElement).checked;
    state.selected.clear();
    if (on) for (const row of state.staging?.items ?? []) state.selected.add(row.domain);
    void loadStaging();
    void loadPreview();
  });

  $("tools-approve-btn").addEventListener("click", async () => {
    const domains = [...state.selected];
    if (!domains.length) {
      window.alert("先勾选要确认收录的条目");
      return;
    }
    const btn = $("tools-approve-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "提交中…";
    try {
      await approveDomains(domains, true);
      state.selected.clear();
      await loadStaging();
      void loadPreview();
      void loadOverview();
    } catch (e) {
      window.alert(`确认失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "确认收录";
    }
  });

  $("tools-enrich-btn").addEventListener("click", async () => {
    const domains = [...state.selected];
    const count = domains.length || (state.staging?.approved ?? 0);
    if (!count) {
      window.alert("没有待富化的条目：先勾选并「确认收录」");
      return;
    }
    const estimate = (count * 0.3).toFixed(2);
    if (
      !window.confirm(
        `将对 ${count} 个条目做富化（DFS 关键词/外链/竞品 + AI 解读）。\n` +
          `预计花费约 $${estimate}，单条 2–5 分钟，跑完再来这里看字段完整度。`,
      )
    ) {
      return;
    }

    const btn = $("tools-enrich-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "已提交";
    try {
      await enrichDomains(domains);
      state.selected.clear();
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "开始富化";
        void loadStaging();
        void loadPreview();
      }, 6000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "开始富化";
      window.alert(`富化提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-audit-btn").addEventListener("click", async () => {
    if (
      !window.confirm(
        "将重新查询已在榜条目的流量并做存活探测（约 5 分钟，花费约 $0.002）。\n" +
          "跑完这里会显示「将下榜 N 条」，不会自动删除任何条目。",
      )
    ) {
      return;
    }
    const btn = $("tools-audit-btn") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "已提交";
    try {
      await apiPost("/tools/audit", {});
      void loadJobs();
      window.setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "重判存量";
        void loadPreview();
      }, 6000);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "重判存量";
      window.alert(`重判提交失败：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  $("tools-staging-pager").addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLElement>("[data-tool-page]");
    const page = Number(btn?.dataset.toolPage);
    if (!page || page === state.page) return;
    state.page = page;
    void loadStaging();
  });

  $("tools-detail-close").addEventListener("click", closeDetail);
  $("tools-detail").addEventListener("click", (event) => {
    if (event.target === $("tools-detail")) closeDetail();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.detailDomain) closeDetail();
  });

  $("tools-detail-reject").addEventListener("click", async () => {
    const domain = state.detailDomain;
    if (!domain) return;
    const btn = $("tools-detail-reject") as HTMLButtonElement;
    btn.disabled = true;
    try {
      await rejectDomains([domain], !state.detailRejected);
      closeDetail();
      void loadStaging();
      void loadPreview();
      void loadOverview();
    } catch (e) {
      window.alert(`操作失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      btn.disabled = false;
    }
  });
}

/* --------------------------------- 入口 --------------------------------- */

/** 首次切到页签时挂载；重复调用只刷新数据 */
export function mountAdminTools(): void {
  if (state.mounted) {
    void loadOverview();
    void loadJobs();
    void loadStaging();
    void loadPreview();
    return;
  }

  state.mounted = true;
  bind();
  void loadOverview();
  void loadJobs();
  void loadStaging();
  void loadPreview();
}