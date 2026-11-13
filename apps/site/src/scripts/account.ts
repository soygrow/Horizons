/**
 * 账户页交互：登录态 → 订阅状态 → Paddle 结算 / 取消自动续费。
 *
 * 支付优先走 Paddle.js overlay：服务端建 transaction 并下发 client token，
 * price_id 始终不出服务端；没配 client token 时退化为跳转 checkout.url。
 * 付完后靠 /api/billing/sync 与 /api/billing/me 确认（webhook 才是权威来源，
 * 这里只是把「付了但页面没变」的等待感消掉）。
 */

import { getPaddle, loadPaddleJs, type PaddleEnv } from "../lib/paddle-overlay";
import { confirmAction } from "../lib/confirm";
import { clearPending, readPending, writePending } from "../lib/pending-order";
import { hideToast, showToast } from "../lib/toast";
import { formatCount, formatMom } from "../lib/format";
import {
  fetchRemoteFavorites,
  mergeLocalFavorites,
  readLocalFavorites,
  removeFavorite,
} from "../lib/favorites";

interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

interface Order {
  id: string;
  plan: string;
  amount_cents: number;
  currency: string;
  status: string;
  paid_at: number | null;
  created_at: number;
}

interface Subscription {
  status: "active" | "trialing" | "past_due" | "paused" | "canceled";
  plan: string;
  currency: string;
  amount: number;
  currentPeriodEnd: number | null;
  nextBilledAt: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
}

interface BillingMe {
  configured: boolean;
  cnyAvailable: boolean;
  oneTimeAvailable: boolean;
  currency: "USD" | "CNY";
  plan: "free" | "pro";
  proUntil: number | null;
  subscription: Subscription | null;
  orders: Order[];
}

type PlanId = "month" | "year";

/** 同一笔只轮询一次，否则每次进账户页都要空等半分钟 */
const SETTLE_TRIED_KEY = "hzn_settle_tried";
/** 太旧的待确认单不自动查：多半是用户根本没付，让他盯着「正在确认」30 秒毫无意义 */
const SETTLE_FRESH_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 12;



/** 与 Paddle 后台的价格保持一致；仅用于展示，真实金额由结算页决定 */
const PRICES = {
  USD: { month: 2000, year: 16000, yearOriginal: 24000, onceMonth: 2300, onceYear: 18000 },
  CNY: { month: 14900, year: 109900, yearOriginal: 159900, onceMonth: 16900, onceYear: 129900 },
} as const;

const ORDER_STATUS: Record<string, string> = {
  paid: "已支付",
  refunded: "已退款",
  failed: "支付失败",
};

const SUB_STATUS: Record<string, string> = {
  active: "自动续费中",
  trialing: "试用中",
  past_due: "扣款失败，正在重试",
  paused: "已暂停",
  canceled: "已取消",
};

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD"]);

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatAmount(cents: number, currency: string): string {
  const zero = ZERO_DECIMAL.has(currency.toUpperCase());
  const value = zero ? cents : cents / 100;
  try {
    return new Intl.NumberFormat(currency === "CNY" ? "zh-CN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: zero ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

/** 统一 YYYY-MM-DD，与 lib/format 同口径 */
function formatDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    let data: T | null = null;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export function initAccount() {
  const els = {
    loading: document.getElementById("acct-loading"),
    guest: document.getElementById("acct-guest"),
    main: document.getElementById("acct-main"),
    avatar: document.getElementById("acct-avatar"),
    name: document.getElementById("acct-name"),
    email: document.getElementById("acct-email"),
    plan: document.getElementById("acct-plan"),
    planBadge: document.getElementById("acct-plan-badge"),
    notice: document.getElementById("acct-notice"),
    orders: document.getElementById("acct-orders"),
    doing: document.getElementById("acct-doing"),
    doingSummary: document.getElementById("acct-doing-summary"),
    favs: document.getElementById("acct-favs"),
    favsSummary: document.getElementById("acct-favs-summary"),
    logout: document.getElementById("acct-logout"),
    plans: document.getElementById("acct-plans"),
    sub: document.getElementById("acct-sub"),
    subLine: document.getElementById("acct-sub-line"),
    subNext: document.getElementById("acct-sub-next"),
    cancel: document.getElementById("acct-cancel"),
    resume: document.getElementById("acct-resume"),
    pending: document.getElementById("acct-pending"),
    pendingText: document.getElementById("acct-pending-text"),
    pendingPay: document.getElementById("acct-pending-pay"),
    pendingDrop: document.getElementById("acct-pending-drop"),
  };
  if (!els.main) return;

  const buyButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-plan]"),
  );

  let busy = false;

  function showNotice(text: string) {
    showToast(text, 8000);
  }

  function hideNotice() {
    hideToast();
  }

  function setBusy(next: boolean) {
    busy = next;
    for (const btn of buyButtons) {
      btn.disabled = next || btn.dataset.enabled !== "1";
      btn.classList.toggle("opacity-60", next);
    }
    for (const btn of [els.cancel, els.resume, els.pendingPay]) {
      if (btn instanceof HTMLButtonElement) btn.disabled = next;
    }
  }

  /** 「有一笔没付完」的提示条：默认 hidden，显示时换成 flex 才不会和 hidden 打架 */
  function showPendingBanner(plan?: string) {
    if (!els.pending || !els.pendingText) return;
    const label = plan ? `这笔${plan}订单` : "这笔订单";
    els.pendingText.textContent = `你有${label}还没付完，继续支付即可完成，不需要重新下单。`;
    els.pending.classList.remove("hidden");
    els.pending.classList.add("flex");
  }

  function hidePendingBanner() {
    if (!els.pending) return;
    els.pending.classList.add("hidden");
    els.pending.classList.remove("flex");
  }

  /**
   * 拉起 overlay 付一笔已存在的 transaction。
   * 返回 false 表示 Paddle.js 没起来，调用方自己决定退化为跳链接还是报错。
   */
  async function openOverlay(
    transactionId: string,
    clientToken: string | null | undefined,
    env: PaddleEnv | undefined,
    onClosed?: () => void,
  ): Promise<boolean> {
    if (!clientToken) return false;

    const ready = await loadPaddleJs(
      env ?? "sandbox",
      clientToken,
      // 付完了要强制查一次，不能被「这笔查过了」的短路挡住
      () => void settlePending(transactionId, true),
      onClosed,
    );
    const paddle = getPaddle();
    if (!ready || !paddle) return false;

    paddle.Checkout.open({ transactionId, settings: { displayMode: "overlay" } });
    return true;
  }

  function renderProfile(user: SessionUser) {
    if (els.name) els.name.textContent = user.name ?? "未命名用户";
    if (els.email) els.email.textContent = user.email;
    if (!els.avatar) return;
    if (user.avatarUrl) {
      els.avatar.textContent = "";
      const img = document.createElement("img");
      img.src = user.avatarUrl;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      img.className = "h-14 w-14 rounded-full object-cover";
      els.avatar.className = "shrink-0";
      els.avatar.appendChild(img);
    } else {
      els.avatar.className =
        "flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-semibold text-white";
      els.avatar.textContent = (user.name ?? user.email).trim().charAt(0).toUpperCase();
    }
  }

  function renderPrices(currency: "USD" | "CNY") {
    const price = PRICES[currency] ?? PRICES.USD;
    const table: Record<string, number> = {
      month: price.month,
      year: price.year,
      "year-original": price.yearOriginal,
      "once-month": price.onceMonth,
      "once-year": price.onceYear,
    };
    document.querySelectorAll<HTMLElement>("[data-price]").forEach((el) => {
      const cents = table[el.dataset.price ?? ""];
      if (typeof cents === "number") el.textContent = formatAmount(cents, currency);
    });
  }

  function renderSubscription(billing: BillingMe, isPro: boolean) {
    const sub = billing.subscription;
    const canManage = Boolean(sub) && sub!.status !== "canceled";

    // 有生效权益就收起购买入口（订阅在下面管理，一次性买断没有管理区）；
    // 已取消的订阅保留到期末，此时允许重新下单
    const hidePlans = isPro && (sub ? sub.status !== "canceled" : true);
    if (els.plans) els.plans.style.display = hidePlans ? "none" : "";

    // 一次性按钮额外依赖「Paddle 后台建过一次性价格」，没配就置灰而不是报错
    for (const btn of buyButtons) {
      const oneTime = btn.dataset.autorenew === "0";
      const available = billing.configured && (!oneTime || billing.oneTimeAvailable);
      btn.dataset.enabled = available ? "1" : "0";
      btn.disabled = !available;
      btn.title = !billing.configured
        ? "Paddle 尚未配置，暂时无法下单"
        : oneTime && !available
          ? "一次性购买暂未开放，可用自动续费下单"
          : "";
    }

    if (!els.sub) return;
    if (!sub) {
      els.sub.style.display = "none";
      return;
    }

    els.sub.style.display = "";

    const statusLabel = SUB_STATUS[sub.status] ?? sub.status;
    const planLabel = sub.plan === "year" ? "年付" : "月付";
    if (els.subLine) {
      els.subLine.textContent = `${planLabel} · ${formatAmount(sub.amount, sub.currency || billing.currency)} · ${statusLabel}`;
    }

    if (els.subNext) {
      if (sub.status === "canceled") {
        els.subNext.textContent = sub.currentPeriodEnd
          ? `订阅已结束，Pro 权益保留至 ${formatDate(sub.currentPeriodEnd)}。`
          : "订阅已结束。";
      } else if (sub.cancelAtPeriodEnd) {
        els.subNext.textContent = `已取消自动续费，Pro 权益保留至 ${formatDate(
          sub.currentPeriodEnd ?? Date.now(),
        )}，之后不会扣款。可随时恢复。`;
      } else if (sub.nextBilledAt) {
        els.subNext.textContent = `下次自动扣款：${formatDate(sub.nextBilledAt)}（${formatAmount(
          sub.amount,
          sub.currency || billing.currency,
        )}）。到期前 3 天可在 Paddle 收据邮件里改支付方式。`;
      } else {
        els.subNext.textContent = "自动续费已开启。";
      }
    }

    const showResume = sub.status !== "canceled" && sub.cancelAtPeriodEnd;
    const showCancel = sub.status !== "canceled" && !sub.cancelAtPeriodEnd;
    els.cancel?.classList.toggle("hidden", !showCancel);
    els.resume?.classList.toggle("hidden", !showResume);
  }

  function renderBilling(billing: BillingMe) {
    const isPro =
      billing.plan === "pro" &&
      typeof billing.proUntil === "number" &&
      billing.proUntil > Date.now();

    renderPrices(billing.currency === "CNY" ? "CNY" : "USD");

    if (els.plan) {
      if (isPro && billing.proUntil) {
        const days = Math.max(1, Math.ceil((billing.proUntil - Date.now()) / 86_400_000));
        els.plan.textContent = `Pro 有效至 ${formatDate(billing.proUntil)}（剩 ${days} 天）`;
      } else if (billing.proUntil) {
        els.plan.textContent = `Pro 已于 ${formatDate(billing.proUntil)} 到期，重新订阅即可继续使用`;
      } else {
        els.plan.textContent = "当前为免费版，开通 Pro 后可获得全量数据与导出能力";
      }
    }

    // 标签跟着用户名走，放在资料卡里，套餐状态一眼可见
    if (els.planBadge) {
      els.planBadge.textContent = isPro ? "Pro 用户" : "免费用户";
      els.planBadge.className = isPro
        ? "shrink-0 rounded-full bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary"
        : "shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted";
    }

    renderSubscription(billing, isPro);

    if (!billing.configured) {
      showNotice("支付通道尚未配置完成（缺少 Paddle 密钥或价格 ID），暂时无法下单。");
    }

    renderOrders(billing.orders);
  }

  function renderOrders(orders: Order[]) {
    if (!els.orders) return;
    if (!orders.length) {
      els.orders.innerHTML = '<p class="px-5 py-6 text-sm text-ink-muted">暂无订单</p>';
      return;
    }

    const rows = orders
      .map((o) => {
        const when = o.paid_at ?? o.created_at;
        const planLabel = o.plan === "year" ? "年付" : "月付";
        const statusLabel = ORDER_STATUS[o.status] ?? o.status;
        const statusClass =
          o.status === "paid"
            ? "text-accent"
            : o.status === "refunded"
              ? "text-warning"
              : "text-ink-muted";
        return `<tr class="border-t border-border/60">
          <td class="px-5 py-3 text-sm text-ink-secondary">${esc(formatDate(when))}</td>
          <td class="px-5 py-3 text-sm text-ink">${esc(planLabel)}</td>
          <td class="px-5 py-3 text-sm text-ink tabular-nums">${esc(formatAmount(o.amount_cents, o.currency))}</td>
          <td class="px-5 py-3 text-sm ${statusClass}">${esc(statusLabel)}</td>
        </tr>`;
      })
      .join("");

    els.orders.innerHTML = `<table class="w-full">
      <thead>
        <tr class="bg-surface-2/60 text-left text-xs text-ink-muted">
          <th class="px-5 py-2 font-medium">时间</th>
          <th class="px-5 py-2 font-medium">方案</th>
          <th class="px-5 py-2 font-medium">金额</th>
          <th class="px-5 py-2 font-medium">状态</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /* ---------------------------- 在做机会 ---------------------------- */

  interface MyDoing {
    slug: string;
    status: string;
    joinedAt: number;
    updateCount: number;
    lastAt: number;
  }

  function formatDateTime(ms: number): string {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** 构建期注入的 slug→标题映射；查不到说明该机会已下架 */
  function oppTitleMap(): Record<string, string> {
    const el = document.getElementById("acct-opp-titles");
    if (!el?.textContent) return {};
    try {
      return JSON.parse(el.textContent) as Record<string, string>;
    } catch {
      return {};
    }
  }

  function renderDoing(items: MyDoing[]) {
    const box = els.doing;
    const summary = els.doingSummary;
    if (!box) return;

    if (!items.length) {
      box.innerHTML =
        '<p class="rounded-xl border border-border bg-surface px-5 py-6 text-sm text-ink-muted">还没有参与的机会。在机会详情页点「我在做」就会出现在这里，留不留言都算。</p>';
      if (summary) summary.textContent = "还没有参与的机会";
      return;
    }

    const titles = oppTitleMap();
    const withNotes = items.filter((i) => i.updateCount > 0).length;
    if (summary) {
      summary.textContent = `共 ${items.length} 个${
        withNotes ? `，其中 ${withNotes} 个有留言` : ""
      }，按最近活动排序`;
    }

    box.innerHTML = items
      .map((it) => {
        const name = titles[it.slug] ?? it.slug;
        const meta = [`加入于 ${formatDate(it.joinedAt)}`];
        if (it.updateCount > 0) meta.push(`${it.updateCount} 条留言`);
        meta.push(`最近 ${formatDate(it.lastAt)}`);

        const head = `<p class="truncate text-sm font-medium text-ink">${esc(name)}</p>
          <p class="mt-1 truncate text-xs text-ink-muted">${esc(meta.join(" · "))}</p>`;

        // 已下架的机会没有详情页，标题不包链接，但仍允许取消
        const main = titles[it.slug]
          ? `<a href="/opportunity/${encodeURIComponent(it.slug)}" class="min-w-0 flex-1">${head}</a>`
          : `<div class="min-w-0 flex-1 opacity-70">${head}</div>`;

        return `<div class="flex items-center gap-3 rounded-xl border border-border bg-surface px-5 py-3.5 transition hover:border-primary/40">
            ${main}
            <button
              type="button"
              data-doing-cancel="${esc(it.slug)}"
              data-doing-name="${esc(name)}"
              data-doing-notes="${it.updateCount}"
              class="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-secondary transition hover:border-rose-400/50 hover:bg-rose-500/5 hover:text-rose-500"
            >取消</button>
          </div>`;
      })
      .join("");
  }

  async function loadDoing() {
    const data = await getJson<{ doing: MyDoing[] }>("/api/opportunity/mine/doing?limit=50");
    renderDoing(data?.doing ?? []);
  }

  /** 退出「我在做」：服务端会连同该机会下的留言一起删除 */
  async function leaveDoing(slug: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/opportunity/${encodeURIComponent(slug)}/doing`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 列表里的「取消」：事件委托，重渲染后不用重新绑定 */
  function wireDoingLeave() {
    els.doing?.addEventListener("click", async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-doing-cancel]");
      if (!btn || btn.disabled) return;

      const slug = btn.dataset.doingCancel || "";
      if (!slug) return;

      const name = btn.dataset.doingName || slug;
      const notes = Number(btn.dataset.doingNotes || 0);
      const ok = await confirmAction({
        title: "取消参与？",
        description:
          notes > 0
            ? `你在「${name}」下的 ${notes} 条留言会一起删除，之后可以重新加入。`
            : `取消后「${name}」不再出现在这里，之后可以重新加入。`,
        confirmText: "取消参与",
        cancelText: "先留着",
        tone: "danger",
      });
      if (!ok) return;

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "…";
      const done = await leaveDoing(slug);
      if (done) {
        void loadDoing();
      } else {
        btn.disabled = false;
        btn.textContent = label ?? "取消";
        showToast("取消失败，请稍后再试");
      }
    });
  }

  /* ---------------------------- 工具收藏 ---------------------------- */

  interface FavRow {
    domain: string;
    createdAt: number;
  }

  /** 展示指标来自榜单数据，库里只存 domain，避免快照过期 */
  interface ToolIndexRow {
    domain: string;
    name: string;
    visits: number | null;
    mom: number | null;
    grank: number | null;
  }

  let toolsIndex: Map<string, ToolIndexRow> | null = null;

  async function getToolsIndex(): Promise<Map<string, ToolIndexRow>> {
    if (toolsIndex) return toolsIndex;
    const rows = await getJson<ToolIndexRow[]>("/data/tools.json");
    toolsIndex = new Map((rows ?? []).map((r) => [r.domain, r]));
    return toolsIndex;
  }

  function renderFavorites(items: FavRow[], index: Map<string, ToolIndexRow>) {
    const box = els.favs;
    const summary = els.favsSummary;
    if (!box) return;

    if (!items.length) {
      box.innerHTML =
        '<p class="rounded-xl border border-border bg-surface px-5 py-6 text-sm text-ink-muted">还没有收藏工具。在任意工具详情页点「收藏」会同步到这里；未登录时先存在本机，登录后自动并入账号。</p>';
      if (summary) summary.textContent = "还没有收藏";
      return;
    }

    let missed = 0;
    const rows = items.map((f) => {
      const t = index.get(f.domain);
      if (!t) {
        missed += 1;
        return `<div class="flex items-center gap-3 rounded-xl border border-dashed border-border bg-surface px-5 py-3.5">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium text-ink-muted">${esc(f.domain)}</p>
            <p class="mt-1 text-xs text-ink-muted">已下榜，暂不提供详情页</p>
          </div>
          <button type="button" data-fav-remove="${esc(f.domain)}" class="shrink-0 text-xs text-ink-muted transition hover:text-ink">取消</button>
        </div>`;
      }

      const meta = [t.domain];
      if (typeof t.visits === "number") meta.push(`月访问 ${formatCount(t.visits)}`);
      if (typeof t.mom === "number") meta.push(`环比 ${formatMom(t.mom)}`);
      if (typeof t.grank === "number") meta.push(`全球排名 #${t.grank.toLocaleString("en-US")}`);

      return `<div class="flex items-center gap-3 rounded-xl border border-border bg-surface px-5 py-3.5 transition hover:border-primary/40">
        <a href="/tools/${encodeURIComponent(t.domain)}" class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-ink">${esc(t.name || t.domain)}</p>
          <p class="mt-1 truncate text-xs text-ink-muted">${esc(meta.join(" · "))}</p>
        </a>
        <button type="button" data-fav-remove="${esc(t.domain)}" class="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs text-ink-secondary transition hover:border-border-strong hover:bg-surface-2 hover:text-ink">取消</button>
      </div>`;
    });

    if (summary) summary.textContent = `共 ${items.length} 个${missed ? `，其中 ${missed} 个已下榜` : ""}`;
    box.innerHTML = rows.join("");
  }

  async function loadFavorites() {
    // 未登录期间的收藏在本机：先并入账号再读服务端，避免「明明收藏过却不显示」
    if (readLocalFavorites().length) {
      const remote = await fetchRemoteFavorites();
      if (remote) await mergeLocalFavorites(remote);
    }

    const data = await getJson<{ favorites: FavRow[] }>("/api/favorites");
    const items = data?.favorites ?? [];
    const index = items.length ? await getToolsIndex() : new Map<string, ToolIndexRow>();
    renderFavorites(items, index);
  }

  /** 收藏行里的「取消」：事件委托，避免每次重渲染重复绑定 */
  function wireFavoriteRemoval() {
    els.favs?.addEventListener("click", async (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-fav-remove]");
      if (!btn || btn.disabled) return;

      const domain = btn.dataset.favRemove || "";
      if (!domain) return;

      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = "…";
      const ok = await removeFavorite(domain);
      if (ok) {
        void loadFavorites();
      } else {
        btn.disabled = false;
        btn.textContent = label ?? "取消";
      }
    });
  }

  async function refresh(): Promise<BillingMe | null> {
    const billing = await getJson<BillingMe>("/api/billing/me");
    if (billing) renderBilling(billing);
    return billing;
  }

  /** 从 Paddle 结算页回来后：先主动查一次（兜底），再短轮询等 webhook 落库 */
  async function settlePending(transactionId: string, force = false) {
    // 这笔已经查过一轮：不再空等，留着 pending 让「继续支付」还有用
    if (!force && sessionStorage.getItem(SETTLE_TRIED_KEY) === transactionId) return;
    sessionStorage.setItem(SETTLE_TRIED_KEY, transactionId);

    showNotice("正在确认支付结果，通常几秒内完成，请不要关闭页面…");

    await postJson("/api/billing/sync", { transactionId });

    for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
      const billing = await refresh();
      // 订阅与一次性都落成 pro，判定只看权益本身
      const ok = billing?.plan === "pro";
      if (ok) {
        clearPending();
        sessionStorage.removeItem(SETTLE_TRIED_KEY);
        hidePendingBanner();
        showNotice("订阅已生效，Pro 权益已开通。");
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // 不删 pending：没付完的人还能续上这笔，避免重复建单
    showNotice(
      "暂未查到支付结果。若银行已扣款，权益会在几分钟内自动开通；若未完成支付，可点上方「继续支付」完成这笔订单。",
    );

    // 确认没付成，把出口亮出来，别让用户只剩重新下单
    const still = readPending();
    if (still) showPendingBanner(still.plan);
  }

  function wireBuyButtons() {
    for (const btn of buyButtons) {
      btn.addEventListener("click", async () => {
        if (busy) return;
        const plan = btn.dataset.plan as PlanId | undefined;
        if (plan !== "month" && plan !== "year") return;

        // 默认自动续费；只有按钮显式标了 data-autorenew="0" 才走一次性
        const autoRenew = btn.dataset.autorenew !== "0";

        setBusy(true);
        hideNotice();

        const res = await postJson<{
          transactionId: string;
          checkoutUrl: string | null;
          clientToken?: string | null;
          paddleEnv?: PaddleEnv;
          proUntil?: number | null;
          paddleError?: string;
        }>("/api/billing/checkout", { plan, autoRenew });

        if (res.status === 409) {
          setBusy(false);
          const until = res.data?.proUntil;
          showNotice(
            typeof until === "number"
              ? `你当前已是 Pro，有效期至 ${formatDateTime(until).slice(0, 10)}，到期后可再次购买。`
              : "你已有一个生效中的订阅，无需重复下单。",
          );
          void refresh();
          return;
        }

        if (!res.ok || !res.data?.transactionId) {
          setBusy(false);
          showNotice(
            res.data?.paddleError
              ? `创建订单失败：${res.data.paddleError}`
              : res.status === 503
                ? "支付通道尚未配置完成，暂时无法下单。"
                : "创建订单失败，请稍后重试。",
          );
          return;
        }

        const { transactionId } = res.data;
        const planLabel = `${plan === "month" ? "月付" : "年付"}${autoRenew ? "" : "一次性"}`;
        // 连方案名一起记下，让「继续支付」的提示能说清是哪一笔
        writePending(transactionId, planLabel);

        // 优先 overlay：不离开站点，付完就地轮询权益；
        // 中途关掉就把「继续支付」亮出来，别让人以为钱白付了
        const opened = await openOverlay(
          transactionId,
          res.data.clientToken,
          res.data.paddleEnv,
          () => showPendingBanner(planLabel),
        );
        if (opened) {
          setBusy(false);
          return;
        }

        // 兜底：跳 Paddle 返回的结算链接（需后台配好默认支付链接）
        if (res.data.checkoutUrl) {
          window.location.href = res.data.checkoutUrl;
          return;
        }

        setBusy(false);
        showNotice("结算页未能打开，请刷新后重试，或联系 woshizhanghao1125@gmail.com。");
      });
    }
  }

  function wireSubscriptionActions() {
    els.cancel?.addEventListener("click", async () => {
      if (busy) return;
      const ok = await confirmAction({
        title: "取消自动续费？",
        description: "取消后不再自动续费，当期权益保留到期日为止，之后不会扣款。",
        confirmText: "取消自动续费",
        cancelText: "继续续费",
        tone: "danger",
      });
      if (!ok) return;

      setBusy(true);
      hideNotice();
      const res = await postJson("/api/billing/cancel", {});
      setBusy(false);

      if (res.ok) {
        await refresh();
        showNotice("已取消自动续费，当期权益保留到期日。");
      } else {
        showNotice("取消失败，请稍后重试或邮件联系我们。");
      }
    });

    els.resume?.addEventListener("click", async () => {
      if (busy) return;
      setBusy(true);
      hideNotice();
      const res = await postJson("/api/billing/resume", {});
      setBusy(false);

      if (res.ok) {
        await refresh();
        showNotice("已恢复自动续费。");
      } else {
        showNotice("恢复失败，请稍后重试或邮件联系我们。");
      }
    });
  }

  /** 账户页的「继续支付 / 放弃这笔」 */
  function wirePendingBanner() {
    els.pendingPay?.addEventListener("click", async () => {
      if (busy) return;

      const pending = readPending();
      if (!pending) {
        hidePendingBanner();
        showNotice("这笔订单的记录已过期，请重新选择方案。");
        return;
      }

      setBusy(true);
      hideNotice();

      const res = await postJson<{
        transactionId: string;
        status: string;
        completed: boolean;
        checkoutUrl: string | null;
        clientToken?: string | null;
        paddleEnv?: PaddleEnv;
        error?: string;
      }>("/api/billing/checkout/resume", { transactionId: pending.transactionId });

      // 已取消、已过期、或不属于当前账号：本地记录就是废的，清掉免得反复纠缠
      if (res.status === 409 || res.status === 400 || res.status === 403) {
        clearPending();
        hidePendingBanner();
        setBusy(false);
        showNotice("这笔订单已失效，请重新选择方案下单。");
        return;
      }

      if (!res.ok || !res.data?.transactionId) {
        setBusy(false);
        showNotice("暂时无法继续这笔订单，请稍后重试或邮件联系我们。");
        return;
      }

      // 其实已经付过了：不用再拉起结算页，直接等权益落库
      if (res.data.completed) {
        hidePendingBanner();
        setBusy(false);
        await settlePending(res.data.transactionId, true);
        return;
      }

      const opened = await openOverlay(
        res.data.transactionId,
        res.data.clientToken,
        res.data.paddleEnv,
        () => showPendingBanner(pending.plan),
      );
      setBusy(false);
      if (opened) return;

      if (res.data.checkoutUrl) {
        window.location.href = res.data.checkoutUrl;
        return;
      }

      showNotice("结算页未能打开，请刷新后重试，或联系 woshizhanghao1125@gmail.com。");
    });

    els.pendingDrop?.addEventListener("click", () => {
      clearPending();
      hidePendingBanner();
      showNotice("已放弃这笔订单，可随时重新下单。");
    });
  }

  async function main() {
    const me = await getJson<{ user: SessionUser | null }>("/api/me");
    els.loading?.classList.add("hidden");

    if (!me?.user) {
      els.guest?.classList.remove("hidden");
      return;
    }

    renderProfile(me.user);
    els.main?.classList.remove("hidden");
    wireBuyButtons();
    wireSubscriptionActions();
    wireFavoriteRemoval();
    wireDoingLeave();
    wirePendingBanner();
    void loadDoing();
    void loadFavorites();

    const billing = await refresh();

    const pending = readPending();
    if (!pending) return;

    if (billing?.plan === "pro") {
      // 已经是 Pro，残留记录只会误导，直接清掉
      clearPending();
      return;
    }

    if (Date.now() - pending.at < SETTLE_FRESH_MS) {
      // 刚新建的单多半是「付完刚跳回来」：先查一轮，查不到再由 settlePending 亮出「继续支付」
      void settlePending(pending.transactionId);
    } else {
      showPendingBanner(pending.plan);
    }
  }

  els.logout?.addEventListener("click", async () => {
    await postJson("/api/auth/logout", {});
    window.location.href = "/";
  });

  void main();
}