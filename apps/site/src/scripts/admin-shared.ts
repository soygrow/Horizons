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

/**
 * 年月日时分秒（本地时区）。
 *
 * 后台列表里的「更新时间」要精确到秒：判断一批条目是不是同一轮采的、
 * 定点重采有没有真的落地，光看「11-18」看不出来。
 * 精度只到日的值（趋势榜的 lastSeenAt 就是）原样返回，
 * 不补一个 00:00:00 假装有秒。
 */
export function fmtStamp(ms: number | string | null | undefined): string {
  if (typeof ms === "string") {
    const s = ms.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  }
  const v = typeof ms === "string" ? Date.parse(ms) : ms;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  const d = new Date(v);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN");
}

/* --------------------------------- 版本 --------------------------------- */

/** 库里的一个发布版本（version 是 UTC 秒级时间串）+ 该榜的条数 */
export interface VersionOption {
  version: string;
  count: number;
}

/**
 * 版本串 → 毫秒。
 *
 * board_listed.version 形如 `2026-11-19T01:20:17`，是 UTC，但**不带 Z**。
 * 带时间不带时区的字符串按 ECMAScript 规则是「本地时间」，
 * 直接 Date.parse 会当成东八区 01:20，实际是东八区 09:20 —— 差 8 小时，
 * 跨零点的版本连日期都会错一天。所以这里按 UTC 补 Z。
 */
function versionMs(version: string): number | null {
  const s = version.trim();
  if (!s) return null;
  const ms = Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** 版本号：发布时刻的本地日期，`2026-11-19T01:20:17Z` → `20261119` */
export function versionLabel(version: string | null | undefined): string {
  const ms = version ? versionMs(version) : null;
  if (ms === null) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
}

/** 版本对应的发布时间（年月日时分秒，本地） */
export function versionAt(version: string | null | undefined): string {
  const ms = version ? versionMs(version) : null;
  return ms === null ? "—" : fmtStamp(ms);
}

/**
 * 历史版本 → 每天留一条，给后台的版本下拉用。
 *
 * 同一天可能发过好几版（改数据重发），而版本号只到「日」：
 * 中间那几版点进去看到的是半成品，列出来只会让下拉更长、更难选。
 * 所以按本地日期分组只留当天最后一版；下拉的 value 仍然是完整的
 * 版本串 —— 版本号是给人看的，查询还得用真实版本。
 */
export function dayVersions(
  list: VersionOption[] | null | undefined,
  prefer?: string | null,
): Array<VersionOption & { label: string }> {
  const byDay = new Map<string, VersionOption & { label: string }>();
  for (const v of list ?? []) {
    const label = versionLabel(v.version);
    if (label === "—") continue;
    const prev = byDay.get(label);
    if (!prev) {
      byDay.set(label, { ...v, label });
      continue;
    }
    /*
     * 正在看的那一版优先留下：回滚之后当前版本可能是当天更早的一版，
     * 一律「取当天最后一版」会把它合掉，下拉就会显示成空白。
     */
    if (v.version === prefer) byDay.set(label, { ...v, label });
    else if (prev.version !== prefer && prev.version < v.version) byDay.set(label, { ...v, label });
  }
  return [...byDay.values()].sort((a, b) => (a.version < b.version ? 1 : -1));
}

/**
 * 填充版本下拉：倒序，第一项是最近一版。
 *
 * 文案写成「20261119 · 1,500 条」—— 只看日期挑不出该看哪版，
 * 条数才能一眼看出哪版是完整的。完整发布时间放在 title 里。
 */
export function fillVersionSelect(
  id: string,
  versions: VersionOption[] | null | undefined,
  selected?: string | null,
): void {
  const sel = $(id) as HTMLSelectElement | null;
  if (!sel) return;
  const opts = dayVersions(versions, selected);
  if (opts.length === 0) {
    /*
     * 收起来而不是留个「暂无版本」：站点和 Worker 是分开部署的，
     * 新页面配旧 Worker 时 versions 还没返回，空下拉会让人以为数据没了。
     */
    sel.hidden = true;
    sel.innerHTML = "";
    return;
  }
  sel.hidden = false;
  sel.disabled = false;
  sel.innerHTML = opts
    .map(
      (o) =>
        `<option value="${esc(o.version)}" title="发布 ${esc(versionAt(o.version))}">${o.label} · ${fmtNum(o.count)} 条</option>`,
    )
    .join("");
  const want = selected && opts.some((o) => o.version === selected) ? selected : (opts[0]?.version ?? "");
  sel.value = want;
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