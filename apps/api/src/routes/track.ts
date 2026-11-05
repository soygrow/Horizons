/**
 * 轻量埋点：目前只有「付费按钮点击」一种事件。
 *
 * 设计要点：
 * - 只认已登录用户：未登录的点击直接丢弃。定价页点按钮会先跳登录，登录回来后
 *   那一次点击才计数，所以统计里不会混入「随手点一下就走」的流量。
 * - 静默失败：埋点不能影响用户下单，任何异常都返回 204，前端也不需要处理响应。
 * - 同源校验：只接受本站页面发出的请求，避免被其他站点成批灌数据。
 * - 防刷：同一账号 3 秒内重复点同一个按钮只记一次；单日上限 200 次。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { isPaywallButtonKey } from "../lib/paywall";
import { verifySession, SESSION_COOKIE } from "../lib/session";

type Ctx = Context<{ Bindings: Env }>;

const MIN_GAP_MS = 3_000;
const DAILY_CAP = 200;
const DAY_MS = 86_400_000;
const encoder = new TextEncoder();

export const track = new Hono<{ Bindings: Env }>();

function clientIp(c: Ctx): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  );
}

async function sha256Hex(input: string): Promise<string> {
  const bits = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 只认本站来源：Origin 优先，退化看 Referer；都不匹配就当作第三方请求丢弃 */
function isSameOrigin(c: Ctx): boolean {
  const appUrl = c.env.APP_URL?.replace(/\/+$/, "");
  if (!appUrl) return false;
  const origin = c.req.header("origin");
  if (origin && origin !== "null") return origin.replace(/\/+$/, "") === appUrl;
  const referer = c.req.header("referer");
  return Boolean(referer && referer.startsWith(appUrl));
}

track.post("/paywall", async (c) => {
  if (!isSameOrigin(c)) return c.body(null, 204);

  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) return c.body(null, 204);

  // 未登录的点击不计入统计：直接吞掉，前端无需区分
  const token = getCookie(c, SESSION_COOKIE);
  const session = token ? await verifySession(token, c.env.SESSION_SECRET) : null;
  if (!session) return c.body(null, 204);

  let payload: { button?: unknown; page?: unknown };
  try {
    payload = (await c.req.json()) as { button?: unknown; page?: unknown };
  } catch {
    return c.body(null, 204);
  }

  const button = typeof payload.button === "string" ? payload.button.trim() : "";
  if (!isPaywallButtonKey(button)) return c.body(null, 204);

  const rawPage = typeof payload.page === "string" ? payload.page : "";
  const page = rawPage.startsWith("/") ? rawPage.slice(0, 120) : null;

  const userId = session.id;
  const now = Date.now();
  const env = c.env;

  try {
    const [lastRow, dayRow] = await env.DB.batch([
      env.DB.prepare(
        "SELECT created_at FROM paywall_clicks WHERE user_id = ? AND button_key = ? ORDER BY created_at DESC LIMIT 1",
      ).bind(userId, button),
      env.DB.prepare(
        "SELECT COUNT(*) AS c FROM paywall_clicks WHERE user_id = ? AND created_at >= ?",
      ).bind(userId, now - DAY_MS),
    ]);

    const last = (lastRow?.results?.[0] as { created_at?: number } | undefined)?.created_at ?? 0;
    const today = ((dayRow?.results?.[0] ?? { c: 0 }) as { c: number }).c;
    // 连点、刷新重放、脚本刷量都会走到这两个闸门
    if (now - last < MIN_GAP_MS || today >= DAILY_CAP) return c.body(null, 204);

    await env.DB.prepare(
      `INSERT INTO paywall_clicks (user_id, button_key, page, created_at, ip_hash)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(userId, button, page, now, await sha256Hex(clientIp(c)))
      .run();
  } catch (error) {
    // 埋点失败不影响任何业务，只留一行日志
    console.error("[track] paywall click failed:", error instanceof Error ? error.message : String(error));
  }

  return c.body(null, 204);
});