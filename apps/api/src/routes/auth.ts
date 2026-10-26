import { Hono } from "hono";
import type { Env } from "../env";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "../lib/session";
import {
  buildAuthorizeUrl,
  createState,
  exchangeCode,
  fetchUserInfo,
  verifyState,
} from "../lib/google";

export const auth = new Hono<{ Bindings: Env }>();

function sessionCookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 发起 Google 登录 */
auth.get("/google", async (c) => {
  const state = await createState(c.env.SESSION_SECRET);
  const url = buildAuthorizeUrl(
    c.env.GOOGLE_CLIENT_ID,
    c.env.GOOGLE_REDIRECT_URI,
    state,
  );
  return c.redirect(url);
});

/** Google 登录回调：换 token → 拉用户 → upsert → 签发会话 → 跳转账户页 */
auth.get("/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || !(await verifyState(state, c.env.SESSION_SECRET))) {
    return c.text("登录状态校验失败，请重试", 400);
  }

  try {
    const tokens = await exchangeCode(
      code,
      c.env.GOOGLE_CLIENT_ID,
      c.env.GOOGLE_CLIENT_SECRET,
      c.env.GOOGLE_REDIRECT_URI,
    );
    const info = await fetchUserInfo(tokens.access_token);

    const now = Date.now();
    const existing = await c.env.DB.prepare(
      "SELECT id FROM users WHERE google_sub = ?",
    )
      .bind(info.sub)
      .first<{ id: string }>();

    let userId = existing?.id;
    if (!userId) {
      userId = crypto.randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO users (id, google_sub, email, name, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          userId,
          info.sub,
          info.email,
          info.name ?? null,
          info.picture ?? null,
          now,
          now,
        )
        .run();
    } else {
      await c.env.DB.prepare(
        "UPDATE users SET email = ?, name = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
      )
        .bind(info.email, info.name ?? null, info.picture ?? null, now, userId)
        .run();
    }

    const token = await createSession(
      {
        id: userId,
        email: info.email,
        name: info.name ?? null,
        avatarUrl: info.picture ?? null,
      },
      c.env.SESSION_SECRET,
    );

    c.header("Set-Cookie", sessionCookie(token, SESSION_TTL_SECONDS));
    return c.redirect(new URL("/account", c.env.APP_URL).toString());
  } catch (e) {
    console.error("[auth] callback error", e);
    return c.text("登录失败，请稍后重试", 500);
  }
});

/** 登出 */
auth.post("/logout", async (c) => {
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});
