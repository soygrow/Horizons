/**
 * 「我在做」：机会详情页的参与标记 + 留言。
 *
 * 设计取舍：
 * - 公开读、登录写。留言默认公开（头像 + 内容），所以写入口必须校验会话。
 * - 一人一条参与记录（UNIQUE slug+user），重复提交 = 更新进展；留言不限条数。
 * - 内容只做纯文本 + 长度上限，不存富文本，避免 XSS 面；渲染端仍按纯文本输出。
 */
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../env";
import { SESSION_COOKIE, verifySession } from "../lib/session";
import type { SessionUser } from "@horizons/shared";
import {
  DOING_MAX_BODY,
  DOING_MIN_INTERVAL_MS,
  DOING_STATUSES,
  type DoingDoer,
  type DoingResponse,
  type DoingStatus,
  type DoingUpdate,
  type DoingUserResponse,
} from "@horizons/shared";

export const opportunity = new Hono<{ Bindings: Env }>();

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const MAX_DOERS = 60;
const MAX_UPDATES = 30;

function isStatus(v: unknown): v is DoingStatus {
  return typeof v === "string" && (DOING_STATUSES as readonly string[]).includes(v);
}

/** 去标签、压空白、截断；拒绝空内容 */
function cleanBody(input: unknown): string {
  if (typeof input !== "string") return "";
  const text = input
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, DOING_MAX_BODY);
}

async function currentUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  return verifySession(token, c.env.SESSION_SECRET);
}

/* ------------------------------ 批量人数（列表页） ------------------------------ */

/** 列表页只显示「多少人在做」，一次请求带回多条的计数 */
opportunity.get("/doing/counts", async (c) => {
  const slugs = (c.req.query("slugs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => SLUG_RE.test(s))
    .slice(0, 20);

  if (!slugs.length) return c.json({ counts: {} });

  const placeholders = slugs.map(() => "?").join(",");
  const { results } = await c.env.DB.prepare(
    `SELECT opportunity_slug AS slug, COUNT(*) AS n
     FROM opportunity_doers
     WHERE opportunity_slug IN (${placeholders})
     GROUP BY opportunity_slug`,
  )
    .bind(...slugs)
    .all<{ slug: string; n: number }>();

  const counts: Record<string, number> = Object.fromEntries(slugs.map((s) => [s, 0]));
  for (const row of results ?? []) counts[row.slug] = Number(row.n);
  return c.json({ counts });
});

/* ------------------------------ 读取 ------------------------------ */

opportunity.get("/:slug/doing", async (c) => {
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "invalid slug" }, 400);

  const { results } = await c.env.DB.prepare(
    `SELECT d.user_id   AS userId,
            u.name      AS name,
            u.avatar_url AS avatarUrl,
            d.status    AS status,
            d.created_at AS joinedAt,
            (SELECT COUNT(*) FROM opportunity_updates x
              WHERE x.opportunity_slug = d.opportunity_slug AND x.user_id = d.user_id) AS updateCount,
            COALESCE(
              (SELECT MAX(x.created_at) FROM opportunity_updates x
                WHERE x.opportunity_slug = d.opportunity_slug AND x.user_id = d.user_id),
              d.updated_at
            ) AS lastAt
     FROM opportunity_doers d
     JOIN users u ON u.id = d.user_id
     WHERE d.opportunity_slug = ?
     ORDER BY d.created_at ASC
     LIMIT ?`,
  )
    .bind(slug, MAX_DOERS)
    .all<DoingDoer & { updateCount: number }>();

  const doers: DoingDoer[] = (results ?? []).map((r) => ({
    ...r,
    updateCount: Number(r.updateCount),
  }));

  let me: DoingResponse["me"] = null;
  const user = await currentUser(c);
  if (user) {
    const joined = await c.env.DB.prepare(
      "SELECT status, created_at FROM opportunity_doers WHERE opportunity_slug = ? AND user_id = ?",
    )
      .bind(slug, user.id)
      .first<{ status: DoingStatus; created_at: number }>();

    if (joined) {
      const mine = await c.env.DB.prepare(
        `SELECT id, body, status, created_at AS createdAt
         FROM opportunity_updates
         WHERE opportunity_slug = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
        .bind(slug, user.id, MAX_UPDATES)
        .all<DoingUpdate>();
      me = { status: joined.status, joinedAt: joined.created_at, updates: mine.results ?? [] };
    }
  }

  const payload: DoingResponse = { slug, count: doers.length, doers, authenticated: !!user, me };
  return c.json(payload);
});

/** 某位参与者的全部留言（点击头像时拉取） */
opportunity.get("/:slug/doing/:userId", async (c) => {
  const slug = c.req.param("slug");
  const userId = c.req.param("userId");
  if (!SLUG_RE.test(slug) || !userId) return c.json({ error: "invalid params" }, 400);

  const doer = await c.env.DB.prepare(
    `SELECT u.id AS id, u.name AS name, u.avatar_url AS avatarUrl, d.status AS status
     FROM opportunity_doers d JOIN users u ON u.id = d.user_id
     WHERE d.opportunity_slug = ? AND d.user_id = ?`,
  )
    .bind(slug, userId)
    .first<DoingUserResponse["user"]>();

  if (!doer) return c.json({ error: "not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, body, status, created_at AS createdAt
     FROM opportunity_updates
     WHERE opportunity_slug = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(slug, userId, MAX_UPDATES)
    .all<DoingUpdate>();

  const payload: DoingUserResponse = { user: doer, updates: results ?? [] };
  return c.json(payload);
});

/* ------------------------------ 写入 ------------------------------ */

/** 加入「我在做」或更新进展；body 为空表示只更新状态 */
opportunity.post("/:slug/doing", async (c) => {
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "invalid slug" }, 400);

  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized", login: "/api/auth/google" }, 401);

  let body: { body?: unknown; status?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const status: DoingStatus = isStatus(body.status) ? body.status : "doing";
  const text = cleanBody(body.body);

  const now = Date.now();
  const existing = await c.env.DB.prepare(
    "SELECT id FROM opportunity_doers WHERE opportunity_slug = ? AND user_id = ?",
  )
    .bind(slug, user.id)
    .first<{ id: string }>();

  if (!existing) {
    await c.env.DB.prepare(
      `INSERT INTO opportunity_doers (id, opportunity_slug, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), slug, user.id, status, now, now)
      .run();
  } else {
    // 限流：同一用户 20 秒内只能提交一次，防连点与刷屏
    const recent = await c.env.DB.prepare(
      `SELECT created_at FROM opportunity_updates
       WHERE opportunity_slug = ? AND user_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(slug, user.id)
      .first<{ created_at: number }>();
    if (recent && now - recent.created_at < DOING_MIN_INTERVAL_MS) {
      return c.json({ error: "too fast", retryInMs: DOING_MIN_INTERVAL_MS - (now - recent.created_at) }, 429);
    }

    await c.env.DB.prepare(
      "UPDATE opportunity_doers SET status = ?, updated_at = ? WHERE opportunity_slug = ? AND user_id = ?",
    )
      .bind(status, now, slug, user.id)
      .run();
  }

  if (text) {
    await c.env.DB.prepare(
      `INSERT INTO opportunity_updates (id, opportunity_slug, user_id, body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), slug, user.id, text, status, now)
      .run();
  }

  const mine = await c.env.DB.prepare(
    `SELECT id, body, status, created_at AS createdAt
     FROM opportunity_updates
     WHERE opportunity_slug = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(slug, user.id, MAX_UPDATES)
    .all<DoingUpdate>();

  const joinedAt = existing
    ? (
        await c.env.DB.prepare(
          "SELECT created_at FROM opportunity_doers WHERE opportunity_slug = ? AND user_id = ?",
        )
          .bind(slug, user.id)
          .first<{ created_at: number }>()
      )?.created_at ?? now
    : now;

  return c.json({
    ok: true,
    joined: true,
    me: { status, joinedAt, updates: mine.results ?? [] },
  });
});

/** 退出「我在做」：一并删除自己在该机会下的留言 */
opportunity.delete("/:slug/doing", async (c) => {
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) return c.json({ error: "invalid slug" }, 400);

  const user = await currentUser(c);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM opportunity_updates WHERE opportunity_slug = ? AND user_id = ?").bind(
      slug,
      user.id,
    ),
    c.env.DB.prepare("DELETE FROM opportunity_doers WHERE opportunity_slug = ? AND user_id = ?").bind(
      slug,
      user.id,
    ),
  ]);

  return c.json({ ok: true, joined: false });
});