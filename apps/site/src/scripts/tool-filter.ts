/**
 * AI 工具榜：浏览器端筛选 / 搜索 / 分页
 *
 * 设计：
 *  - 首屏是构建期渲染好的静态 HTML（无参数时零请求，SEO 友好）；
 *  - 用户一旦交互，才懒加载 /data/tools.json（gzip 约 45KB），之后全在本地过滤；
 *  - URL 仍是 ?q=&cat=&visits=…，可直接分享 / 刷新，兼容旧站链接。
 */
type Row = {
  cats: string[];
  visits: number | null;
  mom: number | null;
  org: number | null;
  launchedAt: string | null;
  heat: number;
  collectedAt: string;
  name: string;
  domain: string;
  desc: string;
  h: string;
};

const DATA_URL = "/data/tools.json";
const FILTER_KEYS = ["q", "cat", "visits", "growth", "org", "reg"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

function matchVisits(v: number | null, sel: string): boolean {
  if (sel === "all") return true;
  if (v === null) return false;
  if (sel === "lt1k") return v < 1000;
  if (sel === "1k10k") return v >= 1000 && v < 10_000;
  if (sel === "10k100k") return v >= 10_000 && v < 100_000;
  if (sel === "100k1m") return v >= 100_000 && v < 1_000_000;
  if (sel === "gt1m") return v >= 1_000_000;
  return true;
}

function matchGrowth(g: number | null, sel: string): boolean {
  if (sel === "all") return true;
  if (g === null) return false;
  if (sel === "neg") return g < 0;
  if (sel === "0_50") return g >= 0 && g < 50;
  if (sel === "50_200") return g >= 50 && g < 200;
  if (sel === "gt200") return g >= 200;
  return true;
}

function matchOrg(s: number | null, sel: string): boolean {
  if (sel === "all") return true;
  if (s === null) return false;
  if (sel === "lt10") return s < 10;
  if (sel === "10_30") return s >= 10 && s < 30;
  if (sel === "30_60") return s >= 30 && s < 60;
  if (sel === "gt60") return s >= 60;
  return true;
}

function matchReg(launched: string | null, sel: string): boolean {
  if (sel === "all") return true;
  if (!launched) return false;
  const age = (Date.now() - new Date(launched).getTime()) / 86_400_000;
  if (sel === "3m") return age < 90;
  if (sel === "6m") return age >= 90 && age < 180;
  if (sel === "1y") return age >= 180 && age < 365;
  if (sel === "gt1y") return age >= 365;
  return true;
}

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

export function initToolsFilter() {
  const rowsBox = document.getElementById("list-rows");
  const meta = document.getElementById("list-meta");
  const empty = document.getElementById("list-empty");
  const pager = document.getElementById("list-pager");
  if (!rowsBox || !meta || !pager) return;

  const pageSize = Number(pager.dataset.pageSize || 20);
  let cache: Row[] | null = null;

  const search = document.querySelector<HTMLInputElement>("[data-search]");
  const catBtns = [...document.querySelectorAll<HTMLButtonElement>("[data-cat]")];
  const selects = [...document.querySelectorAll<HTMLSelectElement>("[data-filter]")];

  const hasFilter = () => FILTER_KEYS.some((k) => new URLSearchParams(location.search).get(k));

  async function load(): Promise<Row[]> {
    if (!cache) {
      const res = await fetch(DATA_URL);
      if (!res.ok) throw new Error(`加载榜单数据失败：${res.status}`);
      cache = (await res.json()) as Row[];
    }
    return cache;
  }

  const setParam = (key: string, value: string) => {
    const p = new URLSearchParams(location.search);
    if (!value || value === "all" || value === "All") p.delete(key);
    else p.set(key, value);
    p.delete("page");
    history.replaceState(null, "", p.toString() ? `/tools?${p}` : "/tools");
    void render();
  };

  async function render() {
    const p = new URLSearchParams(location.search);
    const q = (p.get("q") || "").trim().toLowerCase();
    const cat = p.get("cat") || "All";
    const visits = p.get("visits") || "all";
    const growth = p.get("growth") || "all";
    const org = p.get("org") || "all";
    const reg = p.get("reg") || "all";
    const sort = p.get("sort") || "heat";

    // 同步筛选控件到 URL 状态
    if (search && document.activeElement !== search) search.value = p.get("q") || "";
    catBtns.forEach((b) => {
      const active = b.dataset.cat === cat;
      b.className = active
        ? "rounded-full bg-primary px-3 py-1.5 text-sm text-white"
        : "rounded-full border border-border bg-surface px-3 py-1.5 text-sm text-ink-secondary transition hover:text-ink";
    });
    selects.forEach((s) => {
      const v = p.get(s.dataset.filter || "") || "all";
      if (s.value !== v) s.value = v;
    });

    const all = await load();
    const filtered = all.filter((r) => {
      if (cat !== "All" && !r.cats.includes(cat)) return false;
      if (!matchVisits(r.visits, visits)) return false;
      if (!matchGrowth(r.mom, growth)) return false;
      if (!matchOrg(r.org, org)) return false;
      if (!matchReg(r.launchedAt, reg)) return false;
      if (q) {
        const hay = `${r.name} ${r.domain} ${r.desc}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    filtered.sort((a, b) =>
      sort === "recent" ? b.collectedAt.localeCompare(a.collectedAt) : b.heat - a.heat,
    );

    const total = Math.max(1, Math.ceil(filtered.length / pageSize));
    const page = Math.min(Math.max(1, Number(p.get("page") || 1)), total);
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);

    rowsBox.innerHTML = slice
      .map((r, i) => r.h.replace("%R%", pad((page - 1) * pageSize + i + 1)))
      .join("");

    if (empty) empty.classList.toggle("hidden", slice.length > 0);
    meta.textContent = `显示 ${slice.length} 项，共 ${filtered.length} 项 / ${total} 页`;
    pager.innerHTML = pagerHtml(page, total);

    // 让「刷新后保持状态」，同时不改动首屏 URL 之外的东西
    if (p.toString()) history.replaceState(null, "", `${location.pathname}?${p}`);
  }

  // ---- 交互绑定 ----
  let timer: number | undefined;
  search?.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => setParam("q", search.value.trim()), 200);
  });

  catBtns.forEach((b) =>
    b.addEventListener("click", () => setParam("cat", b.dataset.cat || "All")),
  );

  selects.forEach((s) =>
    s.addEventListener("change", () => setParam(s.dataset.filter || "", s.value)),
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

  if (hasFilter()) void render();
}