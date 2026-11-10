/**
 * 后台管理 API（只有站主本人可用，不对外注册）。
 *
 * 安全设计（每一条都对应一个具体攻击面）：
 * - 密码只以 PBKDF2-SHA256 哈希形式存在于 Secret 里，库里/仓库里没有明文；
 *   用户名的比较也走「先哈希再逐字节比较」，不让响应时间泄漏前缀。
 * - 会话是服务端可撤销的：Cookie 里是 32 字节随机 token，库里只存 sha256(token)，
 *   HttpOnly + SameSite=Strict + Path=/api/admin，前端 JS 读不到，也不会发给其他接口。
 * - 登录失败按 IP 哈希计数，15 分钟窗口内 5 次即封锁；封锁只写在 D1，Worker 无状态也不绕不过。
 * - 所有写操作要求 JSON + 自定义请求头：跨站表单发不出 application/json，
 *   跨站 fetch 会先触发 CORS 预检（本服务不返回 CORS 头），因此 CSRF 打不进来。
 * - 查询全部用参数绑定，搜索关键词只作为 LIKE 参数，不拼进 SQL。
 * - 列表分页页大小有上限，避免一次拉全表把 Worker 内存打满。
 */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Env } from "../env";
import { base64UrlDecode, randomBytesBase64 } from "../lib/crypto";
import { PAYWALL_BUTTONS, paywallButtonLabel } from "../lib/paywall";
import { adminBoards } from "./admin-boards";
import { adminDaily } from "./admin-daily";
import { github as adminGithub } from "./admin-github";
import { adminTools } from "./admin-tools";
import { trends as adminTrends } from "./admin-trends";

export const admin = new Hono<{ Bindings: Env }>();

const ADMIN_COOKIE = "hzn_admin";
const ADMIN_COOKIE_PATH = "/api/admin";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const CSRF_HEADER = "x-requested-with";
const CSRF_VALUE = "horizons-admin";
const MAX_PAGE_SIZE = 100;
const DAY_MS = 86_400_000;

const encoder = new TextEncoder();

type Ctx = Context<{ Bindings: Env }>;

/* ------------------------------- 基础工具 ------------------------------- */

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常量时间比较：先各自哈希成等长摘要，再逐字节异或累积差异 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const u = new Uint8Array(x);
  const v = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < u.length; i += 1) diff |= (u[i] ?? 0) ^ (v[i] ?? 0);
  return diff === 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

interface PasswordHash {
  iterations: number;
  salt: Uint8Array;
  hash: Uint8Array;
}

/**
 * Cloudflare Workers 的 WebCrypto 对 PBKDF2 有硬上限：迭代次数 > 100,000 会抛
 * `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported`。
 * 本地 miniflare 走 Node 实现没有这个限制，所以「本地能登、线上 500」只会在部署后暴露。
 * 这里显式卡住上限，配置越界时直接报配置错误，而不是让请求崩成 500。
 */
const MIN_ITERATIONS = 10_000;
const MAX_ITERATIONS = 100_000;

/** 解析 `pbkdf2$sha256$<iter>$<saltB64Url>$<hashB64Url>`，格式不对一律拒绝 */
function parsePasswordHash(raw: string): PasswordHash | null {
  const parts = raw.trim().split("$");
  if (parts.length !== 5) return null;
  const [scheme, digest, iterRaw, saltRaw, hashRaw] = parts;
  if (scheme !== "pbkdf2" || digest !== "sha256") return null;
  const iterations = Number.parseInt(iterRaw ?? "", 10);
  if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return null;
  }
  try {
    const salt = base64UrlDecode(saltRaw ?? "");
    const hash = base64UrlDecode(hashRaw ?? "");
    if (salt.length < 8 || hash.length !== 32) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 客户端 IP：Cloudflare 环境下是 cf-connecting-ip，本地 dev 退化为直连地址 */
function clientIp(c: Ctx): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

function isHttps(c: Ctx): boolean {
  return new URL(c.req.url).protocol === "https:";
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* --------------------------------- 会话 --------------------------------- */

interface SessionRow {
  token_hash: string;
  expires_at: number;
}

async function readSession(c: Ctx): Promise<SessionRow | null> {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token || token.length < 20 || token.length > 128) return null;

  const row = await c.env.DB.prepare(
    "SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = ?",
  )
    .bind(await sha256Hex(token))
    .first<SessionRow>();

  if (!row || row.expires_at <= Date.now()) return null;
  return row;
}

/* ------------------------------ 登录限流 ------------------------------- */

interface LimitRow {
  fails: number;
  window_start: number;
  blocked_until: number | null;
}

async function recordFailure(env: Env, ipHash: string, now: number): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT fails, window_start, blocked_until FROM admin_login_limits WHERE ip_hash = ?",
  )
    .bind(ipHash)
    .first<LimitRow>();

  // 窗口过期视为重新计数，避免累积几天的失败把账号永久锁死
  if (!row || now - row.window_start > WINDOW_MS) {
    await env.DB.prepare(
      `INSERT INTO admin_login_limits (ip_hash, fails, window_start, blocked_until)
       VALUES (?, 1, ?, NULL)
       ON CONFLICT(ip_hash) DO UPDATE SET
         fails = 1, window_start = excluded.window_start, blocked_until = NULL`,
    )
      .bind(ipHash, now)
      .run();
    return;
  }

  const fails = row.fails + 1;
  if (fails >= MAX_FAILS) {
    await env.DB.prepare(
      "UPDATE admin_login_limits SET fails = 0, window_start = ?, blocked_until = ? WHERE ip_hash = ?",
    )
      .bind(now, now + WINDOW_MS, ipHash)
      .run();
    return;
  }

  await env.DB.prepare("UPDATE admin_login_limits SET fails = ? WHERE ip_hash = ?")
    .bind(fails, ipHash)
    .run();
}

/* -------------------------------- 中间件 -------------------------------- */

/** CSRF：只接受同站页面发出的 JSON 请求（跨站表单/fetch 无法同时满足这两个条件） */
admin.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
});

/* --------------------------------- 登录 --------------------------------- */

admin.post("/login", async (c) => {
  const { ADMIN_USERNAME, ADMIN_PASSWORD_HASH } = c.env;
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
    return c.json({ error: "admin_not_configured" }, 503);
  }
  const parsed = parsePasswordHash(ADMIN_PASSWORD_HASH);
  if (!parsed) {
    // 哈希格式不合法，或迭代次数超出 Workers 的 100,000 上限：这是配置问题，不是密码错
    return c.json({ error: "admin_hash_unsupported" }, 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== "string" || typeof password !== "string") {
    return c.json({ error: "invalid_credentials" }, 400);
  }
  if (username.length > 128 || password.length > 512) {
    return c.json({ error: "invalid_credentials" }, 400);
  }

  const now = Date.now();
  const ipHash = await sha256Hex(clientIp(c));

  const limit = await c.env.DB.prepare(
    "SELECT fails, window_start, blocked_until FROM admin_login_limits WHERE ip_hash = ?",
  )
    .bind(ipHash)
    .first<LimitRow>();

  if (limit?.blocked_until && limit.blocked_until > now) {
    const retryAfter = Math.ceil((limit.blocked_until - now) / 1000);
    c.header("retry-after", String(retryAfter));
    return c.json({ error: "too_many_attempts", retryAfter }, 429);
  }

  // 无论用户名对不对都跑一次 PBKDF2：耗时一致，不能靠响应快慢猜用户名
  const userOkPromise = safeEqual(username, ADMIN_USERNAME);
  let derived: Uint8Array;
  try {
    derived = await derivePassword(password, parsed.salt, parsed.iterations);
  } catch {
    // 运行时仍拒绝（不同账号/套餐的 WebCrypto 限制可能有差异），按配置错误返回
    return c.json({ error: "admin_hash_unsupported" }, 503);
  }
  const userOk = await userOkPromise;
  const passOk = equalBytes(derived, parsed.hash);

  if (!userOk || !passOk) {
    await recordFailure(c.env, ipHash, now);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const token = randomBytesBase64(32);
  const tokenHash = await sha256Hex(token);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now),
    c.env.DB.prepare(
      `INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(
      tokenHash,
      now,
      now + SESSION_TTL_MS,
      ipHash,
      (c.req.header("user-agent") ?? "").slice(0, 200),
    ),
    c.env.DB.prepare("DELETE FROM admin_login_limits WHERE ip_hash = ?").bind(ipHash),
  ]);

  setCookie(c, ADMIN_COOKIE, token, {
    path: ADMIN_COOKIE_PATH,
    httpOnly: true,
    sameSite: "Strict",
    secure: isHttps(c),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  return c.json({ ok: true, username: ADMIN_USERNAME });
});

/** 从这里开始都要登录态：/login 已在上方提前返回，不会再往下走 */
admin.use("*", async (c, next) => {
  const session = await readSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  return next();
});

admin.get("/me", (c) => c.json({ ok: true, username: c.env.ADMIN_USERNAME ?? "" }));

/** 工具榜后台：抓取 / 审核 / 发布（数据仍在仓库 JSON，这里只做触发与读取） */
admin.route("/tools", adminTools);

/** 趋势榜后台：采集 / 审核 / 发布，发布前给位次变化预览 */
admin.route("/trends", adminTrends);
admin.route("/github", adminGithub);

/** 榜单版本与数据源开关：六个榜发布到 D1 之后的观察与回滚入口 */
admin.route("/boards", adminBoards);

// /daily 挂在登录中间件之后，自动受鉴权保护
admin.route("/daily", adminDaily);

admin.post("/logout", async (c) => {
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) {
    await c.env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .run();
  }
  deleteCookie(c, ADMIN_COOKIE, { path: ADMIN_COOKIE_PATH });
  return c.json({ ok: true });
});

/* -------------------------------- 数据大盘 ------------------------------- */

interface CurrencyRow {
  currency: string;
  orders: number;
  total: number;
  month: number;
  prev_month: number;
}

interface SeriesRow {
  ym: string;
  currency: string;
  orders: number;
  amount: number;
}

/** 近 12 个月的月份键（UTC，与 SQL 的 strftime('unixepoch') 对齐） */
function last12Months(now: number): string[] {
  const d = new Date(now);
  const months: string[] = [];
  for (let i = 11; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return months;
}

admin.get("/stats", async (c) => {
  const env = c.env;
  const now = Date.now();
  const day7 = now - 7 * DAY_MS;
  const day30 = now - 30 * DAY_MS;
  const d = new Date(now);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const prevMonthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const seriesStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 11, 1);

  const [usersRow, planRows, currencyRows, refundRows, seriesRows, subRows, mrrRows] =
    await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS new7,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS new30,
              COALESCE(SUM(CASE WHEN pro_until > ? THEN 1 ELSE 0 END), 0) AS pro
         FROM users`,
    ).bind(day7, day30, now),

    // 付费用户按月付/年付拆分：优先取生效中的订阅方案，其次取最近一笔已支付订单的方案
    env.DB.prepare(
      `SELECT plan, COUNT(*) AS c FROM (
         SELECT u.id,
                CASE
                  WHEN s.plan IS NOT NULL THEN s.plan
                  ELSE (
                    SELECT o.plan FROM orders o
                     WHERE o.user_id = u.id AND o.status = 'paid'
                     ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 1
                  )
                END AS plan
           FROM users u
           LEFT JOIN subscriptions s
             ON s.user_id = u.id AND s.status IN ('active', 'trialing', 'past_due')
          WHERE u.pro_until > ?
       )
       GROUP BY plan`,
    ).bind(now),

    env.DB.prepare(
      `SELECT currency,
              COUNT(*) AS orders,
              COALESCE(SUM(amount_cents), 0) AS total,
              COALESCE(SUM(CASE WHEN COALESCE(paid_at, created_at) >= ? THEN amount_cents ELSE 0 END), 0) AS month,
              COALESCE(SUM(CASE WHEN COALESCE(paid_at, created_at) >= ? AND COALESCE(paid_at, created_at) < ? THEN amount_cents ELSE 0 END), 0) AS prev_month
         FROM orders
        WHERE status = 'paid'
        GROUP BY currency`,
    ).bind(monthStart, prevMonthStart, monthStart),

    env.DB.prepare(
      `SELECT currency, COUNT(*) AS refunds, COALESCE(SUM(amount_cents), 0) AS amount
         FROM orders WHERE status = 'refunded' GROUP BY currency`,
    ),

    env.DB.prepare(
      `SELECT strftime('%Y-%m', COALESCE(paid_at, created_at) / 1000, 'unixepoch') AS ym,
              currency, COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS amount
         FROM orders
        WHERE status = 'paid' AND COALESCE(paid_at, created_at) >= ?
        GROUP BY ym, currency
        ORDER BY ym ASC`,
    ).bind(seriesStart),

    env.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM subscriptions GROUP BY status`,
    ),

    // MRR 按币种分开算：年付摊到 12 个月，币种之间不做汇率换算（换算出来的数字不可信）
    env.DB.prepare(
      `SELECT currency,
              CAST(COALESCE(SUM(CASE WHEN plan = 'year' THEN amount_cents / 12.0 ELSE amount_cents END), 0) AS INTEGER) AS mrr
         FROM subscriptions
        WHERE status IN ('active', 'trialing', 'past_due')
        GROUP BY currency`,
    ),
  ]);

  const users = (usersRow?.results?.[0] ?? { total: 0, new7: 0, new30: 0, pro: 0 }) as {
    total: number;
    new7: number;
    new30: number;
    pro: number;
  };

  const planCount = (plan: string) => {
    const rows = (planRows?.results ?? []) as Array<{ plan: string | null; c: number }>;
    return rows.find((r) => r.plan === plan)?.c ?? 0;
  };

  const revenueRows = (currencyRows?.results ?? []) as CurrencyRow[];
  const refunds = new Map<string, { refunds: number; amount: number }>();
  for (const r of (refundRows?.results ?? []) as Array<{
    currency: string;
    refunds: number;
    amount: number;
  }>) {
    refunds.set(r.currency, { refunds: r.refunds, amount: r.amount });
  }

  const subCount = (status: string) => {
    const rows = (subRows?.results ?? []) as Array<{ status: string; c: number }>;
    return rows.find((r) => r.status === status)?.c ?? 0;
  };

  const mrrMap = new Map<string, number>();
  for (const r of (mrrRows?.results ?? []) as Array<{ currency: string; mrr: number }>) {
    mrrMap.set(r.currency, r.mrr);
  }

  const months = last12Months(now);
  const monthIndex = new Map(months.map((m, i) => [m, i]));

  const seriesRowsTyped = (seriesRows?.results ?? []) as SeriesRow[];
  const currencies = [...new Set(seriesRowsTyped.map((r) => r.currency))];
  for (const r of revenueRows) if (!currencies.includes(r.currency)) currencies.push(r.currency);

  const series = currencies.map((currency) => {
    const values = months.map(() => 0);
    const orders = months.map(() => 0);
    for (const row of seriesRowsTyped) {
      if (row.currency !== currency) continue;
      const idx = monthIndex.get(row.ym);
      if (idx === undefined) continue;
      values[idx] = (values[idx] ?? 0) + row.amount;
      orders[idx] = (orders[idx] ?? 0) + row.orders;
    }
    return { currency, values, orders };
  });

  return c.json({
    generatedAt: now,
    users: {
      total: users.total,
      new7: users.new7,
      new30: users.new30,
      pro: { total: users.pro, month: planCount("month"), year: planCount("year") },
    },
    revenue: {
      currencies: revenueRows.map((r) => ({
        currency: r.currency,
        orders: r.orders,
        total: r.total,
        month: r.month,
        prevMonth: r.prev_month,
        refunds: refunds.get(r.currency)?.refunds ?? 0,
        refundAmount: refunds.get(r.currency)?.amount ?? 0,
        mrr: mrrMap.get(r.currency) ?? 0,
      })),
      months,
      series,
    },
    subscriptions: {
      active: subCount("active"),
      trialing: subCount("trialing"),
      pastDue: subCount("past_due"),
      paused: subCount("paused"),
      canceled: subCount("canceled"),
    },
  });
});

/* ------------------------------ 注册用户列表 ----------------------------- */

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  created_at: number;
  pro_until: number | null;
  sub_status: string | null;
  sub_plan: string | null;
  sub_period_end: number | null;
  sub_cancel_at_period_end: number | null;
  order_plan: string | null;
}

admin.get("/users", async (c) => {
  const env = c.env;
  const now = Date.now();
  const page = clampInt(c.req.query("page"), 1, 1, 10_000);
  const pageSize = clampInt(c.req.query("pageSize"), 20, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const type = c.req.query("type") === "pro" || c.req.query("type") === "free" ? c.req.query("type") : "all";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push("(u.email LIKE ? OR COALESCE(u.name, '') LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`);
  }
  if (type === "pro") {
    where.push("u.pro_until > ?");
    binds.push(now);
  } else if (type === "free") {
    where.push("(u.pro_until IS NULL OR u.pro_until <= ?)");
    binds.push(now);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM users u ${whereSql}`).bind(...binds),
    env.DB.prepare(
      `SELECT u.id, u.email, u.name, u.created_at, u.pro_until,
              s.status AS sub_status, s.plan AS sub_plan,
              s.current_period_end AS sub_period_end,
              s.cancel_at_period_end AS sub_cancel_at_period_end,
              (SELECT o.plan FROM orders o
                WHERE o.user_id = u.id AND o.status = 'paid'
                ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT 1) AS order_plan
         FROM users u
         LEFT JOIN subscriptions s ON s.user_id = u.id
         ${whereSql}
        ORDER BY u.created_at DESC
        LIMIT ? OFFSET ?`,
    ).bind(...binds, pageSize, offset),
  ]);

  const total = ((countRes?.results?.[0] ?? { c: 0 }) as { c: number }).c;
  const rows = (listRes?.results ?? []) as UserRow[];

  // 累计支付：按币种分组，只查当前页的用户 id（占位符数量由 id 数量决定，不含用户输入）
  const paid = new Map<string, Array<{ currency: string; amount: number; orders: number; lastAt: number }>>();
  if (rows.length) {
    const placeholders = rows.map(() => "?").join(",");
    const agg = await env.DB.prepare(
      `SELECT user_id, currency, COUNT(*) AS orders, COALESCE(SUM(amount_cents), 0) AS amount,
              MAX(COALESCE(paid_at, created_at)) AS last_at
         FROM orders
        WHERE status = 'paid' AND user_id IN (${placeholders})
        GROUP BY user_id, currency`,
    )
      .bind(...rows.map((r) => r.id))
      .all<{ user_id: string; currency: string; orders: number; amount: number; last_at: number }>();

    for (const row of agg.results ?? []) {
      const list = paid.get(row.user_id) ?? [];
      list.push({ currency: row.currency, amount: row.amount, orders: row.orders, lastAt: row.last_at });
      paid.set(row.user_id, list);
    }
  }

  const items = rows.map((r) => {
    const isPro = typeof r.pro_until === "number" && r.pro_until > now;
    const plan = r.sub_plan ?? r.order_plan ?? null;
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      createdAt: r.created_at,
      proUntil: r.pro_until,
      isPro,
      plan,
      subStatus: r.sub_status,
      periodEnd: r.sub_period_end,
      cancelAtPeriodEnd: Boolean(r.sub_cancel_at_period_end),
      paid: paid.get(r.id) ?? [],
    };
  });

  return c.json({ page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)), items });
});

/* ------------------------------ 付费记录列表 ----------------------------- */

interface OrderRow {
  id: string;
  plan: string;
  amount_cents: number;
  currency: string;
  status: string;
  paid_at: number | null;
  created_at: number;
  provider: string;
  provider_order_id: string;
  subscription_id: string | null;
  email: string | null;
  name: string | null;
}

admin.get("/payments", async (c) => {
  const env = c.env;
  const page = clampInt(c.req.query("page"), 1, 1, 10_000);
  const pageSize = clampInt(c.req.query("pageSize"), 20, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const status = (c.req.query("status") ?? "").trim();
  const statusOk = status === "paid" || status === "refunded" || status === "failed";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push(
      "(u.email LIKE ? OR COALESCE(u.name, '') LIKE ? OR o.provider_order_id LIKE ?)",
    );
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (statusOk) {
    where.push("o.status = ?");
    binds.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS c FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereSql}`).bind(
      ...binds,
    ),
    env.DB.prepare(
      `SELECT o.id, o.plan, o.amount_cents, o.currency, o.status, o.paid_at, o.created_at,
              o.provider, o.provider_order_id, o.subscription_id,
              u.email, u.name
         FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         ${whereSql}
        ORDER BY COALESCE(o.paid_at, o.created_at) DESC
        LIMIT ? OFFSET ?`,
    ).bind(...binds, pageSize, offset),
  ]);

  const total = ((countRes?.results?.[0] ?? { c: 0 }) as { c: number }).c;
  const rows = (listRes?.results ?? []) as OrderRow[];

  return c.json({
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map((r) => ({
      id: r.id,
      plan: r.plan,
      amount: r.amount_cents,
      currency: r.currency,
      status: r.status,
      paidAt: r.paid_at,
      createdAt: r.created_at,
      provider: r.provider,
      orderId: r.provider_order_id,
      autoRenew: Boolean(r.subscription_id),
      email: r.email,
      name: r.name,
    })),
  });
});

/* --------------------------- 付费按钮点击统计 ---------------------------- */

/**
 * 只统计已登录用户的点击：匿名点击在 /api/track/paywall 就被丢弃，
 * 所以人级归因没有歧义 —— 一行 user_id 就是一个人。
 */

/** 北京时间的日界（+8h），SQL 里用整除换算成天序号 */
const TZ_OFFSET_MS = 8 * 3_600_000;
const MAX_SEARCH_USERS = 200;

interface PaywallButtonRow {
  key: string;
  label: string;
  count: number;
  people: number;
  lastAt: number | null;
}

function parseButtonKeys(raw: string | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of (raw ?? "").split(",")) {
    if (key) out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

admin.get("/paywall-clicks", async (c) => {
  const env = c.env;
  // days=0 表示全部时间
  const days = clampInt(c.req.query("days"), 30, 0, 3_650);
  const since = days > 0 ? Date.now() - days * DAY_MS : 0;

  const [totalRes, paidRes, buttonRes, dailyRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS clicks,
              COUNT(DISTINCT user_id) AS users,
              MAX(created_at) AS last
         FROM paywall_clicks
        WHERE created_at >= ?`,
    ).bind(since),
    // 点击过的人里有多少已经付过费：转化率比点击数本身更有用
    env.DB.prepare(
      `SELECT COUNT(DISTINCT c.user_id) AS c
         FROM paywall_clicks c
         JOIN orders o ON o.user_id = c.user_id AND o.status = 'paid'
        WHERE c.created_at >= ?`,
    ).bind(since),
    env.DB.prepare(
      `SELECT button_key, COUNT(*) AS c, COUNT(DISTINCT user_id) AS p, MAX(created_at) AS last
         FROM paywall_clicks
        WHERE created_at >= ?
        GROUP BY button_key
        ORDER BY c DESC`,
    ).bind(since),
    env.DB.prepare(
      `SELECT (created_at + ?) / ? AS bucket, COUNT(*) AS c
         FROM paywall_clicks
        WHERE created_at >= ?
        GROUP BY bucket
        ORDER BY bucket`,
    ).bind(TZ_OFFSET_MS, DAY_MS, since),
  ]);

  const totals = (totalRes?.results?.[0] ?? {}) as {
    clicks?: number;
    users?: number;
    last?: number | null;
  };
  const paidUsers = ((paidRes?.results?.[0] ?? { c: 0 }) as { c: number }).c;
  const rows = (buttonRes?.results ?? []) as {
    button_key: string;
    c: number;
    p: number;
    last: number;
  }[];

  // 白名单里的按钮即使 0 次也要出现，否则前端不知道有哪些按钮
  const counts = new Map(rows.map((r) => [r.button_key, r]));
  // 显式标注：下面要 push 白名单外的历史 key，不能让它收紧成字面量联合类型
  const buttons: PaywallButtonRow[] = PAYWALL_BUTTONS.map((def) => {
    const hit = counts.get(def.key);
    return {
      key: def.key,
      label: def.label,
      count: hit?.c ?? 0,
      people: hit?.p ?? 0,
      lastAt: hit?.last ?? null,
    };
  });

  // 历史遗留（按钮被下线）的 key 也带上，避免老数据凭空消失
  for (const row of rows) {
    if (!buttons.some((b) => b.key === row.button_key)) {
      buttons.push({
        key: row.button_key,
        label: paywallButtonLabel(row.button_key),
        count: row.c,
        people: row.p,
        lastAt: row.last,
      });
    }
  }

  const daily = ((dailyRes?.results ?? []) as { bucket: number; c: number }[]).map((r) => ({
    date: new Date(r.bucket * DAY_MS).toISOString().slice(0, 10),
    count: r.c,
  }));

  return c.json({
    days,
    totals: {
      clicks: totals.clicks ?? 0,
      users: totals.users ?? 0,
      paidUsers,
      lastAt: totals.last ?? null,
    },
    buttons,
    daily,
  });
});

admin.get("/paywall-people", async (c) => {
  const env = c.env;
  const days = clampInt(c.req.query("days"), 30, 0, 3_650);
  const since = days > 0 ? Date.now() - days * DAY_MS : 0;
  const page = clampInt(c.req.query("page"), 1, 1, 10_000);
  const pageSize = clampInt(c.req.query("pageSize"), 20, 1, MAX_PAGE_SIZE);
  const offset = (page - 1) * pageSize;
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);

  // 搜索只认账号：先命中用户表，命不中就直接返回空
  const where: string[] = [];
  const binds: unknown[] = [];
  if (since > 0) {
    where.push("created_at >= ?");
    binds.push(since);
  }
  if (q) {
    const res = await env.DB.prepare(
      `SELECT id FROM users
        WHERE email LIKE ? OR COALESCE(name, '') LIKE ?
        ORDER BY created_at DESC
        LIMIT ?`,
    )
      .bind(`%${q}%`, `%${q}%`, MAX_SEARCH_USERS)
      .all<{ id: string }>();
    const matchedIds = (res.results ?? []).map((r) => r.id);
    if (!matchedIds.length) {
      return c.json({ page, pageSize, total: 0, pages: 1, items: [] });
    }
    where.push(`user_id IN (${matchedIds.map(() => "?").join(",")})`);
    binds.push(...matchedIds);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [countRes, listRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT COUNT(*) AS c FROM (
         SELECT 1 FROM paywall_clicks ${whereSql} GROUP BY user_id
       )`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT user_id AS uid,
              COUNT(*) AS total,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              group_concat(button_key) AS keys
         FROM paywall_clicks
         ${whereSql}
        GROUP BY user_id
        ORDER BY last_at DESC
        LIMIT ? OFFSET ?`,
    ).bind(...binds, pageSize, offset),
  ]);

  const total = ((countRes?.results?.[0] ?? { c: 0 }) as { c: number }).c;
  const rows = (listRes?.results ?? []) as {
    uid: string;
    total: number;
    first_at: number;
    last_at: number;
    keys: string | null;
  }[];

  // 补齐这一页的邮箱/姓名，以及是否已经付过费（转化情况比点击本身更有用）
  const uids = rows.map((r) => r.uid);
  const identity = new Map<string, { email: string | null; name: string | null }>();
  const paidIds = new Set<string>();
  if (uids.length) {
    const placeholders = uids.map(() => "?").join(",");
    const [userRes, paidRes] = await env.DB.batch([
      env.DB.prepare(`SELECT id, email, name FROM users WHERE id IN (${placeholders})`).bind(...uids),
      env.DB.prepare(
        `SELECT DISTINCT user_id FROM orders WHERE status = 'paid' AND user_id IN (${placeholders})`,
      ).bind(...uids),
    ]);
    for (const row of (userRes?.results ?? []) as { id: string; email: string; name: string | null }[]) {
      identity.set(row.id, { email: row.email, name: row.name });
    }
    for (const row of (paidRes?.results ?? []) as { user_id: string }[]) {
      paidIds.add(row.user_id);
    }
  }

  return c.json({
    page,
    pageSize,
    total,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map((r) => ({
      userId: r.uid,
      email: identity.get(r.uid)?.email ?? null,
      name: identity.get(r.uid)?.name ?? null,
      paid: paidIds.has(r.uid),
      total: r.total,
      firstAt: r.first_at,
      lastAt: r.last_at,
      clicks: parseButtonKeys(r.keys),
    })),
  });
});

