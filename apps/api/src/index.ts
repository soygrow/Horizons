import { Hono } from "hono";
import type { Env } from "./env";
import { auth } from "./routes/auth";
import { user } from "./routes/user";
import { ph } from "./routes/ph";

const app = new Hono<{ Bindings: Env }>();

app.route("/api/auth", auth);
app.route("/api/ph", ph);
app.route("/api", user);

app.get("/health", (c) => c.json({ ok: true, service: "horizons-api" }));

export default app;
