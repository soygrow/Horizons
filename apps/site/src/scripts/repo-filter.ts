/**
 * GitHub 榜：浏览器端筛选 / 搜索 / 排序 / 分页
 * 过滤与排序口径与服务端产物保持一致。
 */
type Row = {
  /** 真实排名：由综合得分决定，与当前排序/筛选/页码无关 */
  rank: number;
  cats: string[];
  lang: string | null;
  diff: string;
  license: string | null;
  permissive: boolean;
  score: number;
  stars: number;
  g7: number | null;
  g30: number | null;
  fullName: string;
  desc: string | null;
  intro: string;
  h: string;
};

const DATA_URL = "/data/github.json";
const FILTER_KEYS = ["q", "cat", "lang", "diff", "license", "sort"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

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

const numDesc = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);

export function initReposFilter() {
  const rowsBox = document.getElementById("list-rows");
  const meta = document.getElementById("list-meta");
  const empty = document.getElementById("list-empty");
  const pager = document.getElementById("list-pager");
  const sorts = document.getElementById("list-sorts");
  if (!rowsBox || !meta || !pager) return;

  const pageSize = Number(pager.dataset.pageSize || 20);
  let cache: Row[] | null = null;

  const search = document.querySelector<HTMLInputElement>("[data-search]");
  const chips = [...document.querySelectorAll<HTMLAnchorElement>("[data-filter-btn]")];
  const sortBtns = [...document.querySelectorAll<HTMLAnchorElement>("[data-sort]")];

  const hasFilter = () =>
    FILTER_KEYS.some((k) => {
      const v = new URLSearchParams(location.search).get(k);
      return !!v && v !== "All";
    });

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
    history.replaceState(null, "", p.toString() ? `/github?${p}` : "/github");
    void render();
  }

  async function render() {
    const p = new URLSearchParams(location.search);
    const q = (p.get("q") || "").trim().toLowerCase();
    const cat = p.get("cat") || "All";
    const lang = p.get("lang") || "All";
    const diff = p.get("diff") || "All";
    const license = p.get("license") || "All";
    const sort = p.get("sort") || "score";

    if (search && document.activeElement !== search) search.value = p.get("q") || "";
    chips.forEach((c) => {
      const active = (p.get(c.dataset.filterBtn || "") || "All") === c.dataset.value;
      c.className = chipCls(active);
    });
    sortBtns.forEach((b) => {
      b.className = chipCls((p.get("sort") || "score") === b.dataset.sort);
    });

    const all = await load();
    const filtered = all.filter((r) => {
      if (cat !== "All" && !r.cats.includes(cat)) return false;
      if (lang !== "All" && r.lang !== lang) return false;
      if (diff !== "All" && r.diff !== diff) return false;
      if (license === "yes" && !r.permissive) return false;
      if (license === "no" && r.permissive) return false;
      if (q) {
        const hay = `${r.fullName} ${r.desc ?? ""} ${r.intro}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      if (sort === "stars") return b.stars - a.stars || a.rank - b.rank;
      if (sort === "7d") return numDesc(a.g7, b.g7) || a.rank - b.rank;
      if (sort === "30d") return numDesc(a.g30, b.g30) || a.rank - b.rank;
      // 默认 = 排名顺序：综合得分降序，同分按星标、再按排名兜底，保证与 # 列一致
      return b.score - a.score || b.stars - a.stars || a.rank - b.rank;
    });

    const total = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, Number(p.get("page") || 1)), total);
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

    rowsBox.innerHTML = slice.map((r) => r.h.replace("%R%", pad(r.rank))).join("");
    if (empty) empty.classList.toggle("hidden", slice.length > 0);
    meta.textContent = `显示 ${slice.length} 项，共 ${filtered.length} 项 / ${total} 页`;
    pager.innerHTML = pagerHtml(page, total);

    if (p.toString()) history.replaceState(null, "", `${location.pathname}?${p}`);
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

  pager.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a[data-page]");
    if (!a) return;
    e.preventDefault();
    const p = new URLSearchParams(location.search);
    p.set("page", (a as HTMLElement).dataset.page || "1");
    history.replaceState(null, "", `${location.pathname}?${p}`);
    void render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  void sorts;

  if (hasFilter()) void render();
}