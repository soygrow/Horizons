/**
 * 工具收藏：账号级、跨设备。
 *
 * 设计取舍：
 * - 只存 domain，不存名称/流量等展示字段：内容侧 content/aitools.json 才是权威，
 *   存快照会导致榜单更新后收藏列表里还是旧数据。
 * - 只写「最终态」：未登录阶段前端把收藏放 localStorage，登录后调 /merge 一次性补上来，
 *   因此服务端不需要区分来源，也不需要冲突解决。
 * - 上限 500：防脚本刷库；正常用户不可能触达。
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { SESSION_COOKIE, verifySession } from "../lib/session";
import type { SessionUser } from "@horizons/shared";

export const favorites = new Hono<{ Bindings: Env }>();

/** 只接受「像域名」的字符串，避免把任意输入写进库 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const MAX_FAVORITES = 500;
const MAX_MERGE = 200;
/** D1 batch 单次语句数别太大，分批写 */
const MERGE_BATCH = 40;

interface FavoriteRow {
  domain: string;
  createdAt: number;
}

async function currentUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return verifySession(token, c.env.SESSION_SECRET);
}

function normalizeDomain(raw: string | undefined | null): string {
  const d = (raw ?? "").toLowerCase().trim();
  if (!d || d.length > 253 || !DOMAIN_RE.test(d)) return "";
  return d;
}

async function listFavorites(c: Context<{ Bindings: Env }>, userId: string): Promise<FavoriteRow[]> {
  const { results } = await c.env.DB.prepare(
    `SELECT domain, created_at AS createdAt
     FROM tool_favorites
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(userId, MAX_FAVORITES)
    .all<FavoriteRow>();
  return results ?? [];
}

/** 当前用户的收藏清单（未登录返回 401，前端据此回落到 localStorage） */
favorites.get("/", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json({ favorites: await listFavorites(c, user.id) });
});

/** 收藏一个工具；已收藏时为幂等成功 */
favorites.put("/:domain", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const domain = normalizeDomain(c.req.param("domain"));
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM tool_favorites WHERE user_id = ? AND domain = ?",
  )
    .bind(user.id, domain)
    .first<{ id: string }>();

  if (!existing) {
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM tool_favorites WHERE user_id = ?",
    )
      .bind(user.id)
      .first<{ n: number }>();
    if (Number(count?.n ?? 0) >= MAX_FAVORITES) {
      return c.json({ error: "limit", max: MAX_FAVORITES }, 409);
    }

    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO tool_favorites (id, user_id, domain, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), user.id, domain, Date.now())
      .run();
  }

  return c.json({ ok: true, favorited: true });
});

/** 取消收藏；未收藏时同样返回成功 */
favorites.delete("/:domain", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const domain = normalizeDomain(c.req.param("domain"));
  if (!domain) return c.json({ error: "invalid domain" }, 400);

  await c.env.DB.prepare("DELETE FROM tool_favorites WHERE user_id = ? AND domain = ?")
    .bind(user.id, domain)
    .run();

  return c.json({ ok: true, favorited: false });
});

/**
 * 登录后把本地收藏合并上来：只补新增，不删除服务端已有的。
 * 幂等，前端可重复调用。
 */
favorites.post("/merge", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  let body: { domains?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const raw = Array.isArray(body.domains) ? body.domains : [];
  const incoming = [
    ...new Set(
      raw
        .map((v) => (typeof v === "string" ? normalizeDomain(v) : ""))
        .filter((v): v is string => !!v),
    ),
  ].slice(0, MAX_MERGE);

  const current = await listFavorites(c, user.id);
  const known = new Set(current.map((f) => f.domain));
  const room = MAX_FAVORITES - known.size;
  const toAdd = incoming.filter((d) => !known.has(d)).slice(0, Math.max(0, room));

  const now = Date.now();
  for (let i = 0; i < toAdd.length; i += MERGE_BATCH) {
    const chunk = toAdd.slice(i, i + MERGE_BATCH);
    await c.env.DB.batch(
      chunk.map((domain) =>
        c.env.DB.prepare(
          "INSERT OR IGNORE INTO tool_favorites (id, user_id, domain, created_at) VALUES (?, ?, ?, ?)",
        ).bind(crypto.randomUUID(), user.id, domain, now + chunk.indexOf(domain)),
      ),
    );
  }

  return c.json({ ok: true, added: toAdd.length, favorites: await listFavorites(c, user.id) });
});