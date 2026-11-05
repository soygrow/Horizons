/**
 * 计费路由：Paddle 双模式 —— 订阅（自动续费）与一次性买断（不续费）。
 *
 * 真相在 Paddle：订阅周期、下次扣款、欠费重试都由它管；我们只做三件事——
 * 1) webhook 把 subscription 镜像到 D1（subscriptions 表），同步 users.pro_until 作为权益缓存
 * 2) 一次性交易（transaction 没有 subscription_id）按天数给 pro_until 加时长，幂等靠 orders.granted_at
 * 3) 提供 checkout / cancel / resume / sync 四个动作
 *
 * 权益判定统一用 pro_until > now，前端和权限中间件都只读这一个字段。
 */

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { verifySession, SESSION_COOKIE } from "../lib/session";
import {
  cancelPaddleSubscription,
  createCheckout,
  ensureCustomer,
  getPaddleSubscription,
  getPaddleTransaction,
  isPaddleConfigured,
  normalizeSubscription,
  PaddleError,
  priceIdFor,
  resumePaddleSubscription,
  supportsCny,
  supportsOneTime,
  verifyPaddleSignature,
  type Currency,
  type PaddleSubscription,
  type PaddleTransaction,
  type PlanId,
  type RawSubscription,
} from "../lib/paddle";

export const billing = new Hono<{ Bindings: Env }>();

async function readSession(c: Context<{ Bindings: Env }>) {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return verifySession(token, c.env.SESSION_SECRET);
}

function parsePlan(input: unknown): PlanId | null {
  return input === "month" || input === "year" ? input : null;
}

/** 中国客户走 CNY 价格（支付宝只对 CNY 定价商品展示），其余走 USD */
function currencyFor(c: Context<{ Bindings: Env }>): Currency {
  const country = (c.req.header("cf-ipcountry") ?? "").toUpperCase();
  return country === "CN" && supportsCny(c.env) ? "CNY" : "USD";
}

/* ------------------------------ 订阅落库 ------------------------------ */

function userIdFromCustom(custom: Record<string, unknown> | null | undefined): string | null {
  const value = custom?.user_id;
  return typeof value === "string" && value ? value : null;
}

async function resolveUserId(
  env: Env,
  opts: { custom?: Record<string, unknown> | null; subscriptionId?: string | null; customerId?: string | null },
): Promise<string | null> {
  const fromCustom = userIdFromCustom(opts.custom);
  if (fromCustom) return fromCustom;

  if (opts.subscriptionId) {
    const row = await env.DB.prepare("SELECT user_id FROM subscriptions WHERE id = ?")
      .bind(opts.subscriptionId)
      .first<{ user_id: string }>();
    if (row?.user_id) return row.user_id;
  }

  if (opts.customerId) {
    const row = await env.DB.prepare("SELECT id FROM users WHERE paddle_customer_id = ?")
      .bind(opts.customerId)
      .first<{ id: string }>();
    if (row?.id) return row.id;
  }

  return null;
}

/**
 * 把 Paddle 订阅镜像到 D1，并同步权益缓存。
 * 幂等：同一订阅重复投递只是覆盖同样的值；乱序投递以 updated_at 较新者为准。
 */
async function saveSubscription(
  env: Env,
  sub: PaddleSubscription,
  hints: { userId?: string | null } = {},
): Promise<boolean> {
  const userId =
    hints.userId ??
    (await resolveUserId(env, {
      custom: sub.customData,
      subscriptionId: sub.id,
      customerId: sub.customerId,
    }));
  if (!userId) {
    console.warn("[paddle] subscription without user", sub.id, sub.customerId);
    return false;
  }

  const plan = parsePlan(sub.customData?.plan) ?? (sub.billingInterval === "year" ? "year" : "month");
  const now = Date.now();

  const existing = await env.DB.prepare(
    "SELECT id, updated_at FROM subscriptions WHERE id = ? OR user_id = ?",
  )
    .bind(sub.id, userId)
    .first<{ id: string; updated_at: number }>();

  // 乱序保护：老事件不覆盖新状态（Paddle 的 updated_at 是 RFC3339）
  const incomingUpdated = sub.updatedAt ? Date.parse(sub.updatedAt) : now;
  if (existing && Number.isFinite(incomingUpdated) && incomingUpdated < existing.updated_at) {
    return false;
  }

  const active = sub.status === "active" || sub.status === "trialing" || sub.status === "past_due";
  const proUntil = active && sub.currentPeriodEnd ? sub.currentPeriodEnd : null;

  await env.DB.batch([
    // 同一用户只保留一条订阅；换订阅时把旧记录清掉
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND id <> ?").bind(userId, sub.id),
    env.DB.prepare(
      `INSERT INTO subscriptions
         (id, user_id, customer_id, price_id, plan, status, currency, amount_cents,
          current_period_end, next_billed_at, cancel_at_period_end, canceled_at,
          created_at, updated_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         customer_id = excluded.customer_id,
         price_id = excluded.price_id,
         plan = excluded.plan,
         status = excluded.status,
         currency = excluded.currency,
         amount_cents = excluded.amount_cents,
         current_period_end = excluded.current_period_end,
         next_billed_at = excluded.next_billed_at,
         cancel_at_period_end = excluded.cancel_at_period_end,
         canceled_at = excluded.canceled_at,
         updated_at = excluded.updated_at,
         raw = excluded.raw`,
    ).bind(
      sub.id,
      userId,
      sub.customerId || null,
      sub.priceId,
      plan,
      sub.status,
      sub.currencyCode,
      sub.amount,
      sub.currentPeriodEnd,
      sub.nextBilledAt,
      sub.cancelAtPeriodEnd ? 1 : 0,
      sub.canceledAt,
      now,
      Number.isFinite(incomingUpdated) ? incomingUpdated : now,
      JSON.stringify(sub.raw).slice(0, 4000),
    ),
    // 权益缓存：只往长了延，不因为事件乱序把用户的 Pro 收走
    env.DB.prepare(
      `UPDATE users
          SET pro_until = CASE WHEN ? IS NOT NULL THEN MAX(COALESCE(pro_until, 0), ?) ELSE pro_until END,
              paddle_customer_id = COALESCE(?, paddle_customer_id),
              updated_at = ?
        WHERE id = ?`,
    ).bind(proUntil, proUntil, sub.customerId || null, now, userId),
  ]);

  return true;
}

/**
 * 记录一笔交易（首次购买、每期续费、一次性买断都记），幂等键是 Paddle transaction id。
 * granted=true 表示权益不需要单独发（订阅由 pro_until 走 period end）；
 * 一次性交易传 false，由 grantOneTime 加完时长后再回填 granted_at。
 */
async function recordOrder(
  env: Env,
  txn: PaddleTransaction,
  hints: { userId?: string | null; granted?: boolean } = {},
): Promise<{ userId: string; inserted: boolean } | null> {
  const userId =
    hints.userId ??
    (await resolveUserId(env, {
      custom: txn.customData,
      subscriptionId: txn.subscriptionId,
      customerId: txn.customerId,
    }));
  if (!userId) {
    console.warn("[paddle] order without user", txn.id, txn.customerId);
    return null;
  }

  const now = Date.now();
  const paidAt = txn.billedAt ? Date.parse(txn.billedAt) || now : now;
  const plan = parsePlan(txn.customData?.plan) ?? "month";
  const amount = Number.parseInt(txn.total, 10) || 0;

  const inserted = await env.DB.prepare(
    `INSERT INTO orders
       (id, user_id, provider, provider_order_id, plan, amount_cents, currency,
        status, paid_at, granted_at, created_at, raw, subscription_id)
     VALUES (?, ?, 'paddle', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider_order_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      txn.id,
      plan,
      amount,
      txn.currencyCode,
      txn.status === "paid" || txn.status === "completed" ? "paid" : txn.status,
      paidAt,
      hints.granted === false ? null : now,
      now,
      JSON.stringify(txn.raw).slice(0, 4000),
      txn.subscriptionId,
    )
    .run();

  return { userId, inserted: Boolean(inserted.meta.changes) };
}

/** 一次性买断的时长：只按天数算，续费从「当前到期日」往后叠加 */
const PLAN_DAYS: Record<PlanId, number> = { month: 30, year: 365 };
const DAY_MS = 86_400_000;

/**
 * 一次性交易发权益。幂等三道锁：
 * 1) orders.provider_order_id 唯一，重复投递插不进去（inserted=false 直接返回）
 * 2) UPDATE 带 granted_at IS NULL，并发时只有一次能改到
 * 3) 加时长与回填 granted_at 放在同一个 D1 batch（原子）
 */
async function grantOneTime(
  env: Env,
  txn: PaddleTransaction,
  hints: { userId?: string | null } = {},
): Promise<boolean> {
  const recorded = await recordOrder(env, txn, { ...hints, granted: false });
  if (!recorded || !recorded.inserted) return false;

  const plan = parsePlan(txn.customData?.plan) ?? "month";
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users
          SET pro_until = MAX(COALESCE(pro_until, ?), ?) + ?,
              paddle_customer_id = COALESCE(?, paddle_customer_id),
              updated_at = ?
        WHERE id = ?`,
    ).bind(now, now, PLAN_DAYS[plan] * DAY_MS, txn.customerId, now, recorded.userId),
    env.DB.prepare(
      "UPDATE orders SET granted_at = ? WHERE provider_order_id = ? AND granted_at IS NULL",
    ).bind(now, txn.id),
  ]);

  return true;
}

function toTransaction(data: Record<string, unknown>): PaddleTransaction {
  const details = data.details as { totals?: { total?: string } } | undefined;
  return {
    id: String(data.id ?? ""),
    status: String(data.status ?? ""),
    customerId: (data.customer_id as string | null) ?? null,
    subscriptionId: (data.subscription_id as string | null) ?? null,
    currencyCode: (data.currency_code as string) ?? "USD",
    total: details?.totals?.total ?? "0",
    customData: (data.custom_data as Record<string, unknown> | null) ?? null,
    billedAt: (data.billed_at as string | null) ?? null,
    checkoutUrl: null,
    raw: data,
  };
}

/* --------------------------------- 路由 --------------------------------- */

interface SubscriptionRow {
  id: string;
  status: string;
  plan: string;
  currency: string;
  amount_cents: number;
  current_period_end: number | null;
  next_billed_at: number | null;
  cancel_at_period_end: number;
  canceled_at: number | null;
}

/** 当前登录用户的订阅状态 + 最近订单 */
billing.get("/me", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const user = await c.env.DB.prepare(
    "SELECT pro_until, paddle_customer_id FROM users WHERE id = ?",
  )
    .bind(session.id)
    .first<{ pro_until: number | null; paddle_customer_id: string | null }>();

  const sub = await c.env.DB.prepare(
    `SELECT id, status, plan, currency, amount_cents, current_period_end,
            next_billed_at, cancel_at_period_end, canceled_at
       FROM subscriptions WHERE user_id = ?`,
  )
    .bind(session.id)
    .first<SubscriptionRow>();

  const orders = await c.env.DB.prepare(
    `SELECT id, plan, amount_cents, currency, status, paid_at, created_at
       FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  )
    .bind(session.id)
    .all<{
      id: string;
      plan: string;
      amount_cents: number;
      currency: string;
      status: string;
      paid_at: number | null;
      created_at: number;
    }>();

  const proUntil = user?.pro_until ?? null;
  const isPro = typeof proUntil === "number" && proUntil > Date.now();

  const currency = currencyFor(c);

  return c.json({
    configured: isPaddleConfigured(c.env),
    cnyAvailable: supportsCny(c.env),
    oneTimeAvailable: supportsOneTime(c.env, currency),
    currency,
    plan: isPro ? "pro" : "free",
    proUntil,
    subscription: sub
      ? {
          status: sub.status,
          plan: sub.plan,
          currency: sub.currency,
          amount: sub.amount_cents,
          currentPeriodEnd: sub.current_period_end,
          nextBilledAt: sub.next_billed_at,
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          canceledAt: sub.canceled_at,
        }
      : null,
    orders: orders.results ?? [],
  });
});

/**
 * 创建结算单：返回 Paddle 托管结算页地址。
 * 入参 { plan: "month"|"year", autoRenew?: boolean }，autoRenew 默认 true。
 */
billing.post("/checkout", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  if (!isPaddleConfigured(c.env)) {
    return c.json({ error: "paddle_not_configured" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const payload = (body ?? {}) as { plan?: unknown; autoRenew?: unknown };
  const plan = parsePlan(payload.plan);
  if (!plan) return c.json({ error: "invalid_plan" }, 400);

  // 只有显式传 false 才走一次性，避免前端漏传参数时静默变成不续费
  const autoRenew = payload.autoRenew !== false;
  const currency = currencyFor(c);

  if (!autoRenew && !supportsOneTime(c.env, currency)) {
    return c.json({ error: "one_time_unavailable" }, 503);
  }

  try {
    // 已有生效权益的人不要再买：一次性天数与订阅周期完全重叠，多买的那笔不会叠加
    // （pro_until 由 webhook 写入，统一用它判断，避免只看 subscriptions 表漏掉一次性购买）
    const owner = await c.env.DB.prepare(
      `SELECT u.pro_until,
              EXISTS(
                SELECT 1 FROM subscriptions s
                 WHERE s.user_id = u.id AND s.status IN ('active', 'trialing')
              ) AS active_sub
         FROM users u WHERE u.id = ?`,
    )
      .bind(session.id)
      .first<{ pro_until: number | null; active_sub: number }>();

    const proUntil = owner?.pro_until ?? null;
    if ((typeof proUntil === "number" && proUntil > Date.now()) || owner?.active_sub) {
      return c.json({ error: "already_pro", proUntil }, 409);
    }

    const customerId = await ensureCustomer(c.env, {
      email: session.email,
      name: session.name,
    });

    const txn = await createCheckout(c.env, {
      priceId: priceIdFor(c.env, plan, currency, autoRenew),
      userId: session.id,
      plan,
      autoRenew,
      customerId,
    });

    // 有 client token 时可以走 overlay（只要 transactionId），不依赖 checkout.url
    if (!txn.checkoutUrl && !c.env.PADDLE_CLIENT_TOKEN) {
      // 常见原因：未设置默认支付链接 / 域名未通过审核
      return c.json({ error: "checkout_url_missing" }, 502);
    }

    if (customerId) {
      await c.env.DB.prepare("UPDATE users SET paddle_customer_id = ? WHERE id = ?")
        .bind(customerId, session.id)
        .run();
    }

    return c.json({
      transactionId: txn.id,
      checkoutUrl: txn.checkoutUrl,
      // overlay 结算用：client token 是公开凭据，paddleEnv 决定加载哪个 CDN
      clientToken: c.env.PADDLE_CLIENT_TOKEN ?? null,
      paddleEnv: c.env.PADDLE_ENV === "production" ? "production" : "sandbox",
      amount: Number.parseInt(txn.total, 10) || 0,
      currency: txn.currencyCode,
      plan,
      autoRenew,
    });
  } catch (e) {
    return paddleFailure(c, e, "checkout");
  }
});

/**
 * 支付回来后的兜底：前端带着 transactionId 回到账户页，
 * 这里主动查一次 Paddle，把订阅与订单补齐（不依赖 webhook 的到达时间）。
 */
billing.post("/sync", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const transactionId = (body as { transactionId?: unknown })?.transactionId;
  if (typeof transactionId !== "string" || !transactionId.startsWith("txn_")) {
    return c.json({ error: "invalid_transaction_id" }, 400);
  }

  try {
    const txn = await getPaddleTransaction(c.env, transactionId);
    if (userIdFromCustom(txn.customData) !== session.id) {
      return c.json({ error: "forbidden" }, 403);
    }

    if (txn.status !== "completed" && txn.status !== "paid") {
      return c.json({ ok: true, synced: false, status: txn.status });
    }

    if (txn.subscriptionId) {
      await recordOrder(c.env, txn, { userId: session.id });
      const sub = await getPaddleSubscription(c.env, txn.subscriptionId);
      await saveSubscription(c.env, sub, { userId: session.id });
      return c.json({ ok: true, synced: true, subscriptionStatus: sub.status });
    }

    // 一次性买断：没有 subscription_id，直接按天数加权益
    const granted = await grantOneTime(c.env, txn, { userId: session.id });
    return c.json({ ok: true, synced: true, oneTime: true, granted });
  } catch (e) {
    return paddleFailure(c, e, "sync");
  }
});

/** 取消订阅：默认周期末生效，当期权益保留 */
billing.post("/cancel", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const row = await c.env.DB.prepare(
    "SELECT id, status FROM subscriptions WHERE user_id = ?",
  )
    .bind(session.id)
    .first<{ id: string; status: string }>();

  if (!row) return c.json({ error: "no_subscription" }, 404);
  if (row.status === "canceled") return c.json({ error: "already_canceled" }, 409);

  try {
    const sub = await cancelPaddleSubscription(c.env, row.id, "next_billing_period");
    await saveSubscription(c.env, sub, { userId: session.id });
    return c.json({
      ok: true,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      currentPeriodEnd: sub.currentPeriodEnd,
    });
  } catch (e) {
    return paddleFailure(c, e, "cancel");
  }
});

/** 撤销「周期末取消」，恢复自动续费 */
billing.post("/resume", async (c) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const row = await c.env.DB.prepare(
    "SELECT id, status, cancel_at_period_end FROM subscriptions WHERE user_id = ?",
  )
    .bind(session.id)
    .first<{ id: string; status: string; cancel_at_period_end: number }>();

  if (!row) return c.json({ error: "no_subscription" }, 404);
  if (row.status === "canceled") return c.json({ error: "canceled_cannot_resume" }, 409);
  if (!row.cancel_at_period_end) return c.json({ ok: true, cancelAtPeriodEnd: false });

  try {
    const sub = await resumePaddleSubscription(c.env, row.id);
    await saveSubscription(c.env, sub, { userId: session.id });
    return c.json({ ok: true, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, nextBilledAt: sub.nextBilledAt });
  } catch (e) {
    return paddleFailure(c, e, "resume");
  }
});

/** Paddle 通知目标：https://horizons.tools/api/billing/webhook */
billing.post("/webhook", async (c) => {
  const signature = c.req.header("paddle-signature") ?? "";
  const rawBody = await c.req.text();

  if (!signature || !rawBody) {
    return c.json({ error: "missing_signature_or_body" }, 400);
  }

  try {
    const valid = await verifyPaddleSignature(
      rawBody,
      signature,
      c.env.PADDLE_WEBHOOK_SECRET,
    );
    if (!valid) {
      // 只有 2xx 才算投递成功；返回非 2xx 让 Paddle 重试（密钥轮换也能自愈）
      return c.json({ error: "invalid_signature" }, 401);
    }

    const event = JSON.parse(rawBody) as {
      event_id?: string;
      event_type?: string;
      data?: Record<string, unknown>;
    };
    const type = event.event_type ?? "";
    const data = event.data ?? {};

    if (type.startsWith("subscription.")) {
      await saveSubscription(c.env, normalizeSubscription(data as unknown as RawSubscription));
      return c.json({ received: true });
    }

    switch (type) {
      case "transaction.completed":
      case "transaction.paid": {
        const txn = toTransaction(data);
        if (txn.status === "completed" || txn.status === "paid") {
          if (txn.subscriptionId) {
            await recordOrder(c.env, txn);
            // 首次付款：顺手把订阅状态拉正，避免只靠 subscription.created 的时序
            const sub = await getPaddleSubscription(c.env, txn.subscriptionId);
            await saveSubscription(c.env, sub, {
              userId: userIdFromCustom(txn.customData) ?? undefined,
            });
          } else {
            // 一次性买断
            await grantOneTime(c.env, txn);
          }
        }
        break;
      }
      case "adjustment.created": {
        // 退款只回写订单状态；是否立刻收回权益由人工判断（避免误伤正在使用的用户）
        const transactionId = data.transaction_id;
        if (data.action === "refund" && typeof transactionId === "string") {
          await c.env.DB.prepare(
            "UPDATE orders SET status = 'refunded' WHERE provider_order_id = ?",
          )
            .bind(transactionId)
            .run();
        }
        break;
      }
      default:
        console.log("[paddle] unhandled event", type, event.event_id);
    }

    return c.json({ received: true });
  } catch (e) {
    console.error("[paddle] webhook error", e);
    // 非 2xx 会让 Paddle 重试；2xx 是唯一会丢事件的选择
    return c.json({ error: "internal_error" }, 500);
  }
});

function paddleFailure(c: Context<{ Bindings: Env }>, e: unknown, scope: string) {
  console.error(`[paddle] ${scope} failed`, e);
  const status = e instanceof PaddleError ? e.status : 502;
  // 沙箱阶段把上游错误原文带出来，方便定位（生产环境只返回统一错误码）
  const diag =
    c.env.PADDLE_ENV === "production"
      ? {}
      : { paddleError: e instanceof PaddleError ? e.message : String(e) };
  return c.json(
    { error: "paddle_request_failed", ...diag },
    status as ContentfulStatusCode,
  );
}

