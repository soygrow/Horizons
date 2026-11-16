#!/usr/bin/env node
/**
 * 本地静态服务器 —— 复刻 Cloudflare 静态资产的解析规则
 *
 * 为什么不用 `astro dev` / `astro preview`：
 *   - dev 是开发态（HMR、按需编译），页面可能和线上产物不一致；
 *   - preview 需要额外的运行时依赖，且行为随版本变化。
 * 这里直接按 Cloudflare 的 html_handling=drop-trailing-slash 规则解析 dist：
 *   请求 /tools        → dist/tools/index.html
 *   请求 /tools/       → 308 跳到 /tools
 *   请求 /_astro/x.css → 原样返回
 *   未命中             → dist/404.html（状态码 404）
 *
 * 用法：node scripts/local/static-server.mjs <distDir> <port>
 */
import { createServer, request as httpRequest } from "node:http";
import { createReadStream, existsSync, promises as fsp } from "node:fs";
import path from "node:path";

/** 接适配器后静态资产在 dist/client（SSR chunk 在 dist/server 里，不该被当静态文件对外） */
const rawRoot = path.resolve(process.argv[2] ?? "apps/site/dist");
const root = existsSync(path.join(rawRoot, "client")) ? path.join(rawRoot, "client") : rawRoot;
const port = Number(process.argv[3] ?? process.env.PORT ?? 4321);

/** /api/* 转给本地 wrangler dev（apps/api）；未启动时返回 502，不影响静态页面 */
const API_ORIGIN = new URL(process.env.API_ORIGIN ?? "http://127.0.0.1:8787");

function proxyApi(req, res) {
  const upstream = httpRequest(
    {
      hostname: API_ORIGIN.hostname,
      port: API_ORIGIN.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: API_ORIGIN.host },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    res
      .writeHead(502, headers("application/json; charset=utf-8"))
      .end(JSON.stringify({ error: "api offline", hint: "pnpm dev:api" }));
    log(req, 502);
  });
  req.pipe(upstream);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const headers = (type, extra = {}) => ({
  "Content-Type": type,
  // 本地调试永远不要缓存，避免“改了没生效”的假象
  "Cache-Control": "no-store, must-revalidate",
  "X-Local-Deploy": "horizons",
  ...extra,
});

async function statFile(p) {
  try {
    const s = await fsp.stat(p);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function sendFile(req, res, filePath, size, status = 200) {
  res.writeHead(
    status,
    headers(MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream", {
      "Content-Length": size,
    })
  );
  if (req.method === "HEAD") return res.end();
  createReadStream(filePath).pipe(res);
}

function log(req, status) {
  process.stdout.write(`${status}  ${req.method} ${req.url}\n`);
}

const server = createServer(async (req, res) => {
  // 「我在做」等动态接口：原样代理到本地 API（含 POST / DELETE 与 Cookie）
  if ((req.url ?? "").startsWith("/api/")) return proxyApi(req, res);

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, headers("text/plain; charset=utf-8")).end("Method Not Allowed");
    return log(req, 405);
  }

  let pathname = "/";
  let search = "";
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    pathname = decodeURIComponent(url.pathname);
    search = url.search;
  } catch {
    res.writeHead(400, headers("text/plain; charset=utf-8")).end("Bad Request");
    return log(req, 400);
  }

  // 统一成无尾斜杠（与线上 drop-trailing-slash 一致）
  if (pathname.length > 1 && pathname.endsWith("/")) {
    const target = pathname.replace(/\/+$/, "") + search;
    res.writeHead(308, headers("text/plain; charset=utf-8", { Location: target || "/" })).end();
    return log(req, 308);
  }

  // 防目录穿越
  const rel = pathname.replace(/^\/+/, "");
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.writeHead(403, headers("text/plain; charset=utf-8")).end("Forbidden");
    return log(req, 403);
  }

  // 1) 精确文件
  let file = await statFile(abs);
  let filePath = abs;

  // 2) 目录 → index.html
  if (!file) {
    try {
      if ((await fsp.stat(abs)).isDirectory()) {
        filePath = path.join(abs, "index.html");
        file = await statFile(filePath);
      }
    } catch {
      /* not a dir */
    }
  }

  // 3) 兜底 /path → /path.html
  if (!file) {
    filePath = abs + ".html";
    file = await statFile(filePath);
  }

  if (file) {
    sendFile(req, res, filePath, file.size);
    return log(req, 200);
  }

  // 4) 自定义 404
  const fallback = path.join(root, "404.html");
  const fallbackStat = await statFile(fallback);
  if (fallbackStat) {
    sendFile(req, res, fallback, fallbackStat.size, 404);
    return log(req, 404);
  }
  res.writeHead(404, headers("text/plain; charset=utf-8")).end("Not Found");
  log(req, 404);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[local] serving ${root}`);
  console.log(`[local] http://localhost:${port}`);
});