/**
 * 后台各页签共用的工具函数：取元素、转义、时间/数字格式化、防抖、请求封装。
 *
 * 抽出来只为让「工具榜」「趋势榜」两个面板行为一致：
 * 401 都会踢回登录页，CSRF 头都带同一个标记，数字/时间的显示口径也相同。
 */

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T;

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const p2 = (n: number) => String(n).padStart(2, "0");

export function fmtTime(ms: number | string | null | undefined): string {
  const v = typeof ms === "string" ? Date.parse(ms) : ms;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  const d = new Date(v);
  return `${d.getMonth() + 1}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

export function debounce(fn: () => void, delay = 300): () => void {
  let timer: number | undefined;
  return () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, delay);
  };
}

/* --------------------------------- 请求 --------------------------------- */

const CSRF_HEADERS = {
  "content-type": "application/json",
  "x-requested-with": "horizons-admin",
};

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api/admin${path}`, { credentials: "same-origin", cache: "no-store" });
  if (res.status === 401) {
    location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request_failed_${res.status}`);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: CSRF_HEADERS,
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    location.reload();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(detail.detail ?? detail.error ?? `request_failed_${res.status}`);
  }
  return (await res.json()) as T;
}