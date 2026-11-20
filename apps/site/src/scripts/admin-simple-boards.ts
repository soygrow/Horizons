/**
 * 后台「模型榜」「机会榜」页签。
 *
 * 两个榜结构不同，所以分开实现：
 *   - 模型榜照 GitHub 榜的页面模式来 —— 运行记录 + 「采集同步 / 线上榜单」两个子页签，
 *     线上榜单能搜索、按厂商筛、勾选若干条「更新选中」，采完自动增量写库；
 *   - 机会榜是人工策展文件，只做「看线上是什么 + 触发一次同步」。
 *
 * 模型榜的「更新选中」不去候选池：采集结果直接写进 D1 的当前版本（不落仓库文件），
 * 所以没有「待发布」这一步 —— 勾选的意义只是缩小采集范围，不是缩小发布范围。
 */
import {
  $,
  apiGet,
  apiPost,
  esc,
  fillDaySelect,
  fmtNum,
  fmtStamp,
  fmtTime,
  pickedDataAt,
  versionNote,
  type DataDay,
  type VersionOption,
} from "./admin-shared";

interface Job {
  id: string;
  kind: string;
  status: string;
  params: string;
  run_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface Overview {
  board: string;
  configured: boolean;
  missing: string[];
  publishable: boolean;
  refreshable?: boolean;
  patchable?: boolean;
  version: string | null;
  total: number;
  updatedAt: string | null;
  status: string;
  run: { id: number; url: string; status: string; conclusion: string | null } | null;
  jobs?: Job[];
}

interface Card {
  provider?: string;
  capability?: number;
  batch?: string;
  audience?: string[];
  [key: string]: unknown;
}

interface Item {
  key: string;
  rank: number;
  score: number;
  tier: string;
  name: string;
  url: string | null;
  cats: string[];
  card: Card | null;
}

interface ItemsRes {
  version: string | null;
  page: number;
  size: number;
  total: number;
  pages: number;
  items: Item[];
}

/* ------------------------- 模型榜：线上清单结构 ------------------------- */

interface ListedItem {
  key: string;
  rank: number;
  score: number;
  name: string;
  provider: string | null;
  capability: number | null;
  value: number | null;
  context: number | null;
  priceIn: number | null;
  priceOut: number | null;
  tags: string[];
  /** 这一版数据是哪天采的；老版本卡片里没有这个字段，是 null */
  dataAt: string | null;
  /** 行级数据日（0022 的 data_day 列）：与下拉分组同一口径 */
  dataDay?: string | null;
}

interface ListedRes {
  version: string | null;
  /** 当前生效版本：版本下拉默认停在这 */
  current?: string | null;
  /** 库里还留着的版本（倒序）+ 每版条数 */
  versions?: VersionOption[];
  /** 这一版内部按行级采集日分组：各天条数之和 = total */
  days?: DataDay[];
  total: number;
  items: ListedItem[];
}

const STATUS_LABEL: Record<string, string> = {
  idle: "未运行",
  queued: "排队中",
  running: "运行中",
  success: "已完成",
  failure: "失败",
  cancelled: "已取消",
};

const KIND_LABEL: Record<string, string> = {
  "models-refresh": "定向刷新",
  "models-publish": "增量发布",
};

const PAGE_SIZE = 50;

/** 单次定向刷新的条数上限，与 apps/api 的 MAX_REFRESH 一致 */
const MAX_REFRESH_KEYS = 200;

const num = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "—";

const kTok = (v: number | null): string => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  return v >= 1000 ? `${Math.round(v / 1000)}K` : String(v);
};

const price = (v: number | null): string =>
  typeof v === "number" && Number.isFinite(v) ? (v === 0 ? "免费" : `$${v}`) : "—";

/** 距离采集多少天；null 表示没有可用日期 */
function ageDays(date: string | null): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

/** 「更新时间」列下方的年龄标签，色阶与 GitHub 榜一致 */
function ageNote(age: number | null): string {
  if (age === null) return "";
  return age >= 30
    ? `<span class="text-danger">${age} 天前</span>`
    : age >= 10
      ? `<span class="text-accent">${age} 天前</span>`
      : age >= 7
        ? `<span class="text-ink-secondary">${age} 天前</span>`
        : `<span class="text-ink-muted">${age === 0 ? "今天" : `${age} 天前`}</span>`;
}

/* fmtStamp 对「只到天」的值原样返回，所以模型榜直接用它就够，不会补 00:00:00 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function setStatus(prefix: string, text: string, tone: "idle" | "busy" | "ok" | "bad"): void {
  const el = $(`${prefix}-status`);
  if (!el) return;
  el.innerHTML = text;
  el.className =
    tone === "bad"
      ? "mt-3 text-xs text-red-600"
      : tone === "ok"
        ? "mt-3 text-xs text-emerald-600"
        : tone === "busy"
          ? "mt-3 text-xs text-amber-600"
          : "mt-3 text-xs text-ink-muted";
}

function renderKpi(prefix: string, o: Overview): void {
  const total = $(`${prefix}-kpi-total`);
  if (total) total.textContent = fmtNum(o.total);

  const totalSub = $(`${prefix}-kpi-total-sub`);
  if (totalSub) totalSub.textContent = o.version ? `当前版本 ${o.version}` : "还没有发布过";

  // board_stats.updated_at 有时只有日期（YYYY-MM-DD），别给它编一个时间出来
  const updated = o.updatedAt ?? "";
  const updatedEl = $(`${prefix}-kpi-updated`);
  if (updatedEl) {
    updatedEl.textContent = updated
      ? /^\d{4}-\d{2}-\d{2}$/.test(updated)
        ? updated.slice(5)
        : fmtTime(updated)
      : "—";
  }
  const updatedSub = $(`${prefix}-kpi-updated-sub`);
  if (updatedSub) updatedSub.textContent = updated ? "统计刷新时间" : "等待第一次同步";

  const versionEl = $(`${prefix}-kpi-version`);
  if (versionEl) versionEl.textContent = o.version ?? "—";
  const versionSub = $(`${prefix}-kpi-version-sub`);
  if (versionSub) versionSub.textContent = `${o.board} · 读 D1`;
}

/** 运行记录：和 GitHub 榜同一张任务表，按 kind 前缀过滤后统一渲染 */
function renderJobs(o: Overview): void {
  const box = $("mdl-jobs");
  if (!box) return;

  const jobs = o.jobs ?? [];
  if (!jobs.length) {
    box.innerHTML = `<div class="px-5 py-6 text-center text-xs text-ink-muted">还没有运行记录，先触发一次采集或发布</div>`;
    return;
  }

  box.innerHTML = jobs
    .map((j) => {
      const label = KIND_LABEL[j.kind] ?? j.kind;
      const status = STATUS_LABEL[j.status] ?? j.status;
      const tone =
        j.status === "failure"
          ? "text-red-600"
          : j.status === "success"
            ? "text-emerald-600"
            : j.status === "running" || j.status === "queued"
              ? "text-amber-600"
              : "text-ink-muted";

      let detail = "";
      try {
        const p = JSON.parse(j.params ?? "{}") as { keys?: string[]; patch?: boolean };
        if (Array.isArray(p.keys) && p.keys.length) {
          detail = `${p.keys.length} 个：${p.keys.slice(0, 3).join(", ")}${p.keys.length > 3 ? " …" : ""}`;
        } else if (p.patch) {
          detail = "增量写库";
        }
      } catch {
        /* params 是历史数据，解析不了就不显示细节 */
      }

      const link = j.run_url
        ? `<a class="underline" href="${esc(j.run_url)}" target="_blank" rel="noreferrer">日志</a>`
        : "";

      return `<div class="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-xs">
        <div class="min-w-0">
          <span class="font-medium text-ink">${esc(label)}</span>
          ${detail ? `<span class="ml-2 text-ink-muted">${esc(detail)}</span>` : ""}
          ${j.error ? `<span class="ml-2 text-red-600">${esc(j.error.slice(0, 80))}</span>` : ""}
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <span class="${tone}">${esc(status)}</span>
          <span class="tabular-nums text-ink-muted">${fmtTime(new Date(j.created_at).toISOString())}</span>
          ${link}
        </div>
      </div>`;
    })
    .join("");
}

/* ============================== 模型榜 ============================== */

const modelsState = {
  /** 线上全量清单，筛选与分页都在前端做：366 条不值得来回请求 */
  all: [] as ListedItem[],
  filtered: [] as ListedItem[],
  selected: new Set<string>(),
  provider: "all",
  q: "",
  page: 1,
  /** 服务端解析出来的版本（这份数据是哪一版） */
  version: null as string | null,
  /** 看哪一版快照（空 = 当前生效版本），用户在版本下拉里选 */
  listedVersion: "",
  /** 库里还留着的版本 + 每版条数 */
  versions: [] as VersionOption[],
  /** 按数据日筛（空 = 全部）：值形如 2026-11-20 */
  day: "",
  /** 这一版的行级数据日分布 */
  days: [] as DataDay[],
  /** 这一版总条数（下拉的「全部」用它） */
  total: 0,
};

let modelsMounted = false;

function renderListed(): void {
  const body = $("mdl-listed-body");
  const pager = $("mdl-listed-pager");
  const meta = $("mdl-listed-meta");
  const refreshBtn = $("mdl-listed-refresh") as HTMLButtonElement | null;
  if (!body || !pager) return;

  if (meta) {
    /*
     * 选了某个数据日，标题里的版本号就跟着那一天走 —— 否则会出现
     * 「版本 20261120」而下面每行都写着 2026-11-18，正好是用户说的对不上。
     */
    const dayLabel = modelsState.day ? modelsState.day.replace(/-/g, "") : null;
    const head = dayLabel
      ? `版本 ${dayLabel}（按数据日筛选）`
      : versionNote(modelsState.version, pickedDataAt(modelsState));
    meta.textContent = modelsState.version
      ? `${head} · 共 ${fmtNum(modelsState.all.length)} 条 · 筛选后 ${fmtNum(modelsState.filtered.length)} 条`
      : "还没有发布过任何版本";
  }

  const pages = Math.max(1, Math.ceil(modelsState.filtered.length / PAGE_SIZE));
  if (modelsState.page > pages) modelsState.page = pages;
  const rows = modelsState.filtered.slice((modelsState.page - 1) * PAGE_SIZE, modelsState.page * PAGE_SIZE);

  /*
   * 行级采集日优先，回落该版本的发布日。
   *
   * 增量发布只重写变了的行：某天只刷了 50 条时，剩下的行还留着上一次的
   * dataAt —— 一版里混着两个采集日，只有按行取才说得清。历史版本（早于
   * dataAt 落库）卡片里没有这个字段，回落发布日，和下拉里的版本号一致，
   * 而不是整列显示「—」。
   */
  const versionDay = modelsState.version ? modelsState.version.slice(0, 10) : null;

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="10" class="px-4 py-6 text-center text-xs text-ink-muted">没有匹配的模型</td></tr>`;
  } else {
    body.innerHTML = rows
      .map((m) => {
        const checked = modelsState.selected.has(m.key) ? "checked" : "";
        const rowAt = m.dataAt ?? versionDay;
        return `<tr class="hover:bg-surface-2/40">
          <td class="px-3 py-2.5">
            <input type="checkbox" data-pick="${esc(m.key)}" ${checked} class="h-3.5 w-3.5 accent-primary" />
          </td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-muted">${m.rank}</td>
          <td class="max-w-[260px] px-4 py-2.5">
            <div class="truncate font-medium text-ink" title="${esc(m.name)}">${esc(m.name)}</div>
            <div class="truncate font-mono text-[11px] text-ink-muted">${esc(m.key)}</div>
          </td>
          <td class="px-4 py-2.5 text-xs text-ink-secondary">${esc(m.provider ?? "—")}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${num(m.capability)}</td>
          <td class="px-4 py-2.5 text-right text-xs font-medium tabular-nums text-ink">${num(m.score)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${kTok(m.context)}</td>
          <td class="px-4 py-2.5 text-right text-xs tabular-nums text-ink-secondary">${price(m.priceIn)} / ${price(m.priceOut)}</td>
          <td class="whitespace-nowrap px-4 py-2.5 text-xs tabular-nums text-ink-secondary">
            <span class="block" title="这条数据的采集日；老版本没记采集日时用发布日">${esc(fmtStamp(rowAt))}</span>
            ${ageNote(ageDays(rowAt))}
          </td>
          <td class="px-4 py-2.5 text-right">
            <button type="button" data-only="${esc(m.key)}" class="text-[11px] text-primary transition hover:underline disabled:cursor-not-allowed disabled:opacity-40">更新</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  pager.innerHTML = `<span>第 ${modelsState.page} / ${pages} 页</span>
    <span class="flex gap-2">
      <button type="button" data-page="${modelsState.page - 1}" class="rounded-lg border border-border px-2.5 py-1 text-xs transition hover:border-border-strong disabled:opacity-40" ${modelsState.page <= 1 ? "disabled" : ""}>上一页</button>
      <button type="button" data-page="${modelsState.page + 1}" class="rounded-lg border border-border px-2.5 py-1 text-xs transition hover:border-border-strong disabled:opacity-40" ${modelsState.page >= pages ? "disabled" : ""}>下一页</button>
    </span>`;

  pager.querySelectorAll<HTMLButtonElement>("button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = Number(btn.dataset.page);
      if (!Number.isFinite(next) || next < 1) return;
      modelsState.page = next;
      renderListed();
    });
  });

  // 行内勾选：只影响选中集合，不重新渲染整页，避免滚动位置跳走
  body.querySelectorAll<HTMLInputElement>("input[data-pick]").forEach((box) => {
    box.addEventListener("change", () => {
      const key = box.dataset.pick ?? "";
      if (box.checked) modelsState.selected.add(key);
      else modelsState.selected.delete(key);
      syncSelectHead();
    });
  });

  body.querySelectorAll<HTMLButtonElement>("button[data-only]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.only ?? "";
      if (key) void refreshModels([key], { keepSelection: true });
    });
  });

  syncSelectHead();
  if (refreshBtn) {
    const n = modelsState.selected.size;
    /* 提交中重渲染（轮询刷新榜单会走到这）不能把按钮解禁，否则看着像能再点一次 */
    refreshBtn.disabled = refreshInFlight || n === 0;
    refreshBtn.textContent = refreshInFlight ? "提交中…" : n > 0 ? `更新选中（${n}）` : "更新选中";
  }
}

/** 这一行属于哪天（YYYY-MM-DD），和「更新时间」列、下拉项同一口径 */
function itemDay(m: ListedItem): string {
  /*
   * 优先用后端算好的 dataDay（0022 的 data_day 列），与下拉分组同源。
   * 老接口没有这个字段时才回落到卡片上的 dataAt。
   */
  const raw = m.dataDay ?? m.dataAt ?? modelsState.version ?? "";
  return raw.slice(0, 10);
}

function applyFilter(): void {
  const q = modelsState.q.trim().toLowerCase();
  modelsState.filtered = modelsState.all.filter((m) => {
    if (modelsState.day && itemDay(m) !== modelsState.day) return false;
    if (modelsState.provider !== "all" && (m.provider ?? "") !== modelsState.provider) return false;
    if (!q) return true;
    return m.name.toLowerCase().includes(q) || m.key.toLowerCase().includes(q);
  });
  modelsState.page = 1;
  renderListed();
}

function syncSelectHead(): void {
  const head = $("mdl-listed-select-all") as HTMLInputElement | null;
  if (!head) return;
  const pageKeys = modelsState.filtered
    .slice((modelsState.page - 1) * PAGE_SIZE, modelsState.page * PAGE_SIZE)
    .map((m) => m.key);
  const picked = pageKeys.filter((k) => modelsState.selected.has(k)).length;
  head.checked = pageKeys.length > 0 && picked === pageKeys.length;
  head.indeterminate = picked > 0 && picked < pageKeys.length;

  /* 「本页 / 全选」在工具条上，勾满后翻成取消态，和趋势榜、GitHub 榜同一套口径 */
  const cur = $("mdl-listed-pick-current") as HTMLButtonElement | null;
  if (cur) {
    const on = pageKeys.length > 0 && picked === pageKeys.length;
    cur.textContent = on ? "取消本页" : "本页";
    cur.disabled = pageKeys.length === 0;
  }

  const all = $("mdl-listed-pick-page") as HTMLButtonElement | null;
  if (all) {
    const allKeys = modelsState.filtered.map((m) => m.key);
    const on = allKeys.length > 0 && allKeys.every((k) => modelsState.selected.has(k));
    all.textContent = on ? "取消全选" : "全选";
    all.disabled = allKeys.length === 0;
  }
}

async function loadListed(): Promise<void> {
  const body = $("mdl-listed-body");
  try {
    /* 不带 version 就是「当前生效版本」，由服务端解析；选了旧版才带上 */
    const qs = modelsState.listedVersion ? `?version=${encodeURIComponent(modelsState.listedVersion)}` : "";
    const res = await apiGet<ListedRes>(`/models/listed${qs}`);
    modelsState.all = res.items;
    modelsState.version = res.version;
    modelsState.versions = res.versions ?? [];
    /* 下拉按「数据日」分，不按发布版本：一版里可能横跨两次采集，
       各天条数相加才等于总数，且行内更新时间与本项一致 */
    modelsState.days = res.days ?? [];
    modelsState.total = res.total;
    fillDaySelect("mdl-listed-version", modelsState.days, res.total, modelsState.day);

    // 厂商下拉跟着数据走：不写死列表，新厂商出现时自动就有
    const sel = $("mdl-listed-provider") as HTMLSelectElement | null;
    if (sel) {
      const providers = [...new Set(res.items.map((m) => m.provider ?? "").filter(Boolean))].sort();
      sel.innerHTML =
        `<option value="all">全部厂商</option>` +
        providers
          .map((p) => `<option value="${esc(p)}"${p === modelsState.provider ? " selected" : ""}>${esc(p)}</option>`)
          .join("");
    }

    applyFilter();
  } catch (e) {
    if (body) {
      body.innerHTML = `<tr><td colspan="10" class="px-4 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
    }
  }
}

/**
 * 提交结果写在榜单面板自己的状态行里。
 *
 * 原来写的是 `#mdl-status`，那个元素在「采集同步」子页签里 —— 用户站在
 * 「线上榜单」点「更新选中」，无论成功还是失败都看不到一个字，感觉就是
 * 点了没反应。
 */
function setListedStatus(text: string, tone: "idle" | "busy" | "ok" | "bad"): void {
  const el = $("mdl-listed-status");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = text;
  const base = "border-b border-border px-4 py-2 text-xs ";
  el.className =
    base +
    (tone === "bad"
      ? "text-red-600"
      : tone === "ok"
        ? "text-emerald-600"
        : tone === "busy"
          ? "text-amber-600"
          : "text-ink-muted");
}

/**
 * 定向刷新是否在提交中。
 *
 * 派发 workflow 是一次网络往返，连点两下就会派发两次采集任务；而且成功
 * 后勾选被清空，第二次点击拿到空数组会静默 return —— 用户看到的就是
 * 「点了没反应」。所以这里锁住整段提交，期间按钮统一置灰。
 */
let refreshInFlight = false;

async function refreshModels(keys: string[], opts: { keepSelection?: boolean } = {}): Promise<void> {
  if (refreshInFlight) return;
  const keepSelection = opts.keepSelection === true;

  const btn = $("mdl-listed-refresh") as HTMLButtonElement | null;
  if (!keys.length) {
    setListedStatus("先勾选要更新的模型，再点「更新选中」", "idle");
    return;
  }
  /* 和后端 MAX_REFRESH 对齐：超了必被拒，别白等一次往返 */
  if (keys.length > MAX_REFRESH_KEYS) {
    setListedStatus(
      `一次最多 ${MAX_REFRESH_KEYS} 个，当前选了 ${keys.length} 个 —— 点「本页」勾选，分批提交`,
      "bad",
    );
    return;
  }

  refreshInFlight = true;
  const idleLabel = btn?.textContent ?? "更新选中";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "提交中…";
  }
  /* 行内「更新」走同一个提交，一起置灰，别让人以为还能再点一次 */
  const rowBtns = [...document.querySelectorAll<HTMLButtonElement>("button[data-only]")];
  rowBtns.forEach((b) => (b.disabled = true));
  setListedStatus(`正在提交 ${keys.length} 个模型的定向刷新…`, "busy");

  try {
    const res = await apiPost<{ count?: number; run?: { url?: string } | null }>("/models/refresh", { keys });
    if (!keepSelection) modelsState.selected.clear();
    /* 勾选变了就得重渲染：不然复选框还打着勾、按钮还写着「更新选中（50）」 */
    renderListed();

    const link = res.run?.url
      ? ` · <a class="underline" href="${esc(res.run.url)}" target="_blank" rel="noreferrer">查看运行</a>`
      : "";
    setListedStatus(`已提交 ${keys.length} 个模型的刷新，跑完会自动增量写库${link}`, "ok");
    pollModels(10);
  } catch (e) {
    /* 失败时勾选留着：改完配置可以直接再点一次，不用重新勾 50 个 */
    setListedStatus(`提交失败：${esc(msg(e))}`, "bad");
    if (btn) {
      btn.disabled = modelsState.selected.size === 0;
      btn.textContent = idleLabel;
    }
    rowBtns.forEach((b) => (b.disabled = false));
  } finally {
    refreshInFlight = false;
  }
}

async function publishModels(): Promise<void> {
  const btn = $("mdl-listed-publish-btn") as HTMLButtonElement | null;
  const syncBtn = $("mdl-publish-btn") as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  if (syncBtn) syncBtn.disabled = true;
  setStatus("mdl", "正在触发增量发布…", "busy");

  try {
    const res = await apiPost<{ patch?: boolean }>("/models/publish", { patch: true });
    setStatus("mdl", res.patch === false ? "已提交整版发布，等待启动…" : "已提交增量发布，等待启动…", "busy");
    pollModels(8);
  } catch (e) {
    setStatus("mdl", `触发失败：${esc(msg(e))}`, "bad");
  } finally {
    if (btn) btn.disabled = false;
    if (syncBtn) syncBtn.disabled = false;
  }
}

function pollModels(times = 8): void {
  if (times <= 0) return;
  window.setTimeout(async () => {
    await loadOverview();
    // 任务结束的下一轮顺手把榜单刷一遍：定向刷新会改数据
    if (times === 1) void loadListed();
    pollModels(times - 1);
  }, 5000);
}

async function loadOverview(): Promise<void> {
  try {
    const o = await apiGet<Overview>("/models/overview");
    renderKpi("mdl", o);
    renderJobs(o);

    const label = STATUS_LABEL[o.status] ?? o.status;
    const link = o.run?.url
      ? ` · <a class="underline" href="${esc(o.run.url)}" target="_blank" rel="noreferrer">查看日志</a>`
      : "";
    const tone =
      o.status === "failure" ? "bad" : o.status === "success" ? "ok" : o.status === "idle" ? "idle" : "busy";

    if (!o.publishable) setStatus("mdl", "这个榜还没有流水线，只能本地跑脚本同步", "idle");
    else if (!o.configured) {
      setStatus("mdl", `未配置 GitHub 集成（缺 ${esc(o.missing.join(" / "))}），无法从这里触发同步`, "bad");
    } else {
      setStatus("mdl", `最近一次运行：${esc(label)}${link}`, tone);
    }
  } catch (e) {
    setStatus("mdl", `概览读取失败：${esc(msg(e))}`, "bad");
  }
}

/** 子页签切换：两个面板互斥，按钮用左侧高亮条表达当前在哪一边 */
function switchView(view: "sync" | "listed"): void {
  document.querySelectorAll<HTMLElement>("[data-mdl-panel]").forEach((el) => {
    el.hidden = el.dataset.mdlPanel !== view;
  });

  document.querySelectorAll<HTMLButtonElement>("[data-mdl-view]").forEach((btn) => {
    const active = btn.dataset.mdlView === view;
    btn.className = active
      ? "rounded-t-lg border-b-2 border-primary px-3 py-2 text-xs font-semibold text-primary"
      : "rounded-t-lg border-b-2 border-transparent px-3 py-2 text-xs font-medium text-ink-secondary transition hover:text-ink";
  });

  if (view === "listed") void loadListed();
}

export function mountAdminModels(): void {
  if (modelsMounted) {
    void loadOverview();
    return;
  }
  modelsMounted = true;

  document.querySelectorAll<HTMLButtonElement>("[data-mdl-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.mdlView === "listed" ? "listed" : "sync";
      switchView(view);
    });
  });

  $("mdl-refresh")?.addEventListener("click", () => {
    void loadOverview();
    void loadListed();
  });
  $("mdl-publish-btn")?.addEventListener("click", () => void publishModels());
  $("mdl-listed-publish-btn")?.addEventListener("click", () => void publishModels());

  const search = $("mdl-listed-search") as HTMLInputElement | null;
  search?.addEventListener("input", () => {
    modelsState.q = search.value;
    applyFilter();
  });

  const provider = $("mdl-listed-provider") as HTMLSelectElement | null;
  provider?.addEventListener("change", () => {
    modelsState.provider = provider.value;
    applyFilter();
  });

  /* 选「数据日」= 在前端筛出这一天采的行，数据已经全在手里，不用再请求 */
  const versionSel = $("mdl-listed-version") as HTMLSelectElement | null;
  versionSel?.addEventListener("change", () => {
    modelsState.day = versionSel.value;
    /* 换筛选 = 换一批模型，已勾选的不一定还看得见，清掉免得「更新选中」误伤 */
    modelsState.selected.clear();
    applyFilter();
  });

  const head = $("mdl-listed-select-all") as HTMLInputElement | null;
  head?.addEventListener("change", () => {
    const pageKeys = modelsState.filtered
      .slice((modelsState.page - 1) * PAGE_SIZE, modelsState.page * PAGE_SIZE)
      .map((m) => m.key);
    if (head.checked) pageKeys.forEach((k) => modelsState.selected.add(k));
    else pageKeys.forEach((k) => modelsState.selected.delete(k));
    renderListed();
  });

  $("mdl-listed-pick-current")?.addEventListener("click", () => {
    const pageKeys = modelsState.filtered
      .slice((modelsState.page - 1) * PAGE_SIZE, modelsState.page * PAGE_SIZE)
      .map((m) => m.key);
    const allPicked = pageKeys.length > 0 && pageKeys.every((k) => modelsState.selected.has(k));
    if (allPicked) pageKeys.forEach((k) => modelsState.selected.delete(k));
    else pageKeys.forEach((k) => modelsState.selected.add(k));
    renderListed();
  });

  $("mdl-listed-pick-page")?.addEventListener("click", () => {
    const allKeys = modelsState.filtered.map((m) => m.key);
    const allPicked = allKeys.length > 0 && allKeys.every((k) => modelsState.selected.has(k));
    if (allPicked) allKeys.forEach((k) => modelsState.selected.delete(k));
    else allKeys.forEach((k) => modelsState.selected.add(k));
    renderListed();
  });

  $("mdl-listed-refresh")?.addEventListener("click", () => {
    void refreshModels([...modelsState.selected]);
  });

  void loadOverview();
  void loadListed();
}

/* ============================== 机会榜 ============================== */

interface OppsDef {
  prefix: string;
  api: string;
  unit: string;
  columns: string[];
  row: (item: Item) => string;
}

const oppsDef: OppsDef = {
  prefix: "opp",
  api: "/opps",
  unit: "条机会",
  columns: ["#", "标题", "批次", "需求分", "综合分", "受众"],
  row: (item) => {
    const batch = item.card?.batch ?? "—";
    const audience = item.cats.length ? item.cats.join(" / ") : "—";
    const demand = item.card?.scores as { demand?: number } | undefined;
    return `<td class="px-3 py-2 text-right text-xs tabular-nums text-ink-muted">${item.rank}</td>
      <td class="max-w-[280px] px-3 py-2">
        <div class="truncate font-medium text-ink" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="truncate font-mono text-[11px] text-ink-muted">${esc(item.key)}</div>
      </td>
      <td class="px-3 py-2 font-mono text-xs text-ink-secondary">${esc(batch)}</td>
      <td class="px-3 py-2 text-right text-xs tabular-nums text-ink-secondary">${num(demand?.demand)}</td>
      <td class="px-3 py-2 text-right text-xs font-medium tabular-nums text-ink">${num(item.score)}</td>
      <td class="max-w-[220px] px-3 py-2 text-xs text-ink-muted"><div class="truncate" title="${esc(audience)}">${esc(audience)}</div></td>`;
  },
};

let oppsMounted = false;

function renderOppsItems(res: ItemsRes, goPage: (page: number) => void): void {
  const body = $("opp-list");
  if (!body) return;

  if (!res.items.length) {
    body.innerHTML = `<tr><td colspan="${oppsDef.columns.length}" class="px-3 py-6 text-center text-xs text-ink-muted">还没有${oppsDef.unit}，先触发一次同步</td></tr>`;
  } else {
    body.innerHTML = res.items
      .map((item) => `<tr class="border-t border-border hover:bg-surface-2/40">${oppsDef.row(item)}</tr>`)
      .join("");
  }

  const pager = $("opp-pager");
  if (!pager) return;
  pager.innerHTML = `<span>第 ${res.page} / ${res.pages} 页 · 共 ${fmtNum(res.total)} 条</span>
    <span class="flex gap-2">
      <button type="button" data-page="${res.page - 1}" class="rounded-lg border border-border px-2.5 py-1 text-xs transition hover:border-border-strong disabled:opacity-40" ${res.page <= 1 ? "disabled" : ""}>上一页</button>
      <button type="button" data-page="${res.page + 1}" class="rounded-lg border border-border px-2.5 py-1 text-xs transition hover:border-border-strong disabled:opacity-40" ${res.page >= res.pages ? "disabled" : ""}>下一页</button>
    </span>`;

  pager.querySelectorAll<HTMLButtonElement>("button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = Number(btn.dataset.page);
      if (!Number.isFinite(next) || next < 1) return;
      goPage(next);
    });
  });
}

async function loadOppsOverview(): Promise<void> {
  try {
    const o = await apiGet<Overview>("/opps/overview");
    renderKpi("opp", o);

    const label = STATUS_LABEL[o.status] ?? o.status;
    const link = o.run?.url
      ? ` · <a class="underline" href="${esc(o.run.url)}" target="_blank" rel="noreferrer">查看日志</a>`
      : "";
    const tone =
      o.status === "failure" ? "bad" : o.status === "success" ? "ok" : o.status === "idle" ? "idle" : "busy";

    if (!o.publishable) setStatus("opp", "这个榜还没有流水线，只能本地跑脚本同步", "idle");
    else if (!o.configured) {
      setStatus("opp", `未配置 GitHub 集成（缺 ${esc(o.missing.join(" / "))}），无法从这里触发同步`, "bad");
    } else {
      setStatus("opp", `最近一次运行：${esc(label)}${link}`, tone);
    }
  } catch (e) {
    setStatus("opp", `概览读取失败：${esc(msg(e))}`, "bad");
  }
}

async function loadOppsItems(page: number, goPage: (p: number) => void): Promise<void> {
  try {
    const res = await apiGet<ItemsRes>(`/opps/items?page=${page}&size=50`);
    renderOppsItems(res, goPage);
  } catch (e) {
    const body = $("opp-list");
    if (body) {
      body.innerHTML = `<tr><td colspan="${oppsDef.columns.length}" class="px-3 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
    }
  }
}

export function mountAdminOpps(): void {
  if (oppsMounted) {
    void loadOppsOverview();
    return;
  }
  oppsMounted = true;

  let page = 1;
  const goPage = (next: number): void => {
    page = next;
    void loadOppsItems(page, goPage);
  };

  $("opp-refresh")?.addEventListener("click", () => {
    void loadOppsOverview();
    void loadOppsItems(page, goPage);
  });

  $("opp-publish-btn")?.addEventListener("click", async () => {
    const btn = $("opp-publish-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    setStatus("opp", "正在触发同步…", "busy");
    try {
      await apiPost("/opps/publish", {});
      setStatus("opp", "已提交到 GitHub Actions，正在等待启动…", "busy");
      window.setTimeout(() => void loadOppsOverview(), 5000);
      window.setTimeout(() => void loadOppsItems(1, goPage), 60_000);
    } catch (e) {
      setStatus("opp", `触发失败：${esc(msg(e))}`, "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  void loadOppsOverview();
  void loadOppsItems(page, goPage);
}