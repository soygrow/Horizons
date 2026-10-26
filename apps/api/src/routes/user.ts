import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { verifySession, SESSION_COOKIE } from "../lib/session";

export const user = new Hono<{ Bindings: Env }>();

/** 当前登录用户；未登录返回 { user: null } */
user.get("/me", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ user: null });
  const session = await verifySession(token, c.env.SESSION_SECRET);
  if (!session) return c.json({ user: null });
  return c.json({ user: session });
});
