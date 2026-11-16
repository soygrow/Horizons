/**
 * 后台「工具榜 → 线上榜单」页签。
 *
 * 与「数据抓取」严格分家：这里只认 kind=refresh 的条目，
 * 那边的候选池、待发布新条目一条都不会出现在这张表里。
 *
 * 数据来源是 D1 当前版本快照（/tools/listed），不是 content/aitools.json ——
 * 后者 7.7MB，浏览器和 Worker 都不该去读它。
 *
 * 更新链路（全部复用新条目那套采集代码，没有第二套逻辑）：
 *   勾选 → POST /tools/refresh → Actions 里 refresh-prepare 回填工作区
 *   → enrich-staging → enrich-site → collectSite()
 *   → 结果落「更新待审核」，对比新旧数值后点「发布更新」才会覆盖线上
 */
import { $, apiGet, apiPost, debounce, esc, fmtTime } from "./admin-shared";

/* --------------------------------- 类型 --------------------------------- */

type ListState = "stale" | "updated" | "nodata";

interface ListedItem {
  domain: string;
  name: string;
  url: string | null;
  rank: number;
  tier: string | null;
  monthlyVisits: number | null;
  /** 上月访问量，API 用环比倒推（流量源只给本月值 + 环比） */
  prevVisits: number | null;
  /** 月环比增长 % */
  growth: number | null;
  snapshotMonth: string | null;
  analyzedAt: string | null;
  collectedAt: string | null;
  heatScore: number;
  state: ListState;
}

interface ListedResp {
  version: string;
  target: string;
  total: number;
  all?: number;
  stale?: number;
  updated?: number;
  nodata?: number;
  page: number;
  pageSize: number;
  items: ListedItem[];
  message?: string;
}

interface PendingRow {
  domain: string;
  name: string;
  stage: string;
  monthlyVisits: number | null;
  snapshotMonth?: string | null;
}

interface PendingResp {
  items: PendingRow[];
  refreshPending?: number;
  newPending?: number;
}

/**
 * 与 API 的 MAX_REFRESH_DOMAINS 保持一致：Actions 单 job 60 分钟，
 * 重采一条 60~90 秒，超过 30 条必须拆批。
 */
const BATCH = 30;

const state = {
  mounted: false,
  loaded: false,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  status: "all",
  q: "",
  target: "",
  version: "",
  items: [] as ListedItem[],
  /** 线上旧值，用于「更新待审核」里的新旧对比 */
  oldByDomain: new Map<string, ListedItem>(),
  picked: new Set<string>(),
  pending: [] as PendingRow[],
};

/* -------------------------------- 格式化 -------------------------------- */

function fmtVisits(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString("zh-CN");
}

function fmtMonth(m: string | null | undefined): string {
  return m ? m : "—";
}

/** 热度分：0 表示这条从没算过热度，显示破折号而不是 0.0，免得像是真值 */
function fmtHeat(n: number | null | undefined): string {
  return typeof n === "number" && n > 0 ? n.toFixed(1) : "—";
}

/**
 * 月环比：更新数据后判断「这次抓得对不对」的主要依据。
 *
 * 月翻倍或腰斩在真实流量里不常见，更常见的是抓错了站（同名子域、跳转页）。
 * 所以 ±100% 以上的值标黄而不是按涨跌染色 —— 先当疑似异常看，别直接当利好。
 */
function fmtMom(g: number | null | undefined): string {
  if (typeof g !== "number" || !Number.isFinite(g)) {
    return `<span class="text-ink-muted">—</span>`;
  }
  const text = `${g > 0 ? "+" : ""}${g.toFixed(1)}%`;
  if (Math.abs(g) >= 100) {
    return (
      `<span class="font-semibold tabular-nums text-accent" ` +
      `title="环比 ${text}，波动超过 ±100%，确认一下是不是抓错了站">${text}</span>`
    );
  }
  const cls = g > 0 ? "text-primary" : g < 0 ? "text-danger" : "text-ink-muted";
  return `<span class="tabular-nums ${cls}">${text}</span>`;
}

function stateBadge(s: ListState): string {
  if (s === "updated") {
    return `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">已更新</span>`;
  }
  if (s === "nodata") {
    return `<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted" title="这个站从没抓到过流量，反复跑只会白花钱">无流量</span>`;
  }
  return `<span class="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">未更新</span>`;
}

/** 待审核条目的阶段标签：可发布 / 发布失败可重发 */
function pendingBadge(stage: string): string {
  return stage === "publish_failed"
    ? `<span class="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">发布失败</span>`
    : `<span class="rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary">待发布</span>`;
}

/* -------------------------------- 渲染 -------------------------------- */

function renderMeta(resp: ListedResp): void {
  const meta = $("tools-listed-meta");
  if (resp.message) {
    meta.textContent = resp.message;
    return;
  }
  meta.textContent =
    `当前版本 ${resp.version.slice(0, 10)}｜目标月 ${state.target}｜` +
    `共 ${resp.all ?? resp.total} 条（未更新 ${resp.stale ?? 0} / 已更新 ${resp.updated ?? 0} / 无流量 ${resp.nodata ?? 0}）`;
}

function renderRows(): void {
  const body = $("tools-listed-body");
  if (state.items.length === 0) {
    body.innerHTML = `<tr><td colspan="9" class="px-3 py-8 text-center text-ink-muted">没有符合条件的条目</td></tr>`;
  } else {
    body.innerHTML = state.items
      .map((r) => {
        const checked = state.picked.has(r.domain) ? "checked" : "";
        return `<tr class="hover:bg-surface-2/60">
          <td class="px-3 py-2">
            <input type="checkbox" data-listed-pick="${esc(r.domain)}" ${checked} class="accent-primary" />
          </td>
          <td class="px-3 py-2 tabular-nums text-ink-muted">#${r.rank}</td>
          <td class="px-3 py-2">
            <div class="font-medium">${esc(r.name)}</div>
            <div class="text-[11px] text-ink-muted">${esc(r.domain)}</div>
          </td>
          <td class="px-3 py-2 text-right">
            <div class="tabular-nums">${fmtVisits(r.monthlyVisits)}</div>
            ${
              r.prevVisits != null
                ? `<div class="text-[11px] tabular-nums text-ink-muted">上月 ${fmtVisits(r.prevVisits)}</div>`
                : ""
            }
          </td>
          <td class="px-3 py-2 tabular-nums">${fmtMonth(r.snapshotMonth)}</td>
          <td class="px-3 py-2 text-right">${fmtMom(r.growth)}</td>
          <td class="px-3 py-2 text-right tabular-nums text-ink-muted">${fmtHeat(r.heatScore)}</td>
          <td class="px-3 py-2 text-ink-muted">${r.analyzedAt ? fmtTime(r.analyzedAt) : "—"}</td>
          <td class="px-3 py-2">${stateBadge(r.state)}</td>
        </tr>`;
      })
      .join("");
  }

  $("tools-listed-page").textContent = `${state.page} / ${state.totalPages}`;
  ($("tools-listed-prev") as HTMLButtonElement).disabled = state.page <= 1;
  ($("tools-listed-next") as HTMLButtonElement).disabled = state.page >= state.totalPages;
  syncPicked();
}

function syncPicked(): void {
  const n = state.picked.size;
  const picked = $("tools-listed-picked");
  picked.textContent =
    n === 0 ? "已选 0 条" : `已选 ${n} 条（${Math.ceil(n / BATCH)} 批，约 ${n * 80} 秒）`;
  ($("tools-listed-refresh-btn") as HTMLButtonElement).disabled = n === 0;
}

function renderPending(): void {
  const list = $("tools-refresh-list");
  const meta = $("tools-refresh-meta");
  const btn = $("tools-refresh-publish") as HTMLButtonElement;
  const badge = $("tools-refresh-badge");

  if (state.pending.length === 0) {
    list.innerHTML = "";
    meta.textContent = "还没有重采结果。在下方列表勾选条目后点「更新数据」。";
    btn.disabled = true;
    badge.classList.add("hidden");
    return;
  }

  const failed = state.pending.filter((r) => r.stage === "publish_failed").length;
  meta.textContent = `${state.pending.length} 条已重采完成${failed ? `（${failed} 条发布失败可重发）` : ""}，点名字可看对比，确认后点「发布更新」`;
  badge.textContent = String(state.pending.length);
  badge.classList.remove("hidden");
  btn.disabled = false;

  list.innerHTML = state.pending
    .map((r) => {
      const old = state.oldByDomain.get(r.domain.toLowerCase());
      const beforeVisits = fmtVisits(old?.monthlyVisits);
      const afterVisits = fmtVisits(r.monthlyVisits);
      const beforeMonth = fmtMonth(old?.snapshotMonth);
      const afterMonth = fmtMonth(r.snapshotMonth ?? null);
      // 用颜色标出「确实变了」，没变的条目一眼看出来是先不急着发的
      const changed = beforeVisits !== afterVisits || beforeMonth !== afterMonth;
      return `<div class="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs">
        <div class="min-w-0">
          <span class="font-medium">${esc(r.name)}</span>
          <span class="ml-2 text-[11px] text-ink-muted">${esc(r.domain)}</span>
          ${pendingBadge(r.stage)}
        </div>
        <div class="flex items-center gap-2 tabular-nums ${
          changed ? "text-ink" : "text-ink-muted"
        }">
          <span>${beforeVisits} → <strong>${afterVisits}</strong></span>
          <span class="text-ink-muted">${beforeMonth} → ${afterMonth}</span>
        </div>
      </div>`;
    })
    .join("");
}

/* -------------------------------- 加载 -------------------------------- */

async function loadListed(): Promise<void> {
  try {
    const resp = await apiGet<ListedResp>(
      `/tools/listed?page=${state.page}&pageSize=${state.pageSize}` +
        `&status=${encodeURIComponent(state.status)}&q=${encodeURIComponent(state.q)}`,
    );
    state.target = resp.target;
    state.version = resp.version;
    state.items = resp.items;
    state.totalPages = Math.max(1, Math.ceil(resp.total / resp.pageSize));
    // 旧值只缓存一次就够：同一条目的线上值在这次会话里不会变（除非发布）
    for (const it of resp.items) state.oldByDomain.set(it.domain.toLowerCase(), it);
    renderMeta(resp);
    renderRows();
  } catch (e) {
    $("tools-listed-meta").textContent = `读取失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function loadPending(): Promise<void> {
  try {
    // 只取 refresh 来源：数据抓取那边的待发新条目与这里完全隔离
    const resp = await apiGet<PendingResp>(`/tools/staging?source=refresh&page=1&pageSize=50`);
    state.pending = resp.items.filter(
      (r) => r.stage === "enriched" || r.stage === "publish_failed",
    );
    renderPending();
  } catch {
    // 待审核区块读不到不该影响主列表，静默即可
  }
}

async function refreshAll(): Promise<void> {
  // 待审核要先拿到线上旧值才能做对比，顺序不能反
  await loadListed();
  await loadPending();
}

/* -------------------------------- 交互 -------------------------------- */

function bind(): void {
  document.querySelectorAll<HTMLElement>("[data-tools-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.toolsView;
      document
        .querySelectorAll<HTMLElement>("[data-tools-view]")
        .forEach((b) => b.dataset.active = String(b === btn));
      $("tools-view-fetch").hidden = view !== "fetch";
      $("tools-view-listed").hidden = view !== "listed";
      if (view === "listed") void refreshAll();
    });
  });

  $("tools-listed-status").addEventListener("change", () => {
    state.status = ($("tools-listed-status") as HTMLSelectElement).value;
    state.page = 1;
    void loadListed();
  });

  $("tools-listed-search").addEventListener(
    "input",
    debounce(() => {
      state.q = ($("tools-listed-search") as HTMLInputElement).value.trim();
      state.page = 1;
      void loadListed();
    }, 300),
  );

  $("tools-listed-body").addEventListener("change", (event) => {
    const box = (event.target as HTMLElement).closest<HTMLInputElement>("[data-listed-pick]");
    if (!box) return;
    const domain = box.dataset.listedPick;
    if (!domain) return;
    if (box.checked) state.picked.add(domain);
    else state.picked.delete(domain);
    syncPicked();
  });

  $("tools-listed-selectpage").addEventListener("click", () => {
    // 再点一次是「取消本页」，避免误选后只能一个个取消
    const allPicked = state.items.every((r) => state.picked.has(r.domain));
    for (const r of state.items) {
      if (allPicked) state.picked.delete(r.domain);
      else state.picked.add(r.domain);
    }
    renderRows();
  });

  $("tools-listed-prev").addEventListener("click", () => {
    if (state.page <= 1) return;
    state.page -= 1;
    void loadListed();
  });

  $("tools-listed-next").addEventListener("click", () => {
    if (state.page >= state.totalPages) return;
    state.page += 1;
    void loadListed();
  });

  $("tools-listed-refresh-btn").addEventListener("click", () => {
    void submitRefresh();
  });

  $("tools-refresh-publish").addEventListener("click", () => {
    void publishRefresh();
  });
}

async function submitRefresh(): Promise<void> {
  const domains = [...state.picked];
  if (domains.length === 0) return;

  const collect = ($("tools-opt-collect") as HTMLInputElement).checked;
  const rewrite = ($("tools-opt-rewrite") as HTMLInputElement).checked;
  if (!collect && !rewrite) {
    window.alert("「重新采集」和「重跑文案」至少选一个，否则什么都不会发生");
    return;
  }

  const batches = Math.ceil(domains.length / BATCH);
  const minutes = Math.ceil((domains.length * 80) / 60);
  const jobs = collect && rewrite ? "重新采集 + 重跑文案" : collect ? "只重新采集" : "只重跑文案";
  if (
    !window.confirm(
      `将更新 ${domains.length} 条（${jobs}）。\n` +
        `预计 ${minutes} 分钟${batches > 1 ? `，分 ${batches} 批串行排队` : ""}。\n\n` +
        `结果先进「更新待审核」，不会直接改线上。\n\n确认提交？`,
    )
  ) {
    return;
  }

  const btn = $("tools-listed-refresh-btn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    await apiPost("/tools/refresh", { domains, collect, rewrite });
    state.picked.clear();
    renderRows();
    $("tools-refresh-meta").textContent =
      `已提交 ${domains.length} 条，预计 ${minutes} 分钟。跑完会自动出现在这里，「数据抓取」那边不会出现这些条目。`;
    // Actions 起跑要十几秒，先给个反馈再定时拉
    window.setTimeout(() => void refreshAll(), 30_000);
  } catch (e) {
    window.alert(`提交失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    btn.disabled = false;
  }
}

async function publishRefresh(): Promise<void> {
  const n = state.pending.length;
  if (n === 0) return;
  if (
    !window.confirm(
      `将发布 ${n} 条更新，覆盖线上同名条目（未重采的字段保持原值）。\n` +
        `发布后榜单会按最新流量重新排名，并触发站点重建。\n\n确认发布？`,
    )
  ) {
    return;
  }

  const btn = $("tools-refresh-publish") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "已提交";
  try {
    // 不传 domains：脚本会按 --kind refresh 自己挑，不会碰到新条目
    await apiPost("/tools/publish", { kind: "refresh", note: `线上更新 ${n} 条` });
    $("tools-refresh-meta").textContent = "发布任务已提交，跑完会从「更新待审核」消失。";
    window.setTimeout(() => void refreshAll(), 30_000);
  } catch (e) {
    btn.disabled = false;
    window.alert(`发布失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    window.setTimeout(() => {
      btn.textContent = "发布更新";
    }, 8000);
  }
}

/* -------------------------------- 入口 -------------------------------- */

/** 首次切到「线上榜单」时挂载；重复调用只刷新数据 */
export function mountToolsListed(): void {
  if (state.mounted) {
    if (state.loaded) void refreshAll();
    return;
  }
  state.mounted = true;
  bind();
  // 面板默认是 hidden 的，点开时再拉数据，避免一进「工具榜」就打三个接口
}