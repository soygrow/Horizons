// 极简 HTTP/HTTPS 代理支持：Node 原生 fetch 不读 HTTPS_PROXY，
// 所以这里用 CONNECT 隧道 + tls 包装一个 Agent，零依赖。
// 未配置代理时回退到全局 fetch。
import { Agent, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

/** 出口：null 表示直连（不挂代理） */
export type Exit = URL | null;

const DIRECT_TOKENS = new Set(["direct", "直连", "直链", "none", "off"]);

/**
 * 出口列表。TRENDS_PROXY 支持逗号/分号/空白分隔的多个出口，
 * 也可以把「直连」当作一个出口混排：
 *   TRENDS_PROXY="direct,127.0.0.1:7890"   → 先直连，被限流后换代理
 * 某个 IP 被 Google 限流时自动换下一个，而不是干等冷却。
 * 未配置时默认直连。
 */
export function exitList(): Exit[] {
  const raw = [
    process.env.TRENDS_PROXY,
    process.env.HTTPS_PROXY || process.env.https_proxy,
    process.env.ALL_PROXY || process.env.all_proxy,
  ]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join(",");

  const out: Exit[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;\s]+/)) {
    const text = part.trim();
    if (!text) continue;

    if (DIRECT_TOKENS.has(text.toLowerCase())) {
      if (!seen.has("direct")) {
        seen.add("direct");
        out.push(null);
      }
      continue;
    }

    try {
      const u = new URL(text.includes("://") ? text : `http://${text}`);
      if (!u.hostname) continue;
      const key = `${u.protocol}//${u.hostname}:${u.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    } catch {
      // 忽略非法项
    }
  }

  if (out.length === 0) out.push(null);
  return out;
}

let activeExit = 0;

/** 当前生效的出口 */
export function currentExit(): Exit {
  const list = exitList();
  return list[activeExit % list.length] ?? null;
}

/** 当前出口的可读标识，用于日志 */
export function exitLabel(): string {
  const exit = currentExit();
  return exit ? `${exit.hostname}:${exit.port || (exit.protocol === "https:" ? 443 : 80)}` : "direct";
}

/** 兼容旧调用点 */
export function proxyUrl(): URL | null {
  return currentExit();
}

/** 切到下一个出口；只有 1 个出口时返回 false（调用方改为退避等待） */
export function rotateProxy(): boolean {
  const list = exitList();
  if (list.length <= 1) return false;
  activeExit = (activeExit + 1) % list.length;
  return true;
}

/** 出口总数：1 表示被限流时只能原地等解封，换不了 IP */
export function exitCount(): number {
  return exitList().length;
}

/** 指定第 index 个出口（自检用，按顺序体检每一个） */
export function useExit(index: number): boolean {
  const list = exitList();
  if (index < 0 || index >= list.length) return false;
  activeExit = index;
  return true;
}

function tunnelAgent(proxy: URL): Agent {
  const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const auth =
    proxy.username || proxy.password
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}`
      : "";

  const agent = new Agent({ keepAlive: true, maxSockets: 4 });
  // 覆盖建连：先 CONNECT 到代理，再把裸 socket 升级成 TLS
  agent.createConnection = ((
    options: ConnectionOptions & { host?: string; servername?: string; port?: number },
    callback: (err: Error | null, socket?: import("node:net").Socket) => void,
  ) => {
    const target = `${options.host}:${options.port}`;
    const req = httpRequest({
      host: proxy.hostname,
      port,
      method: "CONNECT",
      path: target,
      headers: { host: target, ...(auth ? { "proxy-authorization": auth } : {}) },
      timeout: 20_000,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理 CONNECT 失败：${res.statusCode}`));
        return;
      }
      const secure = tlsConnect({
        socket,
        servername: options.servername || options.host,
      });
      secure.once("secureConnect", () => callback(null, secure));
      secure.once("error", (e) => callback(e));
    });
    req.once("timeout", () => req.destroy(new Error("代理连接超时")));
    req.once("error", (e) => callback(e));
    req.end();
  }) as unknown as Agent["createConnection"];
  return agent;
}

const agentCache = new Map<string, Agent>();

export function getAgent(): Agent | null {
  const proxy = currentExit();
  if (!proxy) return null; // 直连出口：走原生 fetch
  const key = `${proxy.protocol}//${proxy.hostname}:${proxy.port}`;
  const hit = agentCache.get(key);
  if (hit) return hit;
  const agent = tunnelAgent(proxy);
  agentCache.set(key, agent);
  return agent;
}

export interface SimpleResponse {
  status: number;
  ok: boolean;
  text(): Promise<string>;
  /** 响应头 set-cookie（已拆成数组） */
  setCookies(): string[];
}

export interface SimpleRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * 走代理的请求。返回最小响应接口（status / ok / text / setCookies），
 * 够采集与 LLM 调用用，不需要完整 fetch 语义。
 */
export async function proxyRequest(
  url: string | URL,
  init: SimpleRequest = {},
): Promise<SimpleResponse> {
  const agent = getAgent();
  const u = typeof url === "string" ? new URL(url) : url;
  const timeoutMs = init.timeoutMs ?? 30_000;
  const method = init.method ?? "GET";

  if (!agent) {
    const res = await fetch(u, {
      method,
      headers: init.headers,
      body: init.body,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: res.status,
      ok: res.ok,
      text: () => res.text(),
      setCookies: () =>
        (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [],
    };
  }

  return new Promise<SimpleResponse>((resolve, reject) => {
    const headers: Record<string, string> = {
      // 不主动要 gzip，省掉解压逻辑
      "accept-encoding": "identity",
      ...init.headers,
    };
    if (init.body) headers["content-length"] = String(Buffer.byteLength(init.body));

    const req = httpsRequest(
      u,
      { method, agent, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const location = res.headers.location;
          // 只对 GET 跟随重定向（采集 Trends HTML 会遇到 301）
          if (
            method === "GET" &&
            location &&
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400
          ) {
            proxyRequest(new URL(location, u).toString(), init).then(resolve, reject);
            return;
          }
          const setCookies = res.headers["set-cookie"] ?? [];
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: async () => raw.toString("utf8"),
            setCookies: () => setCookies,
          });
        });
        res.on("error", reject);
      },
    );
    req.once("timeout", () => req.destroy(new Error(`请求超时：${u.hostname}`)));
    req.once("error", reject);
    req.end(init.body);
  });
}

/** GET 简写 */
export function proxyGet(url: string | URL, init: SimpleRequest = {}): Promise<SimpleResponse> {
  return proxyRequest(url, { ...init, method: "GET" });
}

/** POST JSON 简写 */
export function proxyPostJSON(
  url: string | URL,
  body: string,
  init: SimpleRequest = {},
): Promise<SimpleResponse> {
  return proxyRequest(url, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body,
  });
}