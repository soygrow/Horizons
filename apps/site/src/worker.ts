/**
 * 站点 Worker：只拦截 /screenshots/* 从 R2 取图，其余请求原样交给静态资产。
 *
 * 截图体积大（数百张），不适合随 Astro 构建产物一起部署；
 * 放到 R2 后，构建产物保持轻量，图片 URL 仍是 /screenshots/<domain>.png，数据与页面无需改动。
 */
interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  IMAGES: { get(key: string): Promise<R2ObjectLike | null> };
}

interface R2ObjectLike {
  body: ReadableStream | null;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

const SHOT_PREFIX = "/screenshots/";

/** 截图按域名命名、内容极少变化，给长缓存；入口 URL 不变，改图时可用域名后缀或清缓存 */
const CACHE_CONTROL = "public, max-age=604800, stale-while-revalidate=86400";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(SHOT_PREFIX)) return env.ASSETS.fetch(request);

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