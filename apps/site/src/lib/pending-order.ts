/**
 * 「有一笔没付完的订单」的本地记录。
 *
 * 存 localStorage 而不是 sessionStorage：关标签页是最常见的支付中断方式，
 * 用 sessionStorage 等于兜底只覆盖「同一个标签里来回切页」这一种情况，几乎白做。
 *
 * 代价是会留下陈旧记录，所以带时间戳，超过 TTL 就当没有；
 * 真的续不上时服务端会返回失效（409），前端再清掉，能自愈。
 */

const KEY = "hzn_pending_txn";
const TTL_MS = 2 * 60 * 60 * 1000;

export interface PendingOrder {
  transactionId: string;
  /** 写入时刻，用来判断这笔是不是陈到不该再打扰用户 */
  at: number;
}

function parse(raw: string | null): PendingOrder | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingOrder>;
    if (typeof value.transactionId !== "string" || !value.transactionId) return null;
    return {
      transactionId: value.transactionId,
      at: typeof value.at === "number" ? value.at : 0,
    };
  } catch {
    return null;
  }
}

export function readPending(): PendingOrder | null {
  // 旧版本把纯字符串写在 sessionStorage 里，读到就迁过来，别让老用户丢兜底
  const legacy = sessionStorage.getItem(KEY);
  if (legacy && !localStorage.getItem(KEY)) {
    localStorage.setItem(KEY, JSON.stringify({ transactionId: legacy, at: Date.now() }));
    sessionStorage.removeItem(KEY);
  }

  const value = parse(localStorage.getItem(KEY));
  if (!value) return null;

  if (!value.at || Date.now() - value.at > TTL_MS) {
    localStorage.removeItem(KEY);
    return null;
  }

  return value;
}

export function writePending(transactionId: string): void {
  localStorage.setItem(KEY, JSON.stringify({ transactionId, at: Date.now() }));
}

export function clearPending(): void {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
}