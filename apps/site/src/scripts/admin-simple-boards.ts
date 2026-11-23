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
  /** 机会榜独有：点了「我在做」且没放弃的人数（doing + shipped） */
  doing?: number;
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
  columns: ["#", "标题", "批次", "需求分", "综合分", "受众", "正在做"],
  row: (item) => {
    const batch = item.card?.batch ?? "—";
    const audience = item.cats.length ? item.cats.join(" / ") : "—";
    const demand = item.card?.scores as { demand?: number } | undefined;
    /* 后台的 key 就是前台路由的 slug，直接跳详情，不必再做一个详情弹窗 */
    const href = `/opportunity/${encodeURIComponent(item.key)}`;
    const doing = item.doing ?? 0;
    return `<td class="px-3 py-2 text-right text-xs tabular-nums text-ink-muted">${item.rank}</td>
      <td class="max-w-[280px] px-3 py-2">
        <a href="${href}" target="_blank" rel="noopener" class="block truncate font-medium text-ink transition hover:text-primary hover:underline" title="${esc(item.name)}">${esc(item.name)}</a>
        <div class="truncate font-mono text-[11px] text-ink-muted">${esc(item.key)}</div>
      </td>
      <td class="px-3 py-2 font-mono text-xs text-ink-secondary">${esc(batch)}</td>
      <td class="px-3 py-2 text-right text-xs tabular-nums text-ink-secondary">${num(demand?.demand)}</td>
      <td class="px-3 py-2 text-right text-xs font-medium tabular-nums text-ink">${num(item.score)}</td>
      <td class="max-w-[200px] px-3 py-2 text-xs text-ink-muted"><div class="truncate" title="${esc(audience)}">${esc(audience)}</div></td>
      <td class="px-3 py-2 text-right text-xs tabular-nums ${doing ? "font-medium text-ink" : "text-ink-muted"}">${doing ? fmtNum(doing) : "—"}</td>`;
  },
};

/** 筛选条件跨分页保持，翻页不该把批次选择丢掉 */
const oppsState = { batch: "", q: "", page: 1 };
let oppsMounted = false;
let oppsJobsTimer = 0;
let oppsSearchTimer = 0;
/** 生成页签里发布完成后要刷线上列表，但那里拿不到 mount 内的 goPage，挂全局一份 */
let oppsGoPage: (page: number) => void = () => {};

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
  const params = new URLSearchParams({ page: String(page), size: "50" });
  if (oppsState.batch) params.set("batch", oppsState.batch);
  if (oppsState.q) params.set("q", oppsState.q);

  try {
    const res = await apiGet<ItemsRes>(`/opps/items?${params.toString()}`);
    renderOppsItems(res, goPage);
  } catch (e) {
    const body = $("opp-list");
    if (body) {
      body.innerHTML = `<tr><td colspan="${oppsDef.columns.length}" class="px-3 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
    }
  }
}

/** 批次下拉：批次是按周累积的，只列线上真有的那些 */
async function loadOppsBatches(): Promise<void> {
  const sel = $("opp-batch") as HTMLSelectElement | null;
  if (!sel) return;

  try {
    const res = await apiGet<{ batches: Array<{ batch: string; count: number }> }>("/opps/batches");
    const keep = sel.value;
    sel.innerHTML =
      `<option value="">全部批次</option>` +
      res.batches
        .map((b) => `<option value="${esc(b.batch)}">${esc(b.batch)}（${b.count}）</option>`)
        .join("");
    sel.value = keep;
  } catch {
    /* 批次拉不到不影响主列表，保持"全部批次"即可 */
  }
}

/** 机会流水线的 job kind → 中文，和别的榜一样用人话显示，不甩 opps-generate */
const OPP_JOB_LABEL: Record<string, string> = {
  "opps-generate": "生成候选",
  "opps-refill": "拒绝补位",
  "opps-publish-batch": "发布批次",
  "opps-publish": "按文件重建",
};

/** 状态文案与 GitHub 榜的运行记录对齐：成功 / 运行中 / 失败 / 已取消 / 排队中 */
function oppJobBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "success":
      return { label: "成功", cls: "bg-emerald-50 text-emerald-700" };
    case "running":
      return { label: "运行中", cls: "bg-amber-50 text-amber-700" };
    case "failure":
      return { label: "失败", cls: "bg-red-50 text-red-600" };
    case "cancelled":
      return { label: "已取消", cls: "bg-surface-2 text-ink-muted" };
    default:
      return { label: "排队中", cls: "bg-amber-50 text-amber-700" };
  }
}

/** 参数转成人话：以前直接把 {"batch":"2026-W48"} 甩在列表里，读不出发生了什么 */
function oppJobDesc(job: Job): string {
  if (job.error) return job.error;
  try {
    const p = JSON.parse(job.params ?? "{}") as {
      batch?: string;
      missing?: number;
      reason?: string;
      patch?: boolean;
    };
    const bits: string[] = [];
    if (p.batch) bits.push(`批次 ${p.batch}`);
    if (typeof p.missing === "number") bits.push(`补 ${p.missing} 条`);
    if (p.reason) bits.push(p.reason);
    if (typeof p.patch === "boolean") bits.push(p.patch ? "增量写库" : "全量写库");
    return bits.join(" · ");
  } catch {
    return job.params ?? "";
  }
}

function renderOppsJobs(jobs: Job[]): void {
  const box = $("opps-jobs");
  if (!box) return;

  if (!jobs.length) {
    box.innerHTML = `<p class="px-4 py-4 text-xs text-ink-muted">还没有任务。生成批次、拒绝补位、发布会在这里显示进度。</p>`;
    return;
  }

  const active = jobs.some((j) => !["success", "failure", "cancelled"].includes(j.status));
  window.clearTimeout(oppsJobsTimer);
  if (active) oppsJobsTimer = window.setTimeout(() => void loadOppsJobs(), 12_000);

  box.innerHTML = jobs
    .map((job) => {
      const badge = oppJobBadge(job.status);
      const link = job.run_url
        ? `<a href="${esc(job.run_url)}" target="_blank" rel="noopener" class="text-primary hover:underline">日志</a>`
        : "—";
      const desc = oppJobDesc(job);
      return `<div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0">
          <span class="w-16 shrink-0 text-ink-muted">${esc(OPP_JOB_LABEL[job.kind] ?? job.kind)}</span>
          <span class="min-w-0 flex-1 truncate text-ink-secondary" title="${esc(desc)}">${esc(desc) || "—"}</span>
          <span class="shrink-0 rounded-full px-2 py-0.5 font-semibold ${badge.cls}">${esc(badge.label)}</span>
          <span class="w-24 shrink-0 text-right text-ink-muted">${fmtTime(job.created_at)}</span>
          <span class="w-10 shrink-0 text-right">${link}</span>
        </div>`;
    })
    .join("");
}

async function loadOppsJobs(): Promise<void> {
  try {
    const res = await apiGet<{ jobs: Job[] }>("/opps/jobs?limit=5");
    renderOppsJobs(res.jobs);
  } catch {
    /* 运行记录是辅助信息，读不到不打扰主流程 */
  }
}

/* ---------------- 机会生成：批次 → 预览 → 拒绝补位 → 发布 ---------------- */

interface OppCard {
  slug?: string;
  title?: string;
  oneLiner?: string;
  batch?: string;
  audience?: string[];
  scores?: Record<string, number>;
  evidence?: Array<{ board?: string; ref?: string; note?: string }>;
}

interface OppStaging {
  batch: string;
  size: number;
  kept: number;
  rejected: number;
  ready: boolean;
  items: OppCard[];
}

/** 与后端一致：批次号必须是 YYYY-Www，形如 2026-W47 */
const OPP_BATCH_RE = /^\d{4}-W\d{2}$/;

/** 当前 ISO 周，形如 2026-W47 —— 批次号输入框的默认值 */
function isoBatch(now = new Date()): string {
  const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function renderOppsPreview(res: OppStaging): void {
  const box = $("opps-preview");
  if (!box) return;

  const head = `<div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-4 py-3">
      <div class="text-xs text-ink-muted">
        批次 <span class="font-mono text-ink">${esc(res.batch)}</span>
        <span class="mx-1">·</span>
        <span class="${res.ready ? "font-medium text-emerald-600" : "font-medium text-amber-600"}">${res.kept}/${res.size} 条可发布</span>
        ${res.rejected ? `<span class="mx-1">·</span>已拒绝 ${res.rejected} 条` : ""}
      </div>
      <button
        data-publish-batch="${esc(res.batch)}"
        type="button"
        class="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        ${res.ready ? "" : "disabled"}
      >
        发布这一批
      </button>
    </div>`;

  if (!res.items.length) {
    box.innerHTML =
      head +
      `<p class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-ink-muted">
        批次 ${esc(res.batch)} 还没有候选，点上面的「生成 5 条」开始。
      </p>`;
    return;
  }

  const cards = res.items
    .map((card, i) => {
      const scores = card.scores ?? {};
      const chips = ["demand", "gap", "feasible", "timing", "monetize"]
        .map(
          (k) =>
            `<span class="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-ink-secondary">${k} <b class="text-ink">${
              scores[k] ?? "—"
            }</b></span>`,
        )
        .join("");
      const evidence = (card.evidence ?? [])
        .map(
          (e) =>
            `<span class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">${esc(
              e.board ?? "?",
            )}:${esc(e.ref ?? "")}</span>`,
        )
        .join("");
      const audience = (card.audience ?? []).join(" / ");

      return `<article class="rounded-2xl border border-border bg-surface p-4">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-semibold text-ink-secondary">${
              i + 1
            }</span>
            <div class="min-w-0 flex-1">
              <h3 class="text-sm font-semibold leading-snug text-ink">
                <a
                  href="/preview/opp/${esc(card.slug ?? "")}"
                  target="_blank"
                  rel="noopener"
                  class="group inline-flex items-baseline gap-1.5 hover:text-primary"
                  title="打开预览：发布后长这样"
                >
                  <span class="min-w-0 group-hover:underline group-hover:underline-offset-2">${esc(card.title ?? "(无标题)")}</span>
                  <span class="shrink-0 text-[11px] font-normal text-ink-muted group-hover:text-primary">预览 ↗</span>
                </a>
              </h3>
              <p class="mt-1 text-xs leading-relaxed text-ink-secondary">${esc(card.oneLiner ?? "")}</p>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">${chips}</div>
              ${evidence ? `<div class="mt-2 flex flex-wrap gap-1.5">${evidence}</div>` : ""}
              ${audience ? `<p class="mt-2 text-[11px] text-ink-muted">受众：${esc(audience)}</p>` : ""}
              <div class="mt-3 flex flex-wrap items-center gap-2">
                <input
                  data-reason-for="${esc(card.slug ?? "")}"
                  placeholder="拒绝原因（可留空，会喂给模型）"
                  class="min-w-[220px] flex-1 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-muted focus:border-primary"
                />
                <button
                  data-reject="${esc(card.slug ?? "")}"
                  data-batch="${esc(res.batch)}"
                  type="button"
                  class="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-secondary transition hover:border-red-300 hover:text-red-600 disabled:opacity-50"
                >
                  拒绝并补位
                </button>
              </div>
            </div>
          </div>
        </article>`;
    })
    .join("");

  box.innerHTML = head + cards;
}

async function loadOppsStaging(batch?: string): Promise<void> {
  const box = $("opps-preview");
  if (!box) return;

  const input = $("opp-gen-batch") as HTMLInputElement | null;
  const target = (batch ?? input?.value ?? "").trim() || isoBatch();
  if (input && !input.value) input.value = target;
  if (!OPP_BATCH_RE.test(target)) {
    box.innerHTML = `<p class="text-xs text-red-600">批次号形如 2026-W47（按 ISO 周）</p>`;
    return;
  }

  try {
    const res = await apiGet<OppStaging>(`/opps/staging?batch=${encodeURIComponent(target)}`);
    renderOppsPreview(res);
  } catch (e) {
    box.innerHTML = `<p class="text-xs text-red-600">读取候选失败：${esc(msg(e))}</p>`;
  }
}

/** 候选还没落库时的占位，避免「生成中」被误读成「什么都没有」 */
function renderOppsPending(batch: string, note: string): void {
  const box = $("opps-preview");
  if (!box) return;
  box.innerHTML = `<p class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-ink-muted">
      批次 <span class="font-mono text-ink">${esc(batch)}</span> · ${esc(note)}
    </p>`;
}

/**
 * 生成/补位期间轮询候选池：模型跑一条要半分钟到一分钟，5 条约 3–6 分钟。
 *
 * 判定完成只认「凑满 5 条」—— 生成是一条条落库的，看到 1 条就停会让人
 * 以为这批只出了 1 条；补位时池子里本来就有 4 条，更不能按条数提前收工。
 */
function pollOppsStaging(batch: string, tries = 0, refill = false): void {
  if (tries > 30) {
    setStatus("opp-gen", "等待超时，去「运行记录」看日志", "bad");
    return;
  }
  window.setTimeout(async () => {
    try {
      const res = await apiGet<OppStaging>(`/opps/staging?batch=${encodeURIComponent(batch)}`);
      if (res.ready) {
        renderOppsPreview(res);
        setStatus("opp-gen", `批次 ${batch} 已${refill ? "补齐" : "生成"} ${res.kept} 条，可以发布了`, "ok");
        return;
      }
      if (res.items.length) renderOppsPreview(res);
      else renderOppsPending(batch, `${refill ? "补位" : "生成"}中，还没有候选落库…`);
      setStatus("opp-gen", `${refill ? "补位" : "生成"}中，已有 ${res.kept}/${res.size} 条`, "busy");
      pollOppsStaging(batch, tries + 1, refill);
    } catch {
      pollOppsStaging(batch, tries + 1, refill);
    }
  }, 20_000);
}

async function rejectOpp(batch: string, slug: string, btn: HTMLElement): Promise<void> {
  const input = document.querySelector<HTMLInputElement>(`[data-reason-for="${CSS.escape(slug)}"]`);
  const reason = input?.value.trim() ?? "";

  btn.setAttribute("disabled", "true");
  setStatus("opp-gen", `拒绝 ${esc(slug)}，正在补位…`, "busy");
  try {
    const res = await apiPost<{ kept: number; missing: number }>("/opps/reject", { batch, slug, reason });
    if (res.missing > 0) {
      setStatus("opp-gen", `已拒绝，正在补 ${res.missing} 条（约 1–2 分钟）`, "busy");
      /* 先按拒绝后的真实状态刷一次，让人看到 4/5，再等补位回到 5/5 */
      await loadOppsStaging(batch);
      pollOppsStaging(batch, 0, true);
    } else {
      setStatus("opp-gen", "已拒绝，本批候选仍满 5 条", "ok");
      await loadOppsStaging(batch);
    }
    void loadOppsJobs();
  } catch (e) {
    setStatus("opp-gen", `拒绝失败：${esc(msg(e))}`, "bad");
    btn.removeAttribute("disabled");
  }
}

async function publishOppsBatch(batch: string, btn: HTMLElement): Promise<void> {
  if (!window.confirm(`确认发布批次 ${batch}？发布后前台机会榜会换成这一批。`)) return;

  btn.setAttribute("disabled", "true");
  setStatus("opp-gen", "正在发布…", "busy");
  try {
    await apiPost("/opps/publish-batch", { batch });
    setStatus("opp-gen", "已提交发布，Actions 跑完会提交文件并自动重建站点", "ok");
    void loadOppsJobs();
    /* 发布是异步的：两分钟后再刷线上列表，不然看到的还是旧批次 */
    window.setTimeout(() => {
      void loadOppsOverview();
      void loadOppsBatches();
      void loadOppsItems(1, oppsGoPage);
    }, 120_000);
  } catch (e) {
    setStatus("opp-gen", `发布失败：${esc(msg(e))}`, "bad");
    btn.removeAttribute("disabled");
  }
}

export function mountAdminOpps(): void {
  const goPage = (next: number): void => {
    oppsState.page = next;
    void loadOppsItems(next, goPage);
  };
  oppsGoPage = goPage;

  const reload = (): void => {
    void loadOppsOverview();
    void loadOppsBatches();
    void loadOppsJobs();
    void loadOppsItems(oppsState.page, goPage);
  };

  if (oppsMounted) {
    reload();
    return;
  }
  oppsMounted = true;

  /* 子页签：生成流程与线上列表分开，互相不干扰 */
  document.querySelectorAll<HTMLElement>("[data-opps-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.oppsView ?? "listed";
      document
        .querySelectorAll<HTMLElement>("[data-opps-view]")
        .forEach((b) => (b.dataset.active = String(b === btn)));
      const listed = $("opps-view-listed");
      const generate = $("opps-view-generate");
      if (listed) listed.hidden = view !== "listed";
      if (generate) generate.hidden = view !== "generate";
      /* 切到生成页签就把当前批次（默认本 ISO 周）的候选读一遍，别让人点空页面 */
      if (view === "generate") void loadOppsStaging();
    });
  });

  ($("opp-batch") as HTMLSelectElement | null)?.addEventListener("change", (e) => {
    oppsState.batch = (e.currentTarget as HTMLSelectElement).value;
    oppsState.page = 1;
    void loadOppsItems(1, goPage);
  });

  /* 名称搜索按输入节流：每敲一个字就发一次请求没必要 */
  ($("opp-search") as HTMLInputElement | null)?.addEventListener("input", (e) => {
    const value = (e.currentTarget as HTMLInputElement).value.trim();
    window.clearTimeout(oppsSearchTimer);
    oppsSearchTimer = window.setTimeout(() => {
      oppsState.q = value;
      oppsState.page = 1;
      void loadOppsItems(1, goPage);
    }, 300);
  });

  $("opp-refresh")?.addEventListener("click", () => {
    reload();
  });

  /* 状态写到 opp-gen：按钮在「机会生成」页签里，写 opp-status 的话人在这一页看不见 */
  $("opp-publish-btn")?.addEventListener("click", async () => {
    const btn = $("opp-publish-btn") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    setStatus("opp-gen", "正在触发重建…", "busy");
    try {
      await apiPost("/opps/publish", {});
      setStatus("opp-gen", "已提交到 GitHub Actions，正在按 content/opportunities.json 重建线上…", "busy");
      void loadOppsJobs();
      window.setTimeout(() => void loadOppsOverview(), 5000);
      window.setTimeout(() => void loadOppsItems(1, goPage), 60_000);
    } catch (e) {
      setStatus("opp-gen", `触发失败：${esc(msg(e))}`, "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /* ---------------- 机会生成：批次输入 → 生成 → 预览 → 拒绝 / 发布 ---------------- */

  const genBatch = $("opp-gen-batch") as HTMLInputElement | null;
  if (genBatch && !genBatch.value) genBatch.value = isoBatch();

  $("opp-gen-reload")?.addEventListener("click", () => {
    void loadOppsStaging();
  });

  $("opp-gen-btn")?.addEventListener("click", async () => {
    const btn = $("opp-gen-btn") as HTMLButtonElement | null;
    const batch = (genBatch?.value ?? "").trim();
    if (!OPP_BATCH_RE.test(batch)) {
      setStatus("opp-gen", "批次号形如 2026-W47（按 ISO 周）", "bad");
      return;
    }

    if (btn) btn.disabled = true;
    setStatus("opp-gen", `已提交批次 ${esc(batch)}，模型生成 5 条约 3–6 分钟…`, "busy");
    if (genBatch) genBatch.value = batch;
    try {
      await apiPost("/opps/generate", { batch });
      void loadOppsJobs();
      renderOppsPending(batch, "模型正在生成 5 条候选，约 3–6 分钟…");
      /* 生成在 Actions 里跑，候选池凑满 5 条就自动渲染，不用人盯着 */
      pollOppsStaging(batch);
    } catch (e) {
      setStatus("opp-gen", `生成失败：${esc(msg(e))}`, "bad");
      void loadOppsStaging(batch);
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /*
   * 预览区每次重渲染都是新节点，事件只能委托到容器上，
   * 否则拒绝/发布按钮点第二次就没反应了。
   */
  $("opps-preview")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    const rejectBtn = target.closest<HTMLElement>("[data-reject]");
    if (rejectBtn) {
      const slug = rejectBtn.dataset.reject ?? "";
      const batch = rejectBtn.dataset.batch ?? "";
      if (slug && batch) void rejectOpp(batch, slug, rejectBtn);
      return;
    }

    const publishBtn = target.closest<HTMLElement>("[data-publish-batch]");
    if (publishBtn) {
      const batch = publishBtn.dataset.publishBatch ?? "";
      if (batch) void publishOppsBatch(batch, publishBtn);
    }
  });

  reload();
}