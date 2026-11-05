/**
 * 付费按钮点击上报。
 *
 * 口径：只统计登录后的点击。匿名点击在定价页会先跳登录，那一次不上报；
 * 服务端同样只对已登录会话入库，两处一致（前端减少无效请求，服务端兜底）。
 *
 * key 必须与 apps/api/src/lib/paywall.ts 的白名单一致，服务端不认的 key 会被静默丢弃；
 * 所以新增/改名按钮时两边一起改，否则后台看到的是 0 次。
 *
 * 请求发出去就忘（keepalive 保证跳转/拉起 overlay 时也能送达），任何失败都不影响下单流程。
 */

export type PaywallButton =
  | "pricing.month.auto"
  | "pricing.month.once"
  | "pricing.year.auto"
  | "pricing.year.once";

export function trackPaywallClick(button: PaywallButton): void {
  try {
    void fetch("/api/track/paywall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      keepalive: true,
      body: JSON.stringify({ button, page: location.pathname }),
    }).catch(() => {});
  } catch {
    /* 埋点失败不阻塞下单 */
  }
}