// Google Trends 非官方接口的最小客户端：cookie 引导 + 限流识别 + 退避
// 只用于本地采集脚本；不进入前端构建。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let cookieHeader = "";
let cookieAt = 0;

export class RateLimitError extends Error {
  constructor(message = "Google Trends 返回 429") {
    super(message);
    this.name = "RateLimitError";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function baseHeaders(): Record<string, string> {
  return {
    "user-agent": UA,
    "accept-language": "en-US,en;q=0.9",
    accept: "application/json, text/plain, */*",
  };
}

/** Trends 需要 NID cookie，直接从 explore 页带出来 */
async function bootstrapCookie(force = false): Promise<void> {
  if (!force && cookieHeader && Date.now() - cookieAt < 6 * 3600_000) return;
  const res = await fetch("https://trends.google.com/trends/explore?geo=US&hl=en-US", {
    headers: { ...baseHeaders(), accept: "text/html" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  const jar = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const picked = jar
    .map((c) => c.split(";")[0].trim())
    .filter((c) => /^(NID|CONSENT|__Secure|AEC)/.test(c));
  cookieHeader = picked.join("; ");
  cookieAt = Date.now();
  await res.text().catch(() => "");
}

/**
 * GET Trends 内部接口。429 抛 RateLimitError（由调用方熔断，不在这里死磕），
 * 5xx 做有限重试。
 */
export async function trendsGet(
  pathname: string,
  params: Record<string, string>,
): Promise<string> {
  const url = new URL(`https://trends.google.com${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    await bootstrapCookie(attempt > 0);
    try {
      const res = await fetch(url, {
        headers: { ...baseHeaders(), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429) {
        cookieHeader = ""; // 下次换一个 cookie
        throw new RateLimitError();
      }
      if (res.status >= 500) {
        lastError = new Error(`Trends ${pathname} ${res.status}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Trends ${pathname} ${res.status}: ${(await res.text()).slice(0, 160)}`);
      }
      return await res.text();
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      lastError = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Trends 请求失败");
}

/** 去掉 Google 的 XSSI 前缀 )]}', */
export function stripXssi(text: string): string {
  return text.replace(/^\)\]\}',?\s*/, "");
}