/**
 * 付费按钮白名单：服务端只认这些 key，前端传别的直接丢弃。
 *
 * 前端 map 在 apps/site/src/lib/paywall-track.ts，两边改的时候要一起改：
 * key 是统计口径，改了等于把历史数据切成两半，所以只在「真的换了按钮」时才动。
 */
export const PAYWALL_BUTTONS = [
  { key: "pricing.month.auto", label: "月付 · 自动续费" },
  { key: "pricing.month.once", label: "月付 · 一次性" },
  { key: "pricing.year.auto", label: "年付 · 自动续费" },
  { key: "pricing.year.once", label: "年付 · 一次性" },
] as const;

export type PaywallButtonKey = (typeof PAYWALL_BUTTONS)[number]["key"];

const LABELS = new Map<string, string>(PAYWALL_BUTTONS.map((b) => [b.key, b.label]));

export function isPaywallButtonKey(key: string): key is PaywallButtonKey {
  return LABELS.has(key);
}

/** 未知 key 原样返回，保证历史数据在按钮被下线后仍然显示得出来 */
export function paywallButtonLabel(key: string): string {
  return LABELS.get(key) ?? key;
}