// 采集层 HTTP：统一 UA、超时、有限重试。
// 只访问公开接口与 RSS，不绕速率限制，不做需要登录的抓取。

const UA =
  "Horizons-daily-intel/0.1 (public API & RSS only; low frequency; contact via project repository)";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** 失败重试的基础退避，默认 800ms */
  backoffMs?: number;
}

async function request(url: string, opts: RequestOptions = {}): Promise<Response> {
  const { headers = {}, timeoutMs = 15_000, retries = 2, backoffMs = 800 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "*/*", ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "follow",
      });
      if (res.status === 429 || res.status >= 500) {
        // 限流与服务端错误：退避后重试，不硬闯
        lastError = new HttpError(`${hostOf(url)} ${res.status}`, res.status);
        if (attempt < retries) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
      }
      if (!res.ok) throw new HttpError(`${hostOf(url)} ${res.status}`, res.status);
      return res;
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(backoffMs * Math.pow(2, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${hostOf(url)} 请求失败`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function getJson<T>(url: string, opts: RequestOptions = {}): Promise<T> {
  const res = await request(url, { ...opts, headers: { accept: "application/json", ...opts.headers } });
  return (await res.json()) as T;
}

export async function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  const res = await request(url, {
    ...opts,
    headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", ...opts.headers },
  });
  return await res.text();
}

/** 解析 GitHub 速率限制响应头，用于日志里说明「为什么只采到这么多」 */
export function rateLimitNote(headers: Headers): string {
  const remaining = headers.get("x-ratelimit-remaining");
  const limit = headers.get("x-ratelimit-limit");
  if (!remaining || !limit) return "";
  return `剩余额度 ${remaining}/${limit}`;
}