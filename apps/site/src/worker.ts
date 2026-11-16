/**
 * 站点 Worker：接管两类动态请求，其余原样交给静态资产。
 *
 * 1. /screenshots/*  —— 截图体积大（数百张），存在 R2 里，构建产物保持轻量，
 *    URL 仍是 /screenshots/<domain>.png，数据与页面无需改动。
 * 2. /preview/*      —— 后台预览页，**按需渲染**（Astro SSR）直接查 D1 的未发布条目。
 *    不能公开，所以先校验 session cookie（和 /api/admin 同一张 admin_sessions 表），
 *    未登录一律 302 回 /admin 登录，登录后自动跳回来；通过后才交给 Astro 渲染。
 *
 * 预览鉴权必须放在 Worker，而不是靠 noindex 或藏在 /admin 路径下：
 * 鉴权不通过时不能产生任何 HTML，否则未发布内容等于公开。
 *
 * 其余路径是纯静态资产：wrangler.jsonc 的 run_worker_first 只把这两类路径
 * 引进 Worker，所以这里的 ASSETS.fetch 只是兜底，不会成为性能瓶颈。
 */
import { handle } from "@astrojs/cloudflare/handler";

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  IMAGES: { get(key: string): Promise<R2ObjectLike | null> };
  /** 与 API Worker 同一个 D1（只读 admin_sessions）。未绑定时按未登录处理 */
  DB?: {
    prepare(sql: string): {
      bind(...values: unknown[]): { first<T = Record<string, unknown>>(): Promise<T | null> };
    };
  };
}

interface R2ObjectLike {
  body: ReadableStream | null;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

const SHOT_PREFIX = "/screenshots/";
const PREVIEW_PREFIX = "/preview";
const ADMIN_COOKIE = "hzn_admin";
const ADMIN_PAGE = "/admin";

/** 截图按域名命名、内容极少变化，给长缓存；入口 URL 不变，改图时可用域名后缀或清缓存 */
const CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=86400";

/* ------------------------------ 预览鉴权 ------------------------------ */

function isPreviewPath(pathname: string): boolean {
  return pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** 与 API 的 readSession 保持同一口径：库里只存 sha256(token) */
async function isAdminSession(request: Request, env: Env): Promise<boolean> {
  const token = readCookie(request.headers.get("cookie"), ADMIN_COOKIE);
  if (!token || token.length < 20 || token.length > 128) return false;
  // 没绑 D1 时宁可拦下，也不放行未发布内容
  if (!env.DB) return false;

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const tokenHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  try {
    const row = await env.DB.prepare("SELECT expires_at FROM admin_sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .first<{ expires_at: number }>();
    return !!row && row.expires_at > Date.now();
  } catch {
    // 查库失败时按未授权处理（fail closed）
    return false;
  }
}

/**
 * 静态资产本身可能带公共缓存头，鉴权后的响应必须改掉，
 * 否则 CDN / 浏览器缓存会把未发布内容存下来，鉴权等于没做。
 */
function privateResponse(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function servePreview(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
  url: URL,
): Promise<Response> {
  if (!(await isAdminSession(request, env))) {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, {
      status: 302,
      headers: { location: `${ADMIN_PAGE}?next=${next}`, "cache-control": "no-store" },
    });
  }
  return privateResponse(await handle(request, env as never, ctx as never));
}

/* --------------------------------- 入口 --------------------------------- */

/** Astro 的 SSR 只要 waitUntil；这里不引 workers-types 的全局声明 */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContextLike): Promise<Response> {
    const url = new URL(request.url);

    if (isPreviewPath(url.pathname)) return servePreview(request, env, ctx, url);

    /*
     * 交给 Astro 的 SSR 入口，而不是直接 ASSETS.fetch。
     * 构建期 adapter 会起一个 workerd 预渲染服务器、通过内部路径向本 Worker
     * 索取静态路由表；把请求直接甩给 ASSETS 会让它拿到 404（构建就断在这）。
     * 生产环境其余路径由 run_worker_first 白名单挡在 Worker 之外，
     * 走不到这里，静态直出的性能不受影响。
     */
    if (!url.pathname.startsWith(SHOT_PREFIX)) {
      return handle(request, env as never, ctx as never);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let key: string;
    try {
      key = decodeURIComponent(url.pathname.slice(SHOT_PREFIX.length));
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    // 只允许桶内平铺的文件名，挡掉路径穿越
    if (!key || key.includes("..") || key.includes("/")) {
      return new Response("Not Found", { status: 404 });
    }

    const object = await env.IMAGES.get(key);
    // 尚未上传的站仍回落静态资产（通常是 404 页），不阻断整站
    if (!object) return env.ASSETS.fetch(request);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", CACHE_CONTROL);

    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  },
};