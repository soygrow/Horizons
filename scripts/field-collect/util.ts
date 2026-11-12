/**
 * 新采集脚本的通用工具：环境加载、参数、URL 归一化、带超时的请求。
 *
 * 全部自带实现，不 import 项目里现有的 scripts/*：这次要的是「按文档独立验一遍」，
 * 复用现有源的封装会把现有采集逻辑的取舍（比如某些字段被判定为不可用）带进来，
 * 那样测出来的就不是文档里的方案了。
 */
import fs from "node:fs";
import path from "node:path";
import { getDomain } from "tldts";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** tsx 不会自动读 .env.local；CI 里这些变量来自 secrets，本地跑靠这个文件 */
export function loadEnvLocal(): void {
  const p = path.resolve(process.cwd(), ".env.local");
  let content: string;
  try {
    content = fs.readFileSync(p, "utf-8");
  } catch {
    return;
  }
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "") : "";
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NormalizedUrl {
  url: string;
  domain: string;
}

/**
 * 用户输入的地址 → 可请求的 URL + 主域名。
 *
 * 后台的输入框只收一个网站地址，人会填 `example.com`、`https://example.com/pricing`、
 * 甚至 `www.example.com/`，这里统一成 https 绝对地址，域名取可注册域（去掉 www 和子域），
 * 后面所有第三方接口（Wayback / Similarweb / GitHub）都只需要主域名。
 */
export function normalizeUrl(input: string): NormalizedUrl {
  const raw = input.trim();
  if (!raw) throw new Error("缺少网站地址");
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`无法解析的地址：${input}`);
  }
  if (!u.hostname.includes(".")) throw new Error(`地址里没有有效域名：${input}`);
  const domain = (getDomain(u.hostname) ?? u.hostname).toLowerCase().replace(/^www\./, "");
  return { url: u.toString(), domain };
}

export interface HttpResult {
  ok: boolean;
  status: number;
  text: string;
  error?: string;
}

/**
 * 带超时的 GET。
 *
 * 失败不抛异常，而是回一个 error —— 这些第三方接口是「尽力而为」的，
 * 某个源挂了不该让整次采集中断，但必须把失败原因写进结果，否则人看到字段为空
 * 会以为「这个站没有这个数据」。
 */
export async function httpGet(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number } = {},
): Promise<HttpResult> {
  const { timeoutMs = 25_000, headers = {}, maxBytes = 4 * 1024 * 1024 } = opts;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf.slice(0, maxBytes)).toString("utf-8");
    return { ok: res.ok, status: res.status, text };
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return { ok: false, status: 0, text: "", error: msg };
  }
}

export async function getJson<T>(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<{ data: T | null; status: number; error?: string }> {
  const r = await httpGet(url, opts);
  if (!r.ok && !r.text) return { data: null, status: r.status, error: r.error ?? `HTTP ${r.status}` };
  try {
    return { data: JSON.parse(r.text) as T, status: r.status };
  } catch {
    return { data: null, status: r.status, error: `非 JSON 响应（HTTP ${r.status}）` };
  }
}

/** 秒 → 「3分12秒」这类可读时长 */
export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}分${String(s).padStart(2, "0")}秒` : `${s}秒`;
}

/** 0.5323 → 「53.2%」；已经是百分数（>1）则原样保留一位小数 */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  const pct = Math.abs(v) <= 1 ? v * 100 : v;
  return `${Math.round(pct * 10) / 10}%`;
}

/** 大数字 → 1.2M / 340K */
export function fmtBig(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("zh-CN");
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}