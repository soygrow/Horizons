/**
 * 账户页交互：登录态 → 订阅状态 → Paddle 结算 / 取消自动续费。
 *
 * 支付优先走 Paddle.js overlay：服务端建 transaction 并下发 client token，
 * price_id 始终不出服务端；没配 client token 时退化为跳转 checkout.url。
 * 付完后靠 /api/billing/sync 与 /api/billing/me 确认（webhook 才是权威来源，
 * 这里只是把「付了但页面没变」的等待感消掉）。
 */

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

const PENDING_TXN_KEY = "hzn_pending_txn";
const POLL_INTERVAL_MS = 2500;
const POLL_ATTEMPTS = 24;

/** Paddle.js 的 sandbox 与生产是两套 CDN，client token 也不通用 */
const PADDLE_SDK_URL = {
  sandbox: "https://sandbox-cdn.paddle.com/paddle/v2/paddle.js",
  production: "https://cdn.paddle.com/paddle/v2/paddle.js",
} as const;

type PaddleEnv = keyof typeof PADDLE_SDK_URL;

interface PaddleJs {
  Environment: { set: (env: string) => void };
  Initialize: (opts: {
    token: string;
    eventCallback?: (event: { name: string }) => void;
  }) => void;
  Checkout: { open: (opts: { transactionId: string; settings?: Record<string, unknown> }) => void };
}

let paddleLoading: Promise<boolean> | null = null;

/**
 * 按需加载 Paddle.js。返回 false 时调用方退化为跳转 checkout.url。
 * 只初始化一次，同一页面重复下单复用同一实例。
 */
function loadPaddleJs(env: PaddleEnv, token: string, onCompleted: () => void): Promise<boolean> {
  if (paddleLoading) return paddleLoading;

  paddleLoading = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = PADDLE_SDK_URL[env];
    script.async = true;
    script.onload = () => {
      try {
        const paddle = (window as unknown as { Paddle?: PaddleJs }).Paddle;
        if (!paddle) {
          resolve(false);
          return;
        }
        if (env === "sandbox") paddle.Environment.set("sandbox");
        paddle.Initialize({
          token,
          eventCallback: (event) => {
            if (event.name === "checkout.completed") onCompleted();
          },
        });
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });

  return paddleLoading;
}

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
    logout: document.getElementById("acct-logout"),
    plans: document.getElementById("acct-plans"),
    sub: document.getElementById("acct-sub"),
    subLine: document.getElementById("acct-sub-line"),
    subNext: document.getElementById("acct-sub-next"),
    cancel: document.getElementById("acct-cancel"),
    resume: document.getElementById("acct-resume"),
  };
  if (!els.main) return;

  const buyButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-plan]"),
  );

  let busy = false;

  function showNotice(text: string) {
    if (!els.notice) return;
    els.notice.textContent = text;
    els.notice.classList.remove("hidden");
  }

  function hideNotice() {
    els.notice?.classList.add("hidden");
  }

  function setBusy(next: boolean) {
    busy = next;
    for (const btn of buyButtons) {
      btn.disabled = next || btn.dataset.enabled !== "1";
      btn.classList.toggle("opacity-60", next);
    }
    for (const btn of [els.cancel, els.resume]) {
      if (btn instanceof HTMLButtonElement) btn.disabled = next;
    }
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

  async function refresh(): Promise<BillingMe | null> {
    const billing = await getJson<BillingMe>("/api/billing/me");
    if (billing) renderBilling(billing);
    return billing;
  }

  /** 从 Paddle 结算页回来后：先主动查一次（兜底），再短轮询等 webhook 落库 */
  async function settlePending(transactionId: string) {
    showNotice("正在确认支付结果，通常几秒内完成，请不要关闭页面…");

    await postJson("/api/billing/sync", { transactionId });

    for (let i = 0; i < POLL_ATTEMPTS; i += 1) {
      const billing = await refresh();
      // 订阅与一次性都落成 pro，判定只看权益本身
      const ok = billing?.plan === "pro";
      if (ok) {
        sessionStorage.removeItem(PENDING_TXN_KEY);
        showNotice("订阅已生效，Pro 权益已开通。");
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }

    sessionStorage.removeItem(PENDING_TXN_KEY);
    showNotice("暂未查到支付结果。若银行已扣款，权益会在几分钟内自动开通，可稍后刷新本页。");
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
        }>("/api/billing/checkout", { plan, autoRenew });

        if (res.status === 409) {
          setBusy(false);
          showNotice("你已有一个生效中的订阅，无需重复下单。");
          void refresh();
          return;
        }

        if (!res.ok || !res.data?.transactionId) {
          setBusy(false);
          showNotice(
            res.status === 503
              ? "支付通道尚未配置完成，暂时无法下单。"
              : "创建订单失败，请稍后重试。",
          );
          return;
        }

        const { transactionId } = res.data;
        sessionStorage.setItem(PENDING_TXN_KEY, transactionId);

        // 优先 overlay：不离开站点，付完就地轮询权益
        if (res.data.clientToken) {
          const ready = await loadPaddleJs(res.data.paddleEnv ?? "sandbox", res.data.clientToken, () => {
            void settlePending(transactionId);
          });
          const paddle = (window as unknown as { Paddle?: PaddleJs }).Paddle;
          if (ready && paddle) {
            setBusy(false);
            paddle.Checkout.open({ transactionId, settings: { displayMode: "overlay" } });
            return;
          }
        }

        // 兜底：跳 Paddle 返回的结算链接（需后台配好默认支付链接）
        if (res.data.checkoutUrl) {
          window.location.href = res.data.checkoutUrl;
          return;
        }

        setBusy(false);
        showNotice("结算页未能打开，请刷新后重试，或联系 308541325@qq.com。");
      });
    }
  }

  function wireSubscriptionActions() {
    els.cancel?.addEventListener("click", async () => {
      if (busy) return;
      const ok = window.confirm(
        "取消后不再自动续费，当期权益保留到期日为止，之后不会扣款。确定取消吗？",
      );
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

    const billing = await refresh();

    const pending = sessionStorage.getItem(PENDING_TXN_KEY);
    if (pending && billing) {
      await settlePending(pending);
    }
  }

  els.logout?.addEventListener("click", async () => {
    await postJson("/api/auth/logout", {});
    window.location.href = "/";
  });

  void main();
}