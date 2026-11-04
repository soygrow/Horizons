import { Hono } from "hono";
import type { Env } from "./env";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { ph } from "./routes/ph";
import { opportunity } from "./routes/opportunity";
import { billing } from "./routes/billing";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/auth", auth);
app.route("/api/billing", billing);
app.route("/api/ph", ph);
// 顺序无关：/doing/counts 与 /:slug/doing 不会互相吞掉（前者无 :slug 段）
app.route("/api/opportunity", opportunity);
app.route("/api", user);

app.get("/health", (c) => c.json({ ok: true, service: "horizons-api" }));

export default app;
