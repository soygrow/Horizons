/**
 * 后台管理页逻辑。所有数据来自 /api/admin/*，页面本身不含业务数据。
 * 渲染一律走 esc() 转义，避免把用户邮箱/昵称直接当 HTML 插进表格。
 */

interface Stats {
  generatedAt: number;
  users: {
    total: number;
    new7: number;
    new30: number;
    pro: { total: number; month: number; year: number };
  };
  revenue: {
    currencies: Array<{
      currency: string;
      orders: number;
      total: number;
      month: number;
      prevMonth: number;
      refunds: number;
      refundAmount: number;
      mrr: number;
    }>;
    months: string[];
    series: Array<{ currency: string; values: number[]; orders: number[] }>;
  };
  subscriptions: {
    active: number;
    trialing: number;
    pastDue: number;
    paused: number;
    canceled: number;
  };
}

interface UserItem {
  id: string;
  email: string;
  name: string | null;
  createdAt: number;
  proUntil: number | null;
  isPro: boolean;
  plan: string | null;
  subStatus: string | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  paid: Array<{ currency: string; amount: number; orders: number; lastAt: number }>;
}

interface Page<T> {
  page: number;
  pageSize: number;
  total: number;
  pages: number;
  items: T[];
}

interface PaymentItem {
  id: string;
  plan: string;
  amount: number;
  currency: string;
  status: string;
  paidAt: number | null;
  createdAt: number;
  provider: string;
  orderId: string;
  autoRenew: boolean;
  email: string | null;
  name: string | null;
}

const CSRF_HEADERS = {
  "content-type": "application/json",
  "x-requested-with": "horizons-admin",
};

class ApiError extends Error {
  status: number;
  retryAfter?: number;

  constructor(status: number, code: string, retryAfter?: number) {
    super(code);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    let code = "request_failed";
    let retryAfter: number | undefined;
    try {
      const body = (await res.json()) as { error?: string; retryAfter?: number };
      code = body.error ?? code;
      retryAfter = body.retryAfter;
    } catch {
      /* 非 JSON 错误体，用状态码兜底 */
    }
    throw new ApiError(res.status, code, retryAfter);
  }

  return (await res.json()) as T;
}

/* --------------------------------- 工具 --------------------------------- */

const SYMBOL: Record<string, string> = { CNY: "¥", USD: "$", EUR: "€", GBP: "£", JPY: "¥" };

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function money(cents: number, currency: string): string {
  const digits = currency === "JPY" ? 0 : 2;
  const value = (Math.abs(cents) / 100).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${SYMBOL[currency] ?? `${currency} `}${value}`;
}

/** 日期统一 YYYY-MM-DD，时刻统一 YYYY-MM-DD HH:mm（不走 Intl，避免 locale 差异） */
const p2 = (n: number) => String(n).padStart(2, "0");

function ymd(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

function fmtDate(ms: number | null): string {
  return typeof ms === "number" && ms > 0 ? ymd(new Date(ms)) : "—";
}

function fmtDateTime(ms: number | null): string {
  if (typeof ms !== "number" || ms <= 0) return "—";
  const d = new Date(ms);
  return `${ymd(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function pct(current: number, base: number): string {
  if (!base) return current > 0 ? "新增" : "—";
  const diff = ((current - base) / base) * 100;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function badge(text: string, tone: "pro" | "free" | "warn" | "danger" | "ok"): string {
  const tones: Record<string, string> = {
    pro: "bg-primary-soft text-primary",
    free: "bg-surface-2 text-ink-muted",
    warn: "bg-warning-soft text-warning",
    danger: "bg-danger-soft text-danger",
    ok: "bg-success-soft text-success",
  };
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}">${esc(text)}</span>`;
}

/* --------------------------------- 状态 --------------------------------- */

const state = {
  stats: null as Stats | null,
  chartCurrency: "",
  tab: "overview" as "overview" | "users" | "payments",
  users: { page: 1, q: "", type: "all", loaded: false, data: null as Page<UserItem> | null },
  payments: {
    page: 1,
    q: "",
    status: "",
    loaded: false,
    data: null as Page<PaymentItem> | null,
  },
};

/* -------------------------------- 登录流 -------------------------------- */

const loginView = $("login-view");
const appView = $("app-view");
const loginForm = $("login-form") as HTMLFormElement;
const loginError = $("login-error");
const loginSubmit = $("login-submit") as HTMLButtonElement;

function setLoginError(message: string | null): void {
  loginError.textContent = message ?? "";
  loginError.classList.toggle("hidden", !message);
}

function showLogin(): void {
  state.stats = null;
  state.users.loaded = false;
  state.payments.loaded = false;
  appView.hidden = true;
  loginView.hidden = false;
  setLoginError(null);
  loginSubmit.disabled = false;
  loginSubmit.textContent = "登录";
  ($("login-username") as HTMLInputElement).focus();
}

async function enterApp(username: string): Promise<void> {
  loginView.hidden = true;
  appView.hidden = false;
  $("who").textContent = username;
  if (!state.users.loaded) {
    state.users.loaded = true;
    void loadUsers();
  }
  await loadStats();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError(null);

  const username = ($("login-username") as HTMLInputElement).value.trim();
  const password = ($("login-password") as HTMLInputElement).value;
  if (!username || !password) {
    setLoginError("请填写用户名和密码");
    return;
  }

  loginSubmit.disabled = true;
  loginSubmit.textContent = "登录中…";

  try {
    const result = await api<{ ok: boolean; username: string }>("/login", {
      method: "POST",
      headers: CSRF_HEADERS,
      body: JSON.stringify({ username, password }),
    });
    ($("login-password") as HTMLInputElement).value = "";
    await enterApp(result.username);
  } catch (error) {
    const err = error as ApiError;
    if (err.status === 401) setLoginError("用户名或密码错误");
    else if (err.status === 429) {
      const minutes = Math.max(1, Math.ceil((err.retryAfter ?? 900) / 60));
      setLoginError(`尝试次数过多，请 ${minutes} 分钟后再试`);
    } else if (err.status === 503) setLoginError("后台账号尚未配置（ADMIN_USERNAME / ADMIN_PASSWORD_HASH）");
    else setLoginError("登录失败，请稍后再试");
    loginSubmit.disabled = false;
    loginSubmit.textContent = "登录";
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api("/logout", { method: "POST", headers: CSRF_HEADERS, body: "{}" });
  } catch {
    /* 会话可能已过期，直接回登录页即可 */
  }
  showLogin();
});

/* -------------------------------- 数据加载 ------------------------------- */

const loadError = $("load-error");

function showLoadError(message: string | null): void {
  loadError.textContent = message ?? "";
  loadError.classList.toggle("hidden", !message);
}

function handleApiError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) {
    showLogin();
    return;
  }
  showLoadError("数据加载失败，请点右上角「刷新」重试");
}

async function loadStats(): Promise<void> {
  try {
    state.stats = await api<Stats>("/stats");
    showLoadError(null);
    renderStats();
    renderChart();
  } catch (error) {
    handleApiError(error);
  }
}

$("refresh").addEventListener("click", () => {
  void loadStats();
  if (state.tab === "users") void loadUsers();
  if (state.tab === "payments") void loadPayments();
});

/* -------------------------------- 概览渲染 ------------------------------- */

function primaryCurrency(): string {
  const list = state.stats?.revenue.currencies ?? [];
  const cny = list.find((c) => c.currency === "CNY");
  return (cny ?? list[0])?.currency ?? "";
}

function renderStats(): void {
  const stats = state.stats;
  if (!stats) return;

  const total = stats.users.total;
  $("kpi-users").textContent = total.toLocaleString("zh-CN");
  $("kpi-users-sub").textContent = `近 7 天 +${stats.users.new7} · 近 30 天 +${stats.users.new30}`;

  $("kpi-pro").textContent = stats.users.pro.total.toLocaleString("zh-CN");
  const share = total > 0 ? ((stats.users.pro.total / total) * 100).toFixed(1) : "0.0";
  $("kpi-pro-sub").innerHTML = [
    `<span>月付 <strong class="font-semibold text-ink">${stats.users.pro.month}</strong></span>`,
    `<span>年付 <strong class="font-semibold text-ink">${stats.users.pro.year}</strong></span>`,
    `<span class="text-ink-muted">占比 ${share}%</span>`,
  ].join("");

  const currency = primaryCurrency();
  const main = stats.revenue.currencies.find((c) => c.currency === currency);
  const others = stats.revenue.currencies.filter((c) => c.currency !== currency);

  $("kpi-total").textContent = main ? money(main.total, main.currency) : "—";
  $("kpi-total-sub").innerHTML = main
    ? [
        `共 ${main.orders} 笔`,
        main.refunds > 0 ? `退款 ${main.refunds} 笔 ${money(main.refundAmount, main.currency)}` : "",
        ...others.map((c) => `${c.currency} ${money(c.total, c.currency)}`),
      ]
        .filter(Boolean)
        .join(" · ")
    : "还没有付费记录";

  $("kpi-month").textContent = main ? money(main.month, main.currency) : "—";
  $("kpi-month-sub").innerHTML = main
    ? [
        `环比 ${pct(main.month, main.prevMonth)}`,
        main.mrr > 0 ? `预估 MRR ${money(main.mrr, main.currency)}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "—";

  const subs = stats.subscriptions;
  const refundTotal = stats.revenue.currencies.reduce(
    (sum, c) => sum + c.refunds,
    0,
  );
  const facts: Array<[string, string]> = [
    ["生效中的订阅", String(subs.active)],
    ["试用中", String(subs.trialing)],
    ["扣款逾期", String(subs.pastDue)],
    ["已取消（到期结束）", String(subs.canceled)],
    ["暂停", String(subs.paused)],
    ["退款笔数", String(refundTotal)],
  ];
  $("side-facts").innerHTML = facts
    .map(
      ([label, value]) =>
        `<div class="flex items-baseline justify-between gap-3"><dt class="text-ink-secondary">${esc(label)}</dt><dd class="font-medium tabular-nums">${esc(value)}</dd></div>`,
    )
    .join("");

  $("updated-at").textContent = `更新于 ${new Date(stats.generatedAt).toLocaleTimeString("zh-CN")}`;
}

function renderChart(): void {
  const stats = state.stats;
  const chart = $("chart");
  const monthsEl = $("chart-months");
  const toggle = $("chart-currencies");
  if (!stats) return;

  const series = stats.revenue.series;
  if (!series.length) {
    chart.innerHTML = `<p class="pb-2 text-xs text-ink-muted">还没有收入数据</p>`;
    monthsEl.innerHTML = "";
    toggle.innerHTML = "";
    return;
  }

  if (!series.some((s) => s.currency === state.chartCurrency)) {
    state.chartCurrency = series.some((s) => s.currency === "CNY") ? "CNY" : series[0]!.currency;
  }

  toggle.innerHTML = series
    .map(
      (s) =>
        `<button type="button" data-currency="${esc(s.currency)}" class="rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
          s.currency === state.chartCurrency
            ? "bg-primary text-white"
            : "bg-surface-2 text-ink-secondary hover:text-ink"
        }">${esc(s.currency)}</button>`,
    )
    .join("");
  toggle.querySelectorAll<HTMLButtonElement>("button[data-currency]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chartCurrency = btn.dataset.currency ?? "";
      renderChart();
    });
  });

  const active = series.find((s) => s.currency === state.chartCurrency) ?? series[0]!;
  const max = Math.max(...active.values, 1);

  chart.innerHTML = active.values
    .map((value, index) => {
      const month = stats.revenue.months[index] ?? "";
      const ratio = value / max;
      const height = value > 0 ? Math.max(3, Math.round(ratio * 100)) : 1;
      const tone = value > 0 ? "bg-primary/85 group-hover:bg-primary" : "bg-border";
      return `<div class="group flex h-full flex-1 flex-col justify-end" title="${esc(month)} ${esc(money(value, active.currency))} · ${active.orders[index] ?? 0} 笔">
        <div class="w-full rounded-t ${tone} transition" style="height:${height}%"></div>
      </div>`;
    })
    .join("");

  monthsEl.innerHTML = stats.revenue.months
    .map((month) => `<div class="flex-1 text-center text-[10px] text-ink-muted">${esc(month)}</div>`)
    .join("");
}

/* -------------------------------- 列表渲染 ------------------------------- */

function renderPager<T>(
  el: HTMLElement,
  data: Page<T>,
  onChange: (page: number) => void,
): void {
  el.innerHTML = `<span>共 ${data.total} 条 · 第 ${data.page} / ${data.pages} 页</span>
    <div class="flex gap-1.5">
      <button type="button" data-page="${data.page - 1}" ${data.page <= 1 ? "disabled" : ""} class="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-secondary transition hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">上一页</button>
      <button type="button" data-page="${data.page + 1}" ${data.page >= data.pages ? "disabled" : ""} class="rounded-lg border border-border px-2.5 py-1 text-xs text-ink-secondary transition hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">下一页</button>
    </div>`;

  el.querySelectorAll<HTMLButtonElement>("button[data-page]").forEach((btn) => {
    btn.addEventListener("click", () => onChange(Number(btn.dataset.page)));
  });
}

async function loadUsers(): Promise<void> {
  const query = new URLSearchParams({
    page: String(state.users.page),
    pageSize: "20",
    type: state.users.type,
  });
  if (state.users.q) query.set("q", state.users.q);

  try {
    const data = await api<Page<UserItem>>(`/users?${query.toString()}`);
    state.users.data = data;
    showLoadError(null);

    $("users-total").textContent = `${data.total} 位用户`;
    const body = $("users-body");
    body.innerHTML = data.items.length
      ? data.items
          .map((u) => {
            const planLabel = u.plan === "year" ? "Pro 年付" : u.plan === "month" ? "Pro 月付" : "Pro";
            const statusBadge = u.isPro
              ? badge(planLabel, "pro")
              : u.proUntil
                ? badge("已过期", "warn")
                : badge("免费", "free");
            const paidText = u.paid.length
              ? u.paid
                  .map((p) => `${money(p.amount, p.currency)}<span class="text-ink-muted"> / ${p.orders} 笔</span>`)
                  .join("<br />")
              : `<span class="text-ink-muted">—</span>`;

            return `<tr class="transition hover:bg-surface-2/50">
              <td class="px-4 py-3">
                <div class="font-medium text-ink">${esc(u.name || "未设置昵称")}</div>
                <div class="mt-0.5 text-xs text-ink-muted">${esc(u.email)}</div>
              </td>
              <td class="px-4 py-3 text-xs text-ink-secondary">${esc(fmtDate(u.createdAt))}</td>
              <td class="px-4 py-3">${statusBadge}</td>
              <td class="px-4 py-3 text-xs text-ink-secondary">
                ${esc(u.isPro ? fmtDate(u.proUntil) : "—")}
                ${u.cancelAtPeriodEnd && u.isPro ? `<div class="text-[10px] text-warning">到期后不续费</div>` : ""}
              </td>
              <td class="px-4 py-3 text-right text-xs tabular-nums">${paidText}</td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="5" class="px-4 py-12 text-center text-xs text-ink-muted">没有匹配的用户</td></tr>`;

    renderPager($("users-pager"), data, (page) => {
      state.users.page = page;
      void loadUsers();
    });
  } catch (error) {
    handleApiError(error);
  }
}

async function loadPayments(): Promise<void> {
  const query = new URLSearchParams({
    page: String(state.payments.page),
    pageSize: "20",
  });
  if (state.payments.q) query.set("q", state.payments.q);
  if (state.payments.status) query.set("status", state.payments.status);

  try {
    const data = await api<Page<PaymentItem>>(`/payments?${query.toString()}`);
    state.payments.data = data;
    showLoadError(null);

    $("payments-total").textContent = `${data.total} 条记录`;
    const body = $("payments-body");
    body.innerHTML = data.items.length
      ? data.items
          .map((p) => {
            const planLabel =
              p.plan === "year" ? (p.autoRenew ? "年付订阅" : "年付一次性") : p.autoRenew ? "月付订阅" : "月付一次性";
            const statusBadge =
              p.status === "paid"
                ? badge("已支付", "ok")
                : p.status === "refunded"
                  ? badge("已退款", "danger")
                  : p.status === "failed"
                    ? badge("支付失败", "warn")
                    : badge(p.status, "free");

            return `<tr class="transition hover:bg-surface-2/50">
              <td class="px-4 py-3">
                <div class="text-sm text-ink">${esc(p.email ?? "未知用户")}</div>
                <div class="mt-0.5 text-[11px] text-ink-muted">${esc(p.name || "")}</div>
              </td>
              <td class="px-4 py-3 text-xs text-ink-secondary">${esc(planLabel)}</td>
              <td class="px-4 py-3 text-right text-xs font-medium tabular-nums">${esc(money(p.amount, p.currency))}</td>
              <td class="px-4 py-3">${statusBadge}</td>
              <td class="px-4 py-3 text-xs text-ink-secondary">${esc(fmtDateTime(p.paidAt ?? p.createdAt))}</td>
              <td class="px-4 py-3">
                <span class="block max-w-[180px] truncate font-mono text-[11px] text-ink-muted" title="${esc(p.orderId)}">${esc(p.orderId)}</span>
              </td>
            </tr>`;
          })
          .join("")
      : `<tr><td colspan="6" class="px-4 py-12 text-center text-xs text-ink-muted">没有匹配的记录</td></tr>`;

    renderPager($("payments-pager"), data, (page) => {
      state.payments.page = page;
      void loadPayments();
    });
  } catch (error) {
    handleApiError(error);
  }
}

/* --------------------------------- 交互 --------------------------------- */

document.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab as typeof state.tab;
    state.tab = tab;
    document.querySelectorAll<HTMLButtonElement>("button[data-tab]").forEach((b) => {
      b.dataset.active = String(b.dataset.tab === tab);
    });
    $("tab-overview").hidden = tab !== "overview";
    $("tab-users").hidden = tab !== "users";
    $("tab-payments").hidden = tab !== "payments";

    if (tab === "users") void loadUsers();
    if (tab === "payments") void loadPayments();
  });
});

function debounce(handler: () => void, delay = 300): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(handler, delay);
  };
}

const onUsersSearch = debounce(() => {
  state.users.q = ($("users-search") as HTMLInputElement).value.trim();
  state.users.page = 1;
  void loadUsers();
});

$("users-search").addEventListener("input", onUsersSearch);
($("users-type") as HTMLSelectElement).addEventListener("change", (event) => {
  state.users.type = (event.target as HTMLSelectElement).value;
  state.users.page = 1;
  void loadUsers();
});

const onPaymentsSearch = debounce(() => {
  state.payments.q = ($("payments-search") as HTMLInputElement).value.trim();
  state.payments.page = 1;
  void loadPayments();
});

$("payments-search").addEventListener("input", onPaymentsSearch);
($("payments-status") as HTMLSelectElement).addEventListener("change", (event) => {
  state.payments.status = (event.target as HTMLSelectElement).value;
  state.payments.page = 1;
  void loadPayments();
});

/* --------------------------------- 启动 --------------------------------- */

async function boot(): Promise<void> {
  try {
    const me = await api<{ ok: boolean; username: string }>("/me");
    await enterApp(me.username);
  } catch {
    showLogin();
  }
}

void boot();