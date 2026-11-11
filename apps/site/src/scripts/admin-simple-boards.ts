/**
 * 后台「模型榜」「机会榜」页签。
 *
 * 这两个榜没有候选池：模型榜采集完整榜发布，机会榜是人工策展文件改完直接同步。
 * 所以页签比工具榜/趋势榜简单得多 —— 看当前线上是什么、触发一次同步、确认跑完没有。
 *
 * 两个榜结构一致，用同一份实现按配置渲染，避免两套几乎相同的代码各自漂移。
 */
import { $, apiGet, apiPost, esc, fmtNum, fmtTime } from "./admin-shared";

interface Overview {
  board: string;
  configured: boolean;
  missing: string[];
  publishable: boolean;
  version: string | null;
  total: number;
  updatedAt: string | null;
  status: string;
  run: { id: number; url: string; status: string; conclusion: string | null } | null;
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

interface Def {
  /** HTML 里的 id 前缀，如 mdl / opp */
  prefix: string;
  /** 接口前缀，如 /models */
  api: string;
  /** 这榜的一条是什么，用于空态文案 */
  unit: string;
  columns: string[];
  row: (item: Item) => string;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "未运行",
  queued: "排队中",
  running: "运行中",
  success: "已完成",
  failure: "失败",
  cancelled: "已取消",
};

const num = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(1) : "—";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* -------------------------------- 定义 --------------------------------- */

const DEFS: Def[] = [
  {
    prefix: "mdl",
    api: "/models",
    unit: "个模型",
    columns: ["#", "模型", "厂商", "能力分", "综合分", "标签"],
    row: (item) => {
      const provider = item.card?.provider ?? "—";
      const tags = item.cats.length ? item.cats.join(" / ") : "—";
      return `<td class="px-3 py-2 text-right text-xs tabular-nums text-ink-muted">${item.rank}</td>
        <td class="max-w-[240px] px-3 py-2">
          <div class="truncate font-medium text-ink" title="${esc(item.name)}">${esc(item.name)}</div>
          <div class="truncate font-mono text-[11px] text-ink-muted">${esc(item.key)}</div>
        </td>
        <td class="px-3 py-2 text-xs text-ink-secondary">${esc(provider)}</td>
        <td class="px-3 py-2 text-right text-xs tabular-nums text-ink-secondary">${num(item.card?.capability)}</td>
        <td class="px-3 py-2 text-right text-xs font-medium tabular-nums text-ink">${num(item.score)}</td>
        <td class="max-w-[220px] px-3 py-2 text-xs text-ink-muted"><div class="truncate" title="${esc(tags)}">${esc(tags)}</div></td>`;
    },
  },
  {
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
  },
];

/* -------------------------------- 渲染 --------------------------------- */

function setStatus(def: Def, text: string, tone: "idle" | "busy" | "ok" | "bad"): void {
  const el = $(`${def.prefix}-status`);
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

function renderOverview(def: Def, o: Overview): void {
  $(`${def.prefix}-kpi-total`).textContent = fmtNum(o.total);
  $(`${def.prefix}-kpi-total-sub`).textContent = o.version
    ? `当前版本 ${o.version}`
    : "还没有发布过";
  // board_stats.updated_at 有时只有日期（YYYY-MM-DD），别给它编一个时间出来
  const updated = o.updatedAt ?? "";
  $(`${def.prefix}-kpi-updated`).textContent = updated
    ? /^\d{4}-\d{2}-\d{2}$/.test(updated)
      ? updated.slice(5)
      : fmtTime(updated)
    : "—";
  $(`${def.prefix}-kpi-updated-sub`).textContent = updated ? "统计刷新时间" : "等待第一次同步";
  $(`${def.prefix}-kpi-version`).textContent = o.version ?? "—";
  $(`${def.prefix}-kpi-version-sub`).textContent = `${o.board} · 读 D1`;

  const label = STATUS_LABEL[o.status] ?? o.status;
  const link = o.run?.url
    ? ` · <a class="underline" href="${esc(o.run.url)}" target="_blank" rel="noreferrer">查看日志</a>`
    : "";
  const tone = o.status === "failure" ? "bad" : o.status === "success" ? "ok" : o.status === "idle" ? "idle" : "busy";

  if (!o.publishable) {
    setStatus(def, "这个榜还没有流水线，只能本地跑脚本同步", "idle");
    return;
  }
  if (!o.configured) {
    setStatus(def, `未配置 GitHub 集成（缺 ${esc(o.missing.join(" / "))}），无法从这里触发同步`, "bad");
    return;
  }
  setStatus(def, `最近一次运行：${esc(label)}${link}`, tone);
}

function renderItems(def: Def, res: ItemsRes, goPage: (page: number) => void): void {
  const body = $(`${def.prefix}-list`);
  if (!res.items.length) {
    body.innerHTML = `<tr><td colspan="${def.columns.length}" class="px-3 py-6 text-center text-xs text-ink-muted">还没有${def.unit}，先触发一次同步</td></tr>`;
  } else {
    body.innerHTML = res.items
      .map(
        (item) =>
          `<tr class="border-t border-border hover:bg-surface-2/40">${def.row(item)}</tr>`,
      )
      .join("");
  }

  const pager = $(`${def.prefix}-pager`);
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

/* -------------------------------- 请求 --------------------------------- */

async function loadOverview(def: Def): Promise<void> {
  try {
    const o = await apiGet<Overview>(`${def.api}/overview`);
    renderOverview(def, o);
  } catch (e) {
    setStatus(def, `概览读取失败：${esc(msg(e))}`, "bad");
  }
}

async function loadItems(def: Def, page: number, goPage: (p: number) => void): Promise<void> {
  const body = $(`${def.prefix}-list`);
  try {
    const res = await apiGet<ItemsRes>(`${def.api}/items?page=${page}&size=50`);
    renderItems(def, res, goPage);
  } catch (e) {
    body.innerHTML = `<tr><td colspan="${def.columns.length}" class="px-3 py-4 text-center text-xs text-red-600">读取失败：${esc(msg(e))}</td></tr>`;
  }
}

function pollStatus(def: Def, times = 6): void {
  if (times <= 0) return;
  window.setTimeout(async () => {
    await loadOverview(def);
    pollStatus(def, times - 1);
  }, 5000);
}

/** 已挂载的页签：切换 tab 会反复调 mount，重复绑定会让一次点击触发多次 */
const mounted = new Set<string>();

/** 每个 def 自己的分页状态关在 mount 里，两个页签互不干扰 */
function mount(def: Def): void {
  let page = 1;

  const goPage = (next: number): void => {
    page = next;
    void loadItems(def, page, goPage);
  };

  const refresh = (): void => {
    void loadOverview(def);
    void loadItems(def, page, goPage);
  };

  if (!mounted.has(def.prefix)) {
    mounted.add(def.prefix);

    const publish = async (): Promise<void> => {
      const btn = $(`${def.prefix}-publish-btn`) as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      setStatus(def, "正在触发同步…", "busy");
      try {
        await apiPost(`${def.api}/publish`, {});
        setStatus(def, "已提交到 GitHub Actions，正在等待启动…", "busy");
        pollStatus(def, 8);
        // 同步要写一次 D1，跑完再刷明细
        window.setTimeout(() => void loadItems(def, 1, goPage), 60_000);
      } catch (e) {
        setStatus(def, `触发失败：${esc(msg(e))}`, "bad");
      } finally {
        if (btn) btn.disabled = false;
      }
    };

    $(`${def.prefix}-refresh`)?.addEventListener("click", refresh);
    $(`${def.prefix}-publish-btn`)?.addEventListener("click", () => void publish());
  }

  refresh();
}

/** 模型榜页签入口 */
export function mountAdminModels(): void {
  const def = DEFS[0];
  if (def) mount(def);
}

/** 机会榜页签入口 */
export function mountAdminOpps(): void {
  const def = DEFS[1];
  if (def) mount(def);
}