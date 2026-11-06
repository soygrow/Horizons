/**
 * AI 趋势词榜：浏览器端筛选 / 搜索 / 排序 / 分页。
 * 过滤与排序口径与服务端产物保持一致。
 * 页面只有一个列表：阶段（爆/增长/新/回落）是筛选条件，首屏静态渲染第 1 页，这里接管后续交互。
 */
type Row = {
  slug: string;
  keyword: string;
  normalizedName: string;
  category: string;
  status: string;
  confidence: string;
  rank: number;
  overall: number;
  sortOverall: number;
  sortTrend: number;
  sortOpp: number;
  sortGrowth: number;
  firstSeenAt: string;
  hay: string;
  h: string;
};

const DATA_URL = "/data/trends.json";

/** 与静态首屏一致的默认排序：综合得分 → 趋势强度 → slug（保证结果可复现） */
function byOverall(a: Row, b: Row): number {
  return b.sortOverall - a.sortOverall || b.sortTrend - a.sortTrend || a.slug.localeCompare(b.slug);
}

const chipCls = (active: boolean) =>
  active
    ? "rounded-full bg-primary px-3 py-1 text-xs font-medium text-white"
    : "rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-secondary transition hover:text-ink";

const btnCls = (active: boolean) =>
  active
    ? "rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-white"
    : "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink";

function pagerHtml(page: number, total: number): string {
  if (total <= 1) return "";
  const pages = Array.from({ length: total }, (_, i) => i + 1);
  const visible = pages.filter((p) => p === 1 || p === total || Math.abs(p - page) <= 1);

  let html = `<nav class="flex items-center justify-center gap-1.5">`;
  if (page > 1) html += `<a href="#" data-page="${page - 1}" class="${btnCls(false)}">上一页</a>`;
  visible.forEach((p, i) => {
    const prev = visible[i - 1];
    if (prev && p - prev > 1) html += `<span class="text-ink-muted">…</span>`;
    html += `<a href="#" data-page="${p}" class="${btnCls(p === page)}">${p}</a>`;
  });
  if (page < total) html += `<a href="#" data-page="${page + 1}" class="${btnCls(false)}">下一页</a>`;
  html += `</nav>`;
  return html;
}

export function initTrendsFilter() {
  const rowsBox = document.getElementById("trends-rows");
  const empty = document.getElementById("trends-empty");
  const pager = document.getElementById("trends-pager");
  const meta = document.getElementById("trends-meta");
  if (!rowsBox || !pager || !meta) return;

  const pageSize = Number(pager.dataset.pageSize || 20);
  let cache: Row[] | null = null;

  const search = document.querySelector<HTMLInputElement>("[data-search]");
  const chips = [...document.querySelectorAll<HTMLAnchorElement>("[data-filter-btn]")];
  const sortBtns = [...document.querySelectorAll<HTMLAnchorElement>("[data-sort]")];
  const statusLinks = [...document.querySelectorAll<HTMLAnchorElement>("[data-link-status]")];

  async function load(): Promise<Row[]> {
    if (!cache) {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`加载榜单数据失败：${res.status}`);
      cache = (await res.json()) as Row[];
    }
    return cache;
  }

  function setParam(key: string, value: string) {
    const p = new URLSearchParams(location.search);
    if (!value || value === "all" || value === "All") p.delete(key);
    else p.set(key, value);
    if (key !== "page") p.delete("page");
    history.replaceState(null, "", p.toString() ? `/trends?${p}` : "/trends");
    void render();
  }

  async function render() {
    const p = new URLSearchParams(location.search);
    const q = (p.get("q") || "").trim().toLowerCase();
    const cat = p.get("cat") || "All";
    const status = p.get("status") || "all";
    const conf = p.get("conf") || "all";
    const sort = p.get("sort") || "overall";
    const filtered = Boolean(q) || cat !== "All" || status !== "all" || conf !== "all";

    if (search && document.activeElement !== search) search.value = p.get("q") || "";
    // "All" / "all" / 缺省都视为「全部」
    const norm = (v: string | null | undefined) => (!v || v === "All" ? "all" : v);
    chips.forEach((c) => {
      const active = norm(p.get(c.dataset.filterBtn || "")) === norm(c.dataset.value);
      c.className = chipCls(active);
    });
    sortBtns.forEach((b) => {
      b.className = chipCls(sort === b.dataset.sort);
    });

    const all = await load();
    const list = all.filter((r) => {
      if (cat !== "All" && r.category !== cat) return false;
      if (status !== "all" && r.status !== status) return false;
      if (conf !== "all" && r.confidence !== conf) return false;
      if (q && !r.hay.includes(q)) return false;
      return true;
    });

    // 数据不足（sortOverall = -1）自然沉底
    list.sort((a, b) => {
      if (sort === "opp") return b.sortOpp - a.sortOpp;
      if (sort === "growth") return b.sortGrowth - a.sortGrowth;
      if (sort === "newest") return b.firstSeenAt.localeCompare(a.firstSeenAt);
      if (sort === "trend") return b.sortTrend - a.sortTrend;
      return byOverall(a, b);
    });

    const total = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(Math.max(1, Number(p.get("page") || 1)), total);
    const slice = list.slice((page - 1) * pageSize, page * pageSize);

    // 名次已随行 HTML 内联（全站名次），翻页 / 筛选都不重排编号
    rowsBox.innerHTML = slice.map((r) => r.h).join("");
    empty?.classList.toggle("hidden", slice.length > 0);
    meta.textContent = filtered
      ? `筛选结果 ${list.length} 个 · 第 ${page} / ${total} 页`
      : `共 ${list.length} 个关键词 · 第 ${page} / ${total} 页`;
    pager.innerHTML = pagerHtml(page, total);
  }

  let timer: number | undefined;
  search?.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setParam("q", search.value.trim()), 200);
  });

  chips.forEach((c) =>
    c.addEventListener("click", (e) => {
      e.preventDefault();
      setParam(c.dataset.filterBtn || "", c.dataset.value || "All");
    }),
  );

  sortBtns.forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      setParam("sort", b.dataset.sort || "overall");
    }),
  );

  // 顶部状态胶囊：等价于「阶段」筛选
  statusLinks.forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      setParam("status", a.dataset.linkStatus || "all");
    }),
  );

  document.querySelector<HTMLAnchorElement>("[data-reset]")?.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "/trends");
    void render();
  });

  pager.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a[data-page]");
    if (!a) return;
    e.preventDefault();
    const p = new URLSearchParams(location.search);
    p.set("page", (a as HTMLElement).dataset.page || "1");
    history.replaceState(null, "", `/trends?${p}`);
    void render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // 首屏静态渲染第 1 页；脚本接管后补上分页器与元信息
  void render().catch(() => {
    // 数据加载失败时保留服务端渲染的结果
    meta.textContent = "数据加载失败，当前为静态首屏";
  });
}