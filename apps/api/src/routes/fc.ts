/**
 * 新采集结果的公开只读接口。
 *
 * 为什么不做鉴权：结果页（/field-collect?id=…）展示的是「某个公开网站」的字段采集明细，
 * 不含任何用户数据；而采集 id 是 crypto.randomUUID()（122 bit 随机），枚举不出来。
 * 反过来，如果挂后台登录态，Cookie 一过期 / 换个浏览器 / 把链接发给别人，页面就只剩
 * 「需要先登录后台」一句话 —— 这正是当初「点查看字段看不到内容」的由来。
 *
 * 只读：这里没有任何写操作，写回仍由采集脚本和后台触发接口负责。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { loadRunDetail } from "./admin-field-collect";

export const fcPublic = new Hono<{ Bindings: Env }>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

fcPublic.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID_RE.test(id)) return c.json({ error: "bad_id" }, 400);

  try {
    const run = await loadRunDetail(c.env, id);
    if (!run) return c.json({ error: "not_found" }, 404);
    // 采集结果写完就不再变，但状态可能需要收尾，交给浏览器短缓存会看到中间态，所以不缓存
    c.header("cache-control", "no-store");
    return c.json({ run });
  } catch (e) {
    return c.json({ error: "db_error", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});