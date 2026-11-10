/**
 * AI 模型榜：浏览器端筛选 / 搜索 / 排序 / 分页。
 * 首屏静态渲染第 1 页，这里接管后续交互；名次已内联，筛选与排序不重排名次。
 */
type Row = {
  slug: string;
  name: string;
  provider: string;
  modality: string;
  open: boolean;
  context: number | null;
  maxOutput: number | null;
  priceIn: number | null;
  priceOut: number | null;
  priceCached: number | null;
  hasFree: boolean;
  /** 能力分（0–100），用于「能力」排序 */
  capability: number;
  value: number;
  score: number;
  releasedAt: string | null;
  hay: string;
  h: string;
};

const DATA_URL = "/data/models.json";

const avg = (a: number | null, b: number | null): number => {
  if (a === null && b === null) return Number.POSITIVE_INFINITY;
  const i = a ?? b ?? 0;
  const o = b ?? a ?? 0;
  return (i + o) / 2;
};

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

export function initModelsFilter() {
  const rowsBox = document.getElementById("models-rows");
  const empty = document.getElementById("models-empty");
  const pager = document.getElementById("models-pager");
  const meta = document.getElementById("models-meta");
  if (!rowsBox || !pager || !meta) return;

  const pageSize = Number(pager.dataset.pageSize || 20);
  let cache: Row[] | null = null;

  const search = document.querySelector<HTMLInputElement>("[data-search]");
  const chips = [...document.querySelectorAll<HTMLAnchorElement>("[data-filter-btn]")];
  const selects = [...document.querySelectorAll<HTMLSelectElement>("[data-filter-select]")];
  const sortBtns = [...document.querySelectorAll<HTMLAnchorElement>("[data-sort]")];

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
    history.replaceState(null, "", p.toString() ? `/models?${p}` : "/models");
    void render();
  }

  async function render() {
    const p = new URLSearchParams(location.search);
    const q = (p.get("q") || "").trim().toLowerCase();
    const mod = p.get("mod") || "All";
    const type = p.get("type") || "all";
    const prov = p.get("prov") || "All";
    const price = p.get("price") || "all";
    const free = p.get("free") || "all";
    const sort = p.get("sort") || "score";
    const filtered =
      Boolean(q) ||
      mod !== "All" ||
      type !== "all" ||
      prov !== "All" ||
      price !== "all" ||
      free !== "all";

    if (search && document.activeElement !== search) search.value = p.get("q") || "";
    const norm = (v: string | null | undefined) => (!v || v === "All" ? "all" : v);
    chips.forEach((c) => {
      const active = norm(p.get(c.dataset.filterBtn || "")) === norm(c.dataset.value);
      c.className = chipCls(active);
    });
    sortBtns.forEach((b) => {
      b.className = chipCls(sort === b.dataset.sort);
    });
    selects.forEach((s) => {
      const desired = p.get(s.dataset.filterSelect || "") || "All";
      if (s.value !== desired) s.value = desired;
    });

    const all = await load();
    const list = all.filter((r) => {
      if (mod !== "All" && r.modality !== mod) return false;
      if (type === "open" && !r.open) return false;
      if (type === "closed" && r.open) return false;
      if (prov !== "All" && r.provider !== prov) return false;
      if (free === "free" && !r.hasFree) return false;
      if (price !== "all") {
        const v = avg(r.priceIn, r.priceOut);
        if (!Number.isFinite(v)) return false;
        if (price === "low" && v > 0.5) return false;
        if (price === "mid" && (v <= 0.5 || v > 3)) return false;
        if (price === "high" && (v <= 3 || v > 10)) return false;
        if (price === "premium" && v <= 10) return false;
      }
      if (q && !r.hay.includes(q)) return false;
      return true;
    });

    list.sort((a, b) => {
      if (sort === "capability") return b.capability - a.capability || b.score - a.score;
      if (sort === "price") return avg(a.priceIn, a.priceOut) - avg(b.priceIn, b.priceOut);
      if (sort === "context") return (b.context ?? -1) - (a.context ?? -1);
      if (sort === "newest") return (b.releasedAt ?? "").localeCompare(a.releasedAt ?? "");
      if (sort === "value") return b.value - a.value;
      return b.score - a.score || a.name.localeCompare(b.name);
    });

    const total = Math.max(1, Math.ceil(list.length / pageSize));
    const page = Math.min(Math.max(1, Number(p.get("page") || 1)), total);
    const slice = list.slice((page - 1) * pageSize, page * pageSize);

    rowsBox.innerHTML = slice.map((r) => r.h).join("");
    empty?.classList.toggle("hidden", slice.length > 0);
    meta.textContent = filtered
      ? `筛选结果 ${list.length} 个 · 第 ${page} / ${total} 页`
      : `共 ${list.length} 个模型 · 第 ${page} / ${total} 页`;
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
      setParam("sort", b.dataset.sort || "score");
    }),
  );

  selects.forEach((s) =>
    s.addEventListener("change", () => {
      setParam(s.dataset.filterSelect || "", s.value);
    }),
  );

  document.querySelector<HTMLAnchorElement>("[data-reset]")?.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "/models");
    void render();
  });

  pager.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a[data-page]");
    if (!a) return;
    e.preventDefault();
    const p = new URLSearchParams(location.search);
    p.set("page", (a as HTMLElement).dataset.page || "1");
    history.replaceState(null, "", `/models?${p}`);
    void render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  void render().catch(() => {
    meta.textContent = "数据加载失败，当前为静态首屏";
  });
}