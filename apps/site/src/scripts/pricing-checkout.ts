/**
 * 定价页下单：点按钮就地拉起 Paddle overlay，不再中途跳到账户页。
 *
 * 分支：
 * - 未登录 → 先走 Google 登录，登录后回到 /pricing
 * - 已有生效订阅 → 提示，不重复下单
 * - 成功 → 写 pending txn 后由 overlay 完成；付完跳 /account 确认权益
 *   （账户页读到同一个 sessionStorage key 会自动 sync + 轮询）
 */

import { getPaddle, loadPaddleJs, type PaddleEnv } from "../lib/paddle-overlay";
import { trackPaywallClick } from "../lib/paywall-track";

const PENDING_TXN_KEY = "hzn_pending_txn";

type PlanId = "month" | "year";

interface CheckoutOk {
  transactionId: string;
  checkoutUrl: string | null;
  clientToken?: string | null;
  paddleEnv?: PaddleEnv;
}

function setNotice(text: string | null) {
  const el = document.getElementById("pricing-notice");
  if (!el) return;
  if (!text) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden");
}

function formatDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function initPricingCheckout() {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-checkout-plan]"),
  );
  if (!buttons.length) return;

  let busy = false;

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
          setNotice(
            res.status === 503
              ? "支付通道尚未配置完成，暂时无法下单。"
              : "创建订单失败，请稍后重试。",
          );
          return;
        }

        const data = (await res.json()) as CheckoutOk;

        // 优先 overlay：停在定价页完成支付，付完再回账户页看权益
        if (data.clientToken) {
          const env = data.paddleEnv ?? "sandbox";
          const ready = await loadPaddleJs(env, data.clientToken, () => {
            sessionStorage.setItem(PENDING_TXN_KEY, data.transactionId);
            window.location.href = "/account";
          });
          const paddle = getPaddle();
          if (ready && paddle) {
            paddle.Checkout.open({
              transactionId: data.transactionId,
              settings: { displayMode: "overlay" },
            });
            return;
          }
        }

        // 兜底：跳 Paddle 托管结算页
        if (data.checkoutUrl) {
          sessionStorage.setItem(PENDING_TXN_KEY, data.transactionId);
          window.location.href = data.checkoutUrl;
          return;
        }

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