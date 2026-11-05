import { Hono } from "hono";
import type { Env } from "./env";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { ph } from "./routes/ph";
import { opportunity } from "./routes/opportunity";
import { billing } from "./routes/billing";
import { track } from "./routes/track";
import { admin } from "./routes/admin";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/auth", auth);
app.route("/api/billing", billing);
app.route("/api/track", track);
app.route("/api/ph", ph);
// 后台管理独立挂载，必须排在 `/api` 通配挂载之前
app.route("/api/admin", admin);
// 顺序无关：/doing/counts 与 /:slug/doing 不会互相吞掉（前者无 :slug 段）
app.route("/api/opportunity", opportunity);
app.route("/api", user);

app.get("/health", (c) => c.json({ ok: true, service: "horizons-api" }));

/**
 * 统一兜底：未捕获异常写一行日志（`wrangler tail` 可见），
 * 但响应里只给 general error，不把堆栈/SQL/绑定信息吐给客户端。
 */
app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path} →`, err instanceof Error ? err.stack : String(err));
  return c.json({ error: "internal_error" }, 500);
});

export default app;
