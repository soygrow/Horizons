// Google Trends 非官方接口的最小客户端：cookie 引导 + 限流识别 + 退避
// 只用于本地采集脚本；不进入前端构建。
import { exitLabel, proxyGet, rotateProxy } from "../proxy";

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

/**
 * 出口本身不可用：explore 页被验证页挡住、拿不到任何 cookie。
 * 这种状态重试和退避都没意义（同一个 IP 只会继续被挡），只有换出口或者收工。
 */
export class ExitUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExitUnusableError";
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

const EXPLORE_PAGE = "https://trends.google.com/trends/explore?geo=US&hl=en-US";
/** Google 挡非浏览器流量时返回的验证页特征 */
const BLOCKED_PAGE = /unusual traffic|captcha|\/sorry\//i;

let warnedNoNid = false;

/**
 * 拉一次 explore 页面并接管 cookie。返回页面状态，让调用方能判断
 * 「出口被挡」（页面就不对）和「接口限流」（页面正常、api 429）的区别。
 */
async function fetchCookie(): Promise<{ status: number; nid: boolean; blocked: boolean }> {
  const res = await proxyGet(EXPLORE_PAGE, {
    headers: { ...baseHeaders(), accept: "text/html" },
    timeoutMs: 30_000,
  });
  const jar = res.setCookies();
  const html = await res.text().catch(() => "");
  const picked = jar
    .map((c) => c.split(";")[0].trim())
    .filter((c) => /^(NID|CONSENT|__Secure|AEC)/.test(c));
  cookieHeader = picked.join("; ");
  cookieAt = Date.now();
  return {
    status: res.status,
    nid: picked.some((c) => c.startsWith("NID=")),
    blocked: BLOCKED_PAGE.test(html.slice(0, 4000)),
  };
}

/** Trends 需要 NID cookie，直接从 explore 页带出来 */
async function bootstrapCookie(force = false): Promise<void> {
  if (!force && cookieHeader && Date.now() - cookieAt < 6 * 3600_000) return;
  const info = await fetchCookie();
  // 页面都打不开就没有会话可言，硬着头皮打 api 只是给封禁加码
  if (info.status !== 200 || info.blocked) {
    throw new ExitUnusableError(
      `explore 页${info.blocked ? "被验证页拦截" : `返回 ${info.status}`}（${exitLabel()}）`,
    );
  }
  if (!info.nid && !warnedNoNid) {
    warnedNoNid = true;
    console.warn(`[trends] 出口 ${exitLabel()} 没拿到 NID cookie，接口可能直接 429`);
  }
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
    try {
      await bootstrapCookie(attempt > 0);
      const res = await proxyGet(url, {
        headers: { ...baseHeaders(), ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        timeoutMs: 30_000,
      });
      if (res.status === 429) {
        cookieHeader = ""; // 下次换一个 cookie
        // 有多个出口就直接换 IP（cookie 与 IP 都会影响限流判定）
        const from = exitLabel();
        if (rotateProxy()) {
          throw new RateLimitError(`429 @ ${from}，已切换出口到 ${exitLabel()}`);
        }
        throw new RateLimitError(`429 @ ${from}`);
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
      const from = exitLabel();
      // 出口被挡：换出口是唯一出路，没有别的出口就直接把结论抛给上层
      if (e instanceof ExitUnusableError) {
        cookieHeader = "";
        if (rotateProxy()) {
          console.warn(`[trends] 出口 ${from} 不可用（${e.message}），切到 ${exitLabel()}`);
          continue;
        }
        throw e;
      }
      // 出口整体不可达（直连被墙 / 代理挂了）：先换出口再重试，别在这里耗死
      if (rotateProxy()) {
        console.warn(
          `[trends] 出口 ${from} 不可达（${e instanceof Error ? e.message.slice(0, 60) : e}），切到 ${exitLabel()}`,
        );
        continue;
      }
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Trends 请求失败");
}

/** 去掉 Google 的 XSSI 前缀 )]}', */
export function stripXssi(text: string): string {
  return text.replace(/^\)\]\}',?\s*/, "");
}

// ---------- 出口自检 ----------

export interface ExitProbe {
  exit: string;
  /** explore 页（HTML）状态码，0 表示根本没连上 */
  html: number;
  nid: boolean;
  /** /trends/api/explore 状态码，0 表示没走到这一步 */
  explore: number;
  /** 时间序列点数，>0 才算这个出口真能用 */
  points: number;
  ms: number;
  ok: boolean;
  note: string;
}

/** 自检关键词：常年有量，能出数据就说明接口是通的 */
const PROBE_KEYWORD = "chatgpt";

interface ProbeWidget {
  id: string;
  token: string;
  request: unknown;
}

function apiUrl(pathname: string, params: Record<string, string>): URL {
  const url = new URL(`https://trends.google.com${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

/**
 * 给单个出口做体检，顺序和真实采集完全一致：
 * explore 页拿 cookie → /trends/api/explore 换 widget → multiline 取序列。
 * 哪一步不通就停在哪一步，状态码原样带回（429 就是 429），
 * 这样「页面都打不开」和「页面正常但接口限流」能当场分清。
 */
export async function probeExit(geo = "US"): Promise<ExitProbe> {
  const started = Date.now();
  const out: ExitProbe = {
    exit: exitLabel(),
    html: 0,
    nid: false,
    explore: 0,
    points: 0,
    ms: 0,
    ok: false,
    note: "",
  };
  const done = (note: string, ok = false): ExitProbe => {
    out.note = note;
    out.ok = ok;
    out.ms = Date.now() - started;
    return out;
  };
  const headers = (): Record<string, string> => ({
    ...baseHeaders(),
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
  });

  try {
    cookieHeader = "";
    const info = await fetchCookie();
    out.html = info.status;
    out.nid = info.nid;
    if (info.status !== 200) return done(`explore 页 ${info.status}`);
    if (info.blocked) return done("explore 页被验证页拦截");

    const req = {
      comparisonItem: [{ keyword: PROBE_KEYWORD, geo, time: "today 3-m" }],
      category: 0,
      property: "",
    };
    const ex = await proxyGet(
      apiUrl("/trends/api/explore", { hl: "en-US", tz: "0", req: JSON.stringify(req) }),
      { headers: headers(), timeoutMs: 30_000 },
    );
    out.explore = ex.status;
    const exText = await ex.text();
    if (ex.status !== 200) return done(`explore 接口 ${ex.status}${ex.status === 429 ? "（限流）" : ""}`);

    const widgets = (JSON.parse(stripXssi(exText)) as { widgets?: ProbeWidget[] }).widgets ?? [];
    const ts = widgets.find((w) => w.id === "TIMESERIES");
    if (!ts) return done("explore 返回里没有 TIMESERIES");

    const ml = await proxyGet(
      apiUrl("/trends/api/widgetdata/multiline", {
        hl: "en-US",
        tz: "0",
        req: JSON.stringify(ts.request),
        token: ts.token,
      }),
      { headers: headers(), timeoutMs: 30_000 },
    );
    const mlText = await ml.text();
    if (ml.status !== 200) return done(`multiline ${ml.status}${ml.status === 429 ? "（限流）" : ""}`);

    const data = JSON.parse(stripXssi(mlText)) as { default?: { timelineData?: unknown[] } };
    out.points = data.default?.timelineData?.length ?? 0;
    return out.points > 0 ? done("可用", true) : done("序列为空（没量或被软限流）");
  } catch (e) {
    return done(e instanceof Error ? e.message.slice(0, 70) : String(e));
  }
}