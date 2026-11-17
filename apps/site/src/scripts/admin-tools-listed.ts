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
  /** 一句话简介，表格里截断到两行 */
  description: string | null;
  rank: number;
  tier: string | null;
  monthlyVisits: number | null;
  /** 上月访问量，API 用环比倒推（流量源只给本月值 + 环比） */
  prevVisits: number | null;
  /** 月环比增长 % */
  growth: number | null;
  snapshotMonth: string | null;
  /** 流量月版本号：2026-10 → 202610；从没抓到流量为 null */
  snapshotVersion: number | null;
  analyzedAt: string | null;
  collectedAt: string | null;
  heatScore: number;
  state: ListState;
}

interface ListedResp {
  version: string;
  target: string;
  /** 当前该抓到的版本号，如 202610 */
  targetVersion: number;
  /** 榜单里出现过的版本及条数，按版本倒序 */
  versions: { version: number; count: number }[];
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
 *
 * 拆批是前端的责任：API 遇到超过 30 条会直接 400（以前是静默 slice 掉尾巴，
 * 勾 50 条只有 30 条真跑），所以这里的循环必须真的把每一批都发出去。
 */
const BATCH = 30;

const state = {
  mounted: false,
  loaded: false,
  page: 1,
  pageSize: 50,
  totalPages: 1,
  /** 按流量月版本号筛选：all | 202610 | none */
  versionFilter: "all",
  q: "",
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

/**
 * 版本号：流量月去掉横线，2026-10 → 202610。
 *
 * 用数字而不是 '2026-10' 是为了能比较和筛选：202609 < 202610 直接成立，
 * 跨年也不会错（202612 < 202701）。字符串只适合判相等，算差距得先拆年月。
 */
function fmtVersion(v: number | null | undefined): string {
  return typeof v === "number" && v > 0 ? String(v) : "—";
}

/** 2026-10 → 202610；给只有月份字符串的地方（如待审核行）换算版本号 */
function monthToVersion(m: string | null | undefined): number | null {
  if (!m) return null;
  const n = Number(m.replace("-", ""));
  return Number.isFinite(n) && n > 0 ? n : null;
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

/**
 * 通知工具榜层面的「运行记录」刷新。
 *
 * 任务列表的加载与轮询都在 admin-tools.ts（只有看见 running 任务才会开 12 秒轮询）；
 * 这边提交完不发信号的话，顶部那 4 行要等下一次手动刷新/切页签才会出现新任务。
 */
function notifyJobs(): void {
  window.dispatchEvent(new CustomEvent("horizons:jobs-changed"));
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
  // 版本分布直接摊开：每月跑一轮就多一行，比只报「未更新 197 条」有用得多
  const dist = resp.versions.map((v) => `${v.version} ${v.count}`).join(" / ");
  meta.textContent =
    `当前版本 ${resp.version.slice(0, 10)}｜目标 ${resp.targetVersion}｜` +
    `共 ${resp.all ?? resp.total} 条（${dist}${resp.nodata ? ` / 无数据 ${resp.nodata}` : ""}）`;
}

/**
 * 版本下拉：选项来自接口返回的版本清单。
 *
 * 跑过哪几个月就列哪几个，不写死、不用改代码 —— 这是换成版本号筛选的主要好处。
 * 条数直接写在选项里，不点开也知道哪个月还有多少没补。
 */
function fillVersionOptions(resp: ListedResp): void {
  const sel = $("tools-listed-status") as HTMLSelectElement;
  const opts = ['<option value="all">全部版本</option>'];
  for (const v of resp.versions) {
    opts.push(`<option value="${v.version}">${v.version} · ${v.count} 条</option>`);
  }
  if (resp.nodata) opts.push(`<option value="none">无数据 · ${resp.nodata} 条</option>`);
  sel.innerHTML = opts.join("");
  /*
   * 选中的版本可能这次响应里已经不存在了（那个月的条目全被重采掉），
   * 此时 select.value 会是空串，得把筛选条件一起回落，否则列表空着却看不出原因。
   */
  sel.value = state.versionFilter;
  if (sel.value !== state.versionFilter) {
    state.versionFilter = "all";
    sel.value = "all";
  }
}

function renderRows(): void {
  const body = $("tools-listed-body");
  if (state.items.length === 0) {
    body.innerHTML = `<tr><td colspan="10" class="px-3 py-8 text-center text-ink-muted">没有符合条件的条目</td></tr>`;
  } else {
    body.innerHTML = state.items
      .map((r) => {
        const checked = state.picked.has(r.domain) ? "checked" : "";
        /*
         * 访问量副行写「版本 · 上月值」：这个数到底是哪个月的，比单独一列版本号更不容易看错，
         * 也省下一列宽度留给简介。
         */
        const ver = fmtVersion(r.snapshotVersion);
        const prevText = r.prevVisits != null ? `上月 ${fmtVisits(r.prevVisits)}` : "无上月";
        return `<tr data-listed-open="${esc(r.domain)}" class="cursor-pointer align-top transition hover:bg-surface-2/60">
          <td class="px-3 py-2.5 pt-3">
            <input type="checkbox" data-listed-pick="${esc(r.domain)}" ${checked} class="accent-primary" />
          </td>
          <td class="px-3 py-2.5 pt-3 tabular-nums text-ink-muted">#${r.rank}</td>
          <td class="px-3 py-2.5 pt-3">
            <a href="/tools/${esc(r.domain)}" target="_blank" rel="noopener"
               class="block max-w-[170px] truncate font-medium text-primary hover:underline"
               title="在新窗口打开线上详情页">${esc(r.name)}</a>
            <div class="max-w-[170px] truncate text-[11px] text-ink-muted">${esc(r.domain)}</div>
          </td>
          <td class="px-3 py-2.5 pt-3">
            ${
              r.description
                ? `<p class="line-clamp-2 max-w-[300px] text-[11px] leading-[1.45] text-ink-secondary"
                      title="${esc(r.description)}">${esc(r.description)}</p>`
                : `<span class="text-ink-muted">—</span>`
            }
          </td>
          <td class="whitespace-nowrap px-3 py-2.5 pt-3 text-right">
            <div class="font-medium tabular-nums">${fmtVisits(r.monthlyVisits)}</div>
            <div class="text-[11px] tabular-nums text-ink-muted"
                 title="版本 ${ver} = ${esc(fmtMonth(r.snapshotMonth))} 的流量数据">${ver} · ${prevText}</div>
          </td>
          <td class="px-3 py-2.5 pt-3 text-right">${fmtMom(r.growth)}</td>
          <td class="px-3 py-2.5 pt-3 text-right tabular-nums text-ink-muted">${fmtHeat(r.heatScore)}</td>
          <td class="whitespace-nowrap px-3 py-2.5 pt-3 text-ink-muted">${r.analyzedAt ? fmtTime(r.analyzedAt) : "—"}</td>
          <td class="px-3 py-2.5 pt-3">${stateBadge(r.state)}</td>
          <td class="whitespace-nowrap px-3 py-2.5 pt-3">
            <button type="button" data-raw-open="${esc(r.domain)}"
                    class="rounded-md border border-border px-2 py-1 text-[11px] text-ink-muted transition hover:border-border-strong hover:bg-surface-2 hover:text-ink"
                    title="看这个域名最近一次采集的接口原文">原文</button>
          </td>
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
  /*
   * 预览页是构建期产物（/preview 由 D1 工作区导出后静态生成），重采完不会立刻变，
   * 要等富化 workflow 末尾那次 Deploy Site 跑完（约 20 分钟）。不写清楚，
   * 审核员看到「预览还是 9 月、接口返回已是 10 月」只会以为是采集没生效。
   * 下面那行「旧 → 新」读的是库里的卡片，一定是本次采集的最新值。
   */
  meta.textContent =
    `${state.pending.length} 条已重采完成${failed ? `（${failed} 条发布失败可重发）` : ""}，` +
    `下方「旧 → 新」读的是库里最新值；预览页要等构建完成才是新数据，可点右上「刷新预览页」按需构建`;
  badge.textContent = String(state.pending.length);
  badge.classList.remove("hidden");
  btn.disabled = false;

  list.innerHTML = state.pending
    .map((r) => {
      const old = state.oldByDomain.get(r.domain.toLowerCase());
      const beforeVisits = fmtVisits(old?.monthlyVisits);
      const afterVisits = fmtVisits(r.monthlyVisits);
      const beforeMonth = fmtVersion(monthToVersion(old?.snapshotMonth));
      const afterMonth = fmtVersion(monthToVersion(r.snapshotMonth));
      // 用颜色标出「确实变了」，没变的条目一眼看出来是先不急着发的
      const changed = beforeVisits !== afterVisits || beforeMonth !== afterMonth;
      return `<div data-refresh-open="${esc(r.domain)}" class="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-xs hover:bg-surface-2/60">
        <div class="min-w-0">
          <a href="/preview/${esc(r.domain)}" target="_blank" rel="noopener"
             class="font-medium text-primary hover:underline"
             title="在新窗口预览待发布详情页（与线上同一套布局，需管理员登录；页面是构建产物，重采后要点「刷新预览页」构建一次才是新数据）">${esc(r.name)}</a>
          <span class="ml-2 text-[11px] text-ink-muted">${esc(r.domain)}</span>
          ${pendingBadge(r.stage)}
        </div>
        <div class="flex items-center gap-2 tabular-nums ${
          changed ? "text-ink" : "text-ink-muted"
        }">
          <span>${beforeVisits} → <strong>${afterVisits}</strong></span>
          <span class="text-ink-muted">${beforeMonth} → ${afterMonth}</span>
          <button type="button" data-raw-open="${esc(r.domain)}"
                  class="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-ink-secondary transition hover:border-border-strong hover:text-ink"
                  title="看这个域名最近一次采集的接口原文：判断是接口没给这个月，还是我们没取到">接口返回</button>
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
        `&version=${encodeURIComponent(state.versionFilter)}&q=${encodeURIComponent(state.q)}`,
    );
    state.version = resp.version;
    state.items = resp.items;
    state.totalPages = Math.max(1, Math.ceil(resp.total / resp.pageSize));
    // 旧值只缓存一次就够：同一条目的线上值在这次会话里不会变（除非发布）
    for (const it of resp.items) state.oldByDomain.set(it.domain.toLowerCase(), it);
    fillVersionOptions(resp);
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

/* ----------------------------- 预览页重建 ----------------------------- */

interface BuildRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at?: string;
}

const BUILD_RUNNING = new Set(["queued", "requested", "waiting", "pending", "in_progress"]);

/**
 * 构建轮询只留一条链：切页签、点刷新都会重新调 loadBuildState，
 * 不先清掉旧定时器的话，构建期间会叠出好几条 30 秒轮询。
 */
let buildPollTimer: number | undefined;
function scheduleBuildPoll(): void {
  window.clearTimeout(buildPollTimer);
  buildPollTimer = window.setTimeout(() => void loadBuildState(), 30_000);
}

/**
 * 「刷新预览页」按钮的状态。
 *
 * 预览页是构建期产物，重采只改 D1；enrich-tools 的 refresh 批次不再自动构建，
 * 所以「现在能不能看新数据」只能在这里告诉管理员。状态取最近一次 deploy-site run。
 */
async function loadBuildState(): Promise<void> {
  window.clearTimeout(buildPollTimer);
  const box = $("tools-refresh-build-state");
  const btn = $<HTMLButtonElement>("tools-refresh-build");
  if (!box || !btn) return;

  try {
    const { run } = await apiGet<{ run: BuildRun | null }>("/tools/refresh-preview");
    if (!run) {
      box.textContent = "预览页：从未重建";
      btn.disabled = false;
      return;
    }
    if (BUILD_RUNNING.has(run.status)) {
      box.innerHTML = `<a href="${esc(run.html_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">构建中，约 20 分钟</a>`;
      btn.disabled = true;
      // 构建要 20 分钟，别让「构建中」永远挂着：30 秒后自己再看一眼
      scheduleBuildPoll();
      return;
    }
    btn.disabled = false;
    if (run.conclusion === "success") {
      box.textContent = `预览页：${fmtTime(run.created_at)} 构建完成`;
    } else {
      const word = run.conclusion === "cancelled" ? "被取消" : "失败";
      box.innerHTML = `<a href="${esc(run.html_url)}" target="_blank" rel="noopener" class="text-danger hover:underline">上次构建${word}</a>`;
    }
  } catch {
    // 读不到构建状态不影响审核，按钮照常可点
    box.textContent = "";
    btn.disabled = false;
  }
}

async function buildPreview(): Promise<void> {
  if (
    !window.confirm(
      "将重新构建整站以刷新预览页，约 20 分钟。\n" +
        "构建期间线上页面完全不受影响（内容是上一版，和现在一样），只是预览页要等构建完才有新数据。\n\n确认开始？",
    )
  ) {
    return;
  }

  const btn = $<HTMLButtonElement>("tools-refresh-build");
  const box = $("tools-refresh-build-state");
  btn.disabled = true;
  box.textContent = "正在提交…";
  try {
    const { run } = await apiPost<{ run: BuildRun | null }>("/tools/refresh-preview", {});
    box.innerHTML = run
      ? `<a href="${esc(run.html_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">构建中，约 20 分钟</a>`
      : "已提交，稍后自动刷新状态";
    scheduleBuildPoll();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    box.textContent = "";
    window.alert(msg.includes("正在构建") ? msg : `提交失败：${msg}`);
    void loadBuildState();
  }
}

async function refreshAll(): Promise<void> {
  // 待审核要先拿到线上旧值才能做对比，顺序不能反
  await loadListed();
  await loadPending();
  // 构建状态与列表无关，别让它拖慢主列表
  void loadBuildState();
}

/* ----------------------------- 接口原始返回 ----------------------------- */

interface RawRecord {
  source: string;
  period: string | null;
  ok: boolean;
  via: string | null;
  costUsd: number;
  error: string | null;
  fetchedAt: string | null;
  bytes: number;
  /** 原文超出体积上限，只回了月份摘要 */
  payloadOmitted: boolean;
  months: { month: string; visits: number }[];
  payload: unknown;
}

interface RawResp {
  domain: string;
  records: RawRecord[];
  history: { month: string; visits: number; source: string | null }[];
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/**
 * 月份序列摊成一行：审核时最常问的就是「接口到底给到哪个月」，
 * 数字看不出月份，原文一屏放不下，只有这个视图能秒答。
 */
function monthsStrip(months: RawRecord["months"]): string {
  if (months.length === 0) {
    return `<p class="text-[11px] text-ink-muted">原文里没有月度序列字段（这个源只给单点值）</p>`;
  }
  const latest = months[months.length - 1].month;
  const cells = months
    .map((m) => {
      const hot = m.month === latest;
      return `<div class="flex min-w-[78px] flex-col rounded-lg border px-2 py-1 ${
        hot ? "border-primary/40 bg-primary-soft" : "border-border"
      }">
        <span class="text-[10px] ${hot ? "text-primary" : "text-ink-muted"}">${esc(m.month)}</span>
        <span class="tabular-nums ${hot ? "font-semibold text-ink" : "text-ink-secondary"}">${fmtVisits(m.visits)}</span>
      </div>`;
    })
    .join("");
  return `<div class="flex flex-wrap items-center gap-1.5">${cells}</div>`;
}

function rawRecordBlock(r: RawRecord): string {
  const meta = [
    r.period ? `period ${r.period}` : "",
    r.fetchedAt ? fmtTime(r.fetchedAt) : "",
    r.costUsd > 0 ? `$${r.costUsd.toFixed(3)}` : "$0",
    fmtBytes(r.bytes),
    r.via ? `via ${r.via}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const badge = r.ok
    ? `<span class="rounded-full bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold text-primary">成功</span>`
    : `<span class="rounded-full bg-danger-soft px-1.5 py-0.5 text-[10px] font-semibold text-danger">失败</span>`;

  const json =
    r.payload === null
      ? `<p class="mt-2 text-[10px] text-ink-muted">${
          r.payloadOmitted
            ? "原文超过 96 KB，没发回前端；可以用 wrangler d1 直接查 collect_raw"
            : "原文为空或不是 JSON"
        }</p>`
      : `<details class="mt-2">
          <summary class="cursor-pointer text-[11px] text-ink-muted transition hover:text-ink">展开原始 JSON</summary>
          <pre class="mt-2 max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 text-[11px] leading-relaxed whitespace-pre-wrap break-all">${esc(
            JSON.stringify(r.payload, null, 2),
          )}</pre>
        </details>`;

  return `<section class="rounded-xl border border-border">
    <header class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
      <div class="flex items-center gap-1.5"><span class="font-medium">${esc(r.source)}</span>${badge}</div>
      <span class="text-[10px] text-ink-muted">${esc(meta)}</span>
    </header>
    <div class="px-3 py-2">
      ${r.error ? `<p class="mb-2 text-[11px] text-danger">${esc(r.error)}</p>` : ""}
      ${monthsStrip(r.months)}
      ${json}
    </div>
  </section>`;
}

function trafficHistoryBlock(rows: RawResp["history"]): string {
  if (rows.length === 0) {
    return `<p class="rounded-xl border border-dashed border-border px-3 py-2 text-[11px] text-ink-muted">
      traffic_history 里还没有这个域名 —— 趋势图只能靠单点值，月份切换后就会重新数
    </p>`;
  }
  const items = rows
    .map(
      (h) =>
        `<span class="rounded border border-border px-1.5 py-0.5 tabular-nums text-ink-secondary">${esc(h.month)} <strong class="text-ink">${fmtVisits(h.visits)}</strong></span>`,
    )
    .join("");
  return `<section class="rounded-xl border border-border px-3 py-2">
    <p class="text-[11px] text-ink-muted">库里累积的 traffic_history（趋势图读这个，不是接口原文）</p>
    <div class="mt-1.5 flex flex-wrap items-center gap-1.5">${items}</div>
  </section>`;
}

function closeRaw(): void {
  const box = $("raw-json");
  box.classList.add("hidden");
  box.classList.remove("flex");
}

/**
 * 卡片上看到的都是解析后的结果，字段不对劲时无法区分「接口没给」和「我们没取」。
 * 这个抽屉把 collect_raw 原文和解析出的月份摆在一起，判断依据一次给足。
 */
async function showRaw(domain: string): Promise<void> {
  const box = $("raw-json");
  const body = $("raw-json-body");
  $("raw-json-title").textContent = domain;
  $("raw-json-sub").textContent = "读取采集原文…";
  body.innerHTML = `<p class="py-8 text-center text-ink-muted">读取中…</p>`;
  box.classList.remove("hidden");
  box.classList.add("flex");

  try {
    const resp = await apiGet<RawResp>(`/tools/raw?domain=${encodeURIComponent(domain)}`);
    const records = resp.records ?? [];
    $("raw-json-sub").textContent = records.length
      ? `${records.length} 个采集源｜traffic_history ${resp.history.length} 个月`
      : "这个域名还没有采集记录（可能没跑过采集，或被清过）";
    body.innerHTML = [
      records.map(rawRecordBlock).join('<div class="h-2"></div>'),
      trafficHistoryBlock(resp.history),
    ].join("");
  } catch (e) {
    body.innerHTML = `<p class="py-8 text-center text-danger">读取失败：${esc(
      e instanceof Error ? e.message : String(e),
    )}</p>`;
  }
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
    state.versionFilter = ($("tools-listed-status") as HTMLSelectElement).value || "all";
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

  /*
   * 行可点：这条列表的用途是「核对线上到底长什么样」，
   * 勾选框和名字链接各管各的，其余区域整行都算，不用瞄准。
   */
  $("tools-listed-body").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    // 「原文」按钮得先拦下来，否则会被整行点击吃掉，跳去详情页
    const rawDomain = target.closest<HTMLElement>("[data-raw-open]")?.dataset.rawOpen;
    if (rawDomain) {
      void showRaw(rawDomain);
      return;
    }
    if (target.closest("input, a, button")) return;
    const domain = target.closest<HTMLElement>("[data-listed-open]")?.dataset.listedOpen;
    if (domain) window.open(`/tools/${encodeURIComponent(domain)}`, "_blank", "noopener");
  });

  // 待审核整行同理：点一下预览「发布后会是什么样」，不用先点发布再后悔
  $("tools-refresh-list").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const rawDomain = target.closest<HTMLElement>("[data-raw-open]")?.dataset.rawOpen;
    if (rawDomain) {
      void showRaw(rawDomain);
      return;
    }
    if (target.closest("a, button")) return;
    const domain = target.closest<HTMLElement>("[data-refresh-open]")?.dataset.refreshOpen;
    if (domain) window.open(`/preview/${encodeURIComponent(domain)}`, "_blank", "noopener");
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

  $("tools-refresh-build").addEventListener("click", () => {
    void buildPreview();
  });

  $("tools-refresh-publish").addEventListener("click", () => {
    void publishRefresh();
  });

  $("raw-json-close").addEventListener("click", closeRaw);
  $("raw-json").addEventListener("click", (event) => {
    if (event.target === $("raw-json")) closeRaw();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("raw-json").classList.contains("hidden")) closeRaw();
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
  const meta = $("tools-refresh-meta");
  const chunks: string[][] = [];
  for (let i = 0; i < domains.length; i += BATCH) chunks.push(domains.slice(i, i + BATCH));

  btn.disabled = true;
  const submitted: string[] = [];
  const failures: string[] = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const batch = chunks[i];
      // 每批提交要十几秒才返回，多批时不给进度就像卡死了
      if (chunks.length > 1) {
        meta.textContent = `正在提交第 ${i + 1}/${chunks.length} 批（${batch.length} 条）…`;
      }
      try {
        await apiPost("/tools/refresh", { domains: batch, collect, rewrite });
        submitted.push(...batch);
        notifyJobs();
      } catch (e) {
        // 一批失败就停：后面几批大概率同一原因（超限/令牌/配额），
        // 继续发只会堆出一串失败任务，还得逐条排查
        failures.push(`第 ${i + 1} 批（${batch.length} 条）：${e instanceof Error ? e.message : String(e)}`);
        break;
      }
    }
  } finally {
    btn.disabled = false;
  }

  // 只摘掉真正提交上去的勾选：失败那批留着，用户点一下就能重试
  for (const d of submitted) state.picked.delete(d);
  renderRows();

  const remain = domains.length - submitted.length;
  meta.textContent = failures.length
    ? `已提交 ${submitted.length}/${domains.length} 条，${remain} 条未提交。未提交的仍保持勾选，可直接重试。`
    : `已提交 ${submitted.length} 条${chunks.length > 1 ? `（分 ${chunks.length} 批串行）` : ""}，预计 ${minutes} 分钟。跑完会自动出现在这里，「数据抓取」那边不会出现这些条目。`;

  if (failures.length) {
    window.alert(`提交未全部成功：\n${failures.join("\n")}\n\n已完成 ${submitted.length} 条，剩余 ${remain} 条保持勾选。`);
  }

  if (submitted.length) {
    // Actions 起跑要十几秒，先给个反馈再定时拉
    window.setTimeout(() => void refreshAll(), 30_000);
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
    notifyJobs();
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