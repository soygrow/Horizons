/**
 * A3 站点存活探测（免费，纯 HTTP）。
 *
 * 采集链路（fetch-staging.ts）和存量重判（audit-existing.ts）共用这一份，
 * 避免两处各写一套超时/停放页规则导致判定口径漂移。
 *
 * 判定语义（与 verdict.ts 的 AliveState 对齐）：
 *   true  = 200 且有 title、不像停放页
 *   false = 明确不可用（非 2xx / 停放页 / 无 title）
 *   null  = 探测失败（超时、TLS、DNS），不做断言，不因它拒绝收录
 */
import type { AITool } from "@horizons/shared";

/** 停放页 / 建设中 / 待售 的典型文案，命中即判为不可用 */
const PARKING_PATTERNS = [
  "domain is for sale",
  "buy this domain",
  "this domain is parked",
  "domain parking",
  "coming soon",
  "under construction",
  "website is being built",
  "域名出售",
  "本域名可",
  "网站建设中",
  "即将上线",
  "敬请期待",
];

const PROBE_TIMEOUT_MS = 12_000;
const PROBE_CONCURRENCY = 8;
const PROBE_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export async function probeAlive(url: string): Promise<boolean | null> {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": PROBE_UA, accept: "text/html,*/*" },
    });
    if (!res.ok) return false;
    const html = (await res.text()).slice(0, 30_000);
    const lower = html.toLowerCase();
    if (PARKING_PATTERNS.some((p) => lower.includes(p))) return false;
    const title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1]?.trim();
    return Boolean(title);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 并发探测一批条目，返回 domain → AliveState */
export async function probeAll(items: AITool[]): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  for (let i = 0; i < items.length; i += PROBE_CONCURRENCY) {
    const chunk = items.slice(i, i + PROBE_CONCURRENCY);
    const results = await Promise.all(chunk.map((t) => probeAlive(t.url)));
    chunk.forEach((t, idx) => out.set(t.domain, results[idx]));
    if (items.length > PROBE_CONCURRENCY) {
      console.log(`[probe] ${Math.min(i + PROBE_CONCURRENCY, items.length)}/${items.length}`);
    }
  }
  return out;
}