/**
 * Paddle Billing（MoR）封装：订阅（自动续费）+ 卡/钱包/本地支付方式。
 *
 * Workers 环境只用 fetch + WebCrypto：
 * - 不引 @paddle/paddle-node-sdk（依赖 Node crypto，Workers 上要额外 polyfill）
 * - 签名校验用 crypto.subtle
 *
 * 环境：
 *   PADDLE_ENV=sandbox | production
 *   PADDLE_API_KEY=pdl_sdbx_apikey_...（sandbox）/ pdl_live_apikey_...（live）
 *   PADDLE_WEBHOOK_SECRET=pdl_ntfset_...（webhook 通知目标的 secret，与 API key 不是同一个值）
 *   PADDLE_PRICE_MONTH_USD / PADDLE_PRICE_YEAR_USD / PADDLE_PRICE_MONTH_CNY / PADDLE_PRICE_YEAR_CNY
 */

import type { Env } from "../env";

const SANDBOX_API = "https://sandbox-api.paddle.com";
const LIVE_API = "https://api.paddle.com";

/** Paddle 只接受 5 秒内的签名时间戳（与服务端时钟同步即可） */
const SIGNATURE_TOLERANCE_SECONDS = 5;

const encoder = new TextEncoder();

export type PlanId = "month" | "year";
export type Currency = "USD" | "CNY";
export type SubscriptionStatus = "active" | "trialing" | "past_due" | "paused" | "canceled";

export interface PaddleTransaction {
  id: string;
  status: string;
  customerId: string | null;
  subscriptionId: string | null;
  currencyCode: string;
  /** 最小货币单位（如 "2000"），字符串 */
  total: string;
  customData: Record<string, unknown> | null;
  billedAt: string | null;
  checkoutUrl: string | null;
  raw: unknown;
}

export interface PaddleSubscription {
  id: string;
  status: SubscriptionStatus;
  customerId: string;
  priceId: string;
  currencyCode: string;
  /** 每期金额（最小货币单位） */
  amount: number;
  /** month | year */
  billingInterval: string;
  currentPeriodEnd: number | null;
  nextBilledAt: number | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: number | null;
  updatedAt: string | null;
  customData: Record<string, unknown> | null;
  raw: unknown;
}

export class PaddleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "PaddleError";
  }
}

export function paddleApiBase(env: Env): string {
  return env.PADDLE_ENV === "production" ? LIVE_API : SANDBOX_API;
}

/** 至少要有 API key 和美元价格，否则下单一定失败 */
export function isPaddleConfigured(env: Env): boolean {
  return Boolean(env.PADDLE_API_KEY && env.PADDLE_PRICE_MONTH_USD && env.PADDLE_PRICE_YEAR_USD);
}

/** 支付宝要求「CNY 定价」，所以人民币价格配齐了才对中国客户开放 */
export function supportsCny(env: Env): boolean {
  return Boolean(env.PADDLE_PRICE_MONTH_CNY && env.PADDLE_PRICE_YEAR_CNY);
}

/**
 * 是否提供「一次性买断（不自动续费）」。
 * 必须在 Paddle 里建过非循环 price，否则结算页会报错，所以这里先挡掉。
 */
export function supportsOneTime(env: Env, currency: Currency): boolean {
  if (currency === "CNY") {
    return Boolean(env.PADDLE_PRICE_MONTH_ONCE_CNY && env.PADDLE_PRICE_YEAR_ONCE_CNY);
  }
  return Boolean(env.PADDLE_PRICE_MONTH_ONCE_USD && env.PADDLE_PRICE_YEAR_ONCE_USD);
}

/**
 * 下单用的价格 ID。
 * autoRenew=false 走一次性 price；该币种没配一次性价格时落回订阅价
 * （调用方应当先用 supportsOneTime 判断，避免悄悄变成订阅）。
 */
export function priceIdFor(
  env: Env,
  plan: PlanId,
  currency: Currency,
  autoRenew = true,
): string {
  const isYear = plan === "year";

  if (!autoRenew) {
    const once =
      currency === "CNY"
        ? isYear
          ? env.PADDLE_PRICE_YEAR_ONCE_CNY
          : env.PADDLE_PRICE_MONTH_ONCE_CNY
        : isYear
          ? env.PADDLE_PRICE_YEAR_ONCE_USD
          : env.PADDLE_PRICE_MONTH_ONCE_USD;
    if (once) return once;
  }

  if (currency === "CNY") {
    const id = isYear ? env.PADDLE_PRICE_YEAR_CNY : env.PADDLE_PRICE_MONTH_CNY;
    if (id) return id;
  }
  return isYear ? env.PADDLE_PRICE_YEAR_USD : env.PADDLE_PRICE_MONTH_USD;
}

interface PaddleResponse<T> {
  data: T;
  meta?: unknown;
}

/** 统一的 Paddle API 调用：非 2xx 抛出带状态码的错误，便于路由层转成 502 */
export async function paddleRequest<T>(
  env: Env,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!env.PADDLE_API_KEY) {
    throw new PaddleError("PADDLE_API_KEY 未配置", 500);
  }

  const res = await fetch(`${paddleApiBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.PADDLE_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; detail?: string } })?.error;
    throw new PaddleError(
      `Paddle API ${res.status}：${err?.code ?? "unknown"} ${err?.detail ?? ""}`.trim(),
      502,
      body,
    );
  }

  return (body as PaddleResponse<T>)?.data as T;
}

/* ------------------------------- 交易 / 结算 ------------------------------- */

interface RawTransaction {
  id: string;
  status: string;
  customer_id?: string | null;
  subscription_id?: string | null;
  currency_code?: string;
  custom_data?: Record<string, unknown> | null;
  billed_at?: string | null;
  checkout?: { url?: string | null } | null;
  details?: { totals?: { total?: string } };
}

function normalizeTransaction(raw: RawTransaction): PaddleTransaction {
  return {
    id: raw.id,
    status: raw.status,
    customerId: raw.customer_id ?? null,
    subscriptionId: raw.subscription_id ?? null,
    currencyCode: raw.currency_code ?? "USD",
    total: raw.details?.totals?.total ?? "0",
    customData: raw.custom_data ?? null,
    billedAt: raw.billed_at ?? null,
    checkoutUrl: raw.checkout?.url ?? null,
    raw,
  };
}

/**
 * 创建结算单，返回托管结算页地址（checkout.url）。
 *
 * 订阅与一次性用的是同一个接口，区别只在 price 的类型：
 * - price 是 recurring → Paddle 付款后自动建订阅，webhook 的 transaction 带 subscription_id
 * - price 是 one-time → 一次性交易，没有 subscription_id，权益由我们自己加时长
 */
export async function createCheckout(
  env: Env,
  opts: {
    priceId: string;
    userId: string;
    plan: PlanId;
    autoRenew: boolean;
    customerId?: string | null;
  },
): Promise<PaddleTransaction> {
  const raw = await paddleRequest<RawTransaction>(env, "/transactions", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: opts.priceId, quantity: 1 }],
      ...(opts.customerId ? { customer_id: opts.customerId } : {}),
      // webhook 里靠这几个字段把交易挂回用户，不依赖邮箱匹配
      custom_data: {
        user_id: opts.userId,
        plan: opts.plan,
        auto_renew: opts.autoRenew ? "1" : "0",
      },
      collection_mode: "automatic",
    }),
  });
  return normalizeTransaction(raw);
}

/** 主动查询交易（webhook 丢失时的兜底） */
export async function getPaddleTransaction(
  env: Env,
  transactionId: string,
): Promise<PaddleTransaction> {
  const raw = await paddleRequest<RawTransaction>(
    env,
    `/transactions/${encodeURIComponent(transactionId)}`,
  );
  return normalizeTransaction(raw);
}

/* --------------------------------- 客户 --------------------------------- */

interface RawCustomer {
  id: string;
  email?: string;
}

/** 查重（Paddle 按邮箱唯一），没有就建一个，用于结算页预填邮箱与发票投递 */
export async function ensureCustomer(
  env: Env,
  opts: { email: string; name?: string | null },
): Promise<string | null> {
  const email = opts.email.trim();
  if (!email) return null;

  const found = await paddleRequest<RawCustomer[]>(
    env,
    `/customers?email=${encodeURIComponent(email)}`,
  );
  if (Array.isArray(found) && found[0]?.id) return found[0].id;

  try {
    const created = await paddleRequest<RawCustomer>(env, "/customers", {
      method: "POST",
      body: JSON.stringify({ email, ...(opts.name ? { name: opts.name } : {}) }),
    });
    return created?.id ?? null;
  } catch (e) {
    // 并发下单会撞唯一约束：再查一次即可
    if (e instanceof PaddleError) {
      const retry = await paddleRequest<RawCustomer[]>(
        env,
        `/customers?email=${encodeURIComponent(email)}`,
      );
      if (Array.isArray(retry) && retry[0]?.id) return retry[0].id;
    }
    throw e;
  }
}

/* --------------------------------- 订阅 --------------------------------- */

interface RawSubscription {
  id: string;
  status: string;
  customer_id?: string;
  currency_code?: string;
  custom_data?: Record<string, unknown> | null;
  next_billed_at?: string | null;
  canceled_at?: string | null;
  updated_at?: string | null;
  current_billing_period?: { starts_at?: string; ends_at?: string } | null;
  scheduled_change?: { action?: string; effective_at?: string } | null;
  billing_cycle?: { interval?: string; frequency?: number };
  items?: Array<{
    status?: string;
    quantity?: number;
    price?: {
      id?: string;
      unit_price?: { amount?: string; currency_code?: string };
      billing_cycle?: { interval?: string };
    };
  }>;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function normalizeSubscription(raw: RawSubscription): PaddleSubscription {
  const item = raw.items?.[0];
  const unit = item?.price?.unit_price;
  const quantity = item?.quantity && item.quantity > 0 ? item.quantity : 1;
  const amount = unit?.amount ? Number.parseInt(unit.amount, 10) * quantity : 0;

  return {
    id: raw.id,
    status: (raw.status as SubscriptionStatus) ?? "active",
    customerId: raw.customer_id ?? "",
    priceId: item?.price?.id ?? "",
    currencyCode: unit?.currency_code ?? raw.currency_code ?? "USD",
    amount: Number.isFinite(amount) ? amount : 0,
    billingInterval: item?.price?.billing_cycle?.interval ?? raw.billing_cycle?.interval ?? "month",
    currentPeriodEnd: toMs(raw.current_billing_period?.ends_at),
    nextBilledAt: toMs(raw.next_billed_at),
    cancelAtPeriodEnd: raw.scheduled_change?.action === "cancel",
    canceledAt: toMs(raw.canceled_at),
    updatedAt: raw.updated_at ?? null,
    customData: raw.custom_data ?? null,
    raw,
  };
}

export async function getPaddleSubscription(
  env: Env,
  subscriptionId: string,
): Promise<PaddleSubscription> {
  const raw = await paddleRequest<RawSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
  return normalizeSubscription(raw);
}

/**
 * 取消订阅。默认周期末生效（当期权益保留到 current_period_end），
 * 这样用户不会因为我们「立刻停服」而投诉。
 */
export async function cancelPaddleSubscription(
  env: Env,
  subscriptionId: string,
  effectiveFrom: "next_billing_period" | "immediately" = "next_billing_period",
): Promise<PaddleSubscription> {
  const raw = await paddleRequest<RawSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { method: "POST", body: JSON.stringify({ effective_from: effectiveFrom }) },
  );
  return normalizeSubscription(raw);
}

/**
 * 撤销「周期末取消」：PATCH 只能把 scheduled_change 置为 null，不能用它发起变更。
 * 只在取消尚未生效时有效；已 canceled 的订阅 Paddle 不支持恢复。
 */
export async function resumePaddleSubscription(
  env: Env,
  subscriptionId: string,
): Promise<PaddleSubscription> {
  const raw = await paddleRequest<RawSubscription>(
    env,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "PATCH", body: JSON.stringify({ scheduled_change: null }) },
  );
  return normalizeSubscription(raw);
}

/* -------------------------------- 验签 -------------------------------- */

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 定长比较，避免按字符短路（签名比较不泄露前缀信息） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 校验 `Paddle-Signature: ts=...;h1=...`
 * 签名内容 = `${ts}:${原始请求体}`，HMAC-SHA256 后转十六进制小写。
 * 必须用未经解析的原始 body，重新序列化会导致字节不一致。
 */
export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!rawBody || !signatureHeader || !secret) return false;

  const parts = new Map<string, string>();
  for (const pair of signatureHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) parts.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }

  const ts = parts.get("ts");
  const h1 = parts.get("h1");
  if (!ts || !h1) return false;

  const tsSeconds = Number(ts);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(Date.now() / 1000 - tsSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = toHex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`)),
  );
  return timingSafeEqual(expected, h1.toLowerCase());
}

export type { RawTransaction, RawSubscription };