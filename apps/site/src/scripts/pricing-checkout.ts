/**
 * 定价页下单：点按钮就地拉起 Paddle overlay，不再中途跳到账户页。
 *
 * 分支：
 * - 未登录 → 先走 Google 登录，登录后回到 /pricing
 * - 已有生效订阅 → 提示，不重复下单
 * - 成功 → 写 pending txn 后由 overlay 完成；付完跳 /account 确认权益
 *   （账户页读到同一个 sessionStorage key 会自动 sync + 轮询）
 * - 用户中途关掉 overlay → 不新建订单，页面顶部给「继续支付」，续上原来那笔 transaction
 *
 * 「不新建」是这个文件的核心约束：重复建单会在 Paddle 留一串草稿交易，
 * 既对不上账，也会让客户收到多封结算邮件。
 */

import { getPaddle, loadPaddleJs, type PaddleEnv } from "../lib/paddle-overlay";
import { trackPaywallClick } from "../lib/paywall-track";
import { clearPending, readPending, writePending } from "../lib/pending-order";
import { hideToast, showToast } from "../lib/toast";

const BANNER_ID = "hzn-resume-banner";

type PlanId = "month" | "year";

interface CheckoutOk {
  transactionId: string;
  checkoutUrl: string | null;
  clientToken?: string | null;
  paddleEnv?: PaddleEnv;
}

interface ResumeOk extends CheckoutOk {
  status: string;
  completed: boolean;
}

function setNotice(text: string | null) {
  if (text) {
    showToast(text);
    return;
  }
  hideToast();
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hideResumeBanner() {
  document.getElementById(BANNER_ID)?.remove();
}

/** 未付完的订单给一个恢复入口，点一下续上，不要重新下单 */
function showResumeBanner(onResume: () => void) {
  if (document.getElementById(BANNER_ID)) return;

  const bar = document.createElement("div");
  bar.id = BANNER_ID;
  bar.className =
    "mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-5 py-3.5";

  const text = document.createElement("p");
  text.className = "min-w-0 flex-1 text-sm text-ink-secondary";
  text.textContent = "你有一笔未完成的订单，继续支付即可完成，不需要重新下单。";

  const pay = document.createElement("button");
  pay.type = "button";
  pay.className =
    "shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition hover:bg-primary-hover";
  pay.textContent = "继续支付";
  pay.addEventListener("click", () => {
    hideResumeBanner();
    onResume();
  });

  const drop = document.createElement("button");
  drop.type = "button";
  drop.className = "shrink-0 text-xs text-ink-muted transition hover:text-ink";
  drop.textContent = "放弃这笔";
  drop.addEventListener("click", () => {
    hideResumeBanner();
    clearPending();
    setNotice("已放弃这笔订单，可随时重新下单。");
  });

  bar.append(text, pay, drop);

  // 挂在卡片区下方的提示位之前；页面结构变了就退化为插到 body 顶部
  const anchor = document.getElementById("pricing-notice");
  if (anchor?.parentElement) anchor.parentElement.insertBefore(bar, anchor);
  else document.body.insertBefore(bar, document.body.firstChild);
}

/**
 * 打开 overlay。返回 false 表示 Paddle.js 没起来，调用方应退化为跳 checkout.url。
 * onClosed 只在「没付成」时触发：付完 Paddle 也会发 closed，用 completed 挡掉。
 */
async function openOverlay(
  data: CheckoutOk,
  onClosed: () => void,
): Promise<boolean> {
  if (!data.clientToken) return false;

  const env = data.paddleEnv ?? "sandbox";
  let completed = false;

  const ready = await loadPaddleJs(
    env,
    data.clientToken,
    () => {
      completed = true;
      writePending(data.transactionId);
      window.location.href = "/account";
    },
    () => {
      if (completed) return;
      onClosed();
    },
  );

  const paddle = getPaddle();
  if (!ready || !paddle) return false;

  paddle.Checkout.open({
    transactionId: data.transactionId,
    settings: { displayMode: "overlay" },
  });
  return true;
}

function askForResume(transactionId: string) {
  showResumeBanner(() => {
    void resumeCheckout(transactionId);
  });
}

/** 续上一笔：拿到新的 client token 后重新拉起同一个 transaction */
async function resumeCheckout(transactionId: string) {
  setNotice(null);
  try {
    const res = await fetch("/api/billing/checkout/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ transactionId }),
    });

    if (res.status === 401) {
      window.location.href = `/api/auth/google?next=${encodeURIComponent("/pricing")}`;
      return;
    }

    if (!res.ok) {
      clearPending();
      setNotice("这笔订单已失效，请重新下单。");
      return;
    }

    const data = (await res.json()) as ResumeOk;

    if (data.completed) {
      clearPending();
      window.location.href = "/account";
      return;
    }

    const opened = await openOverlay(data, () => askForResume(transactionId));
    if (opened) return;

    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
      return;
    }

    clearPending();
    setNotice("结算页未能打开，请刷新后重试。");
  } catch {
    setNotice("网络异常，请稍后重试。");
  }
}

export function initPricingCheckout() {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-checkout-plan]"),
  );
  if (!buttons.length) return;

  let busy = false;

  // 上次留下未付完的订单：进页面就提示可续上（已付清的那种点进去会直接跳账户页）
  const pending = readPending();
  if (pending) askForResume(pending.transactionId);

  for (const btn of buttons) {
    btn.addEventListener("click", async () => {
      if (busy) return;

      const plan = btn.dataset.checkoutPlan as PlanId | undefined;
      if (plan !== "month" && plan !== "year") return;

      // 只有显式标了 0 才走一次性，避免漏写属性时静默变成不续费
      const autoRenew = btn.dataset.autorenew !== "0";

      busy = true;
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = "正在打开结算页…";
      setNotice(null);
      hideResumeBanner();

      try {
        const res = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ plan, autoRenew }),
        });

        // 只有登录后的点击才计数：401 说明这次点击只是去登录，不算一次购买意图
        if (res.status !== 401) {
          trackPaywallClick(`pricing.${plan}.${autoRenew ? "auto" : "once"}`);
        }

        if (res.status === 401) {
          window.location.href = `/api/auth/google?next=${encodeURIComponent("/pricing")}`;
          return;
        }

        if (res.status === 409) {
          const info = (await res.json().catch(() => null)) as {
            proUntil?: number | null;
          } | null;
          const until = info?.proUntil;
          setNotice(
            typeof until === "number"
              ? `你当前已是 Pro，有效期至 ${formatDay(until)}，到期后可再次购买。`
              : "你已有一个生效中的订阅，无需重复购买，可以直接使用 Pro 权益。",
          );
          return;
        }

        if (!res.ok) {
          const info = (await res.json().catch(() => null)) as {
            paddleError?: string;
          } | null;
          setNotice(
            info?.paddleError
              ? `创建订单失败：${info.paddleError}`
              : res.status === 503
                ? "支付通道尚未配置完成，暂时无法下单。"
                : "创建订单失败，请稍后重试。",
          );
          return;
        }

        const data = (await res.json()) as CheckoutOk;

        // 先记下这笔，关掉 overlay 也能回来续，而不是重新建单。
        // 换计划时这里会直接覆盖：旧单留在 Paddle 里不可再支付，本地的「继续支付」也就自然指向新单
        writePending(data.transactionId);

        // 优先 overlay：停在定价页完成支付，付完再回账户页看权益
        const opened = await openOverlay(data, () => askForResume(data.transactionId));
        if (opened) return;

        // 兜底：跳 Paddle 托管结算页
        if (data.checkoutUrl) {
          window.location.href = data.checkoutUrl;
          return;
        }

        clearPending();
        setNotice("结算页未能打开，请刷新后重试。");
      } catch {
        setNotice("网络异常，请稍后重试。");
      } finally {
        busy = false;
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  }
}