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
  /*
   * 精度只到月/日的值不能当时间戳解析：
   * `Date.parse("2026-11")` 是 11-01T00:00:00Z，东八区渲染成「11-01 08:00」，
   * 看上去像 11 月 1 日早上分析的，其实原始数据只到「哪个月」。
   * 这类值原样显示，别用假时分把自己骗了。
   */
  if (typeof ms === "string") {
    const s = ms.trim();
    if (/^\d{4}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
  }
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `request_failed_${res.status}`);
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
    const detail = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      message?: string;
    };
    // message 是给人看的中文说明（如「已有富化任务在跑」），优先于 error 代码
    throw new Error(detail.detail ?? detail.message ?? detail.error ?? `request_failed_${res.status}`);
  }
  return (await res.json()) as T;
}