/**
 * Paddle.js 的公共加载逻辑：账户页与定价页共用同一份实现。
 *
 * 服务端建 transaction 后下发 client token，前端只用 transactionId 拉起 overlay，
 * price_id 始终不落到浏览器。Paddle.js 只加载、初始化一次；重复下单时
 * 通过 onCompletedRef 替换回调，避免闭包指向上一笔 transaction。
 */

/** sandbox 与 production 是两套 CDN，client token 也不通用 */
export const PADDLE_SDK_URL = {
  sandbox: "https://sandbox-cdn.paddle.com/paddle/v2/paddle.js",
  production: "https://cdn.paddle.com/paddle/v2/paddle.js",
} as const;

export type PaddleEnv = keyof typeof PADDLE_SDK_URL;

export interface PaddleJs {
  Environment: { set: (env: string) => void };
  Initialize: (opts: {
    token: string;
    eventCallback?: (event: { name: string }) => void;
  }) => void;
  Checkout: {
    open: (opts: { transactionId: string; settings?: Record<string, unknown> }) => void;
  };
}

let paddleLoading: Promise<boolean> | null = null;
let onCompletedRef: (() => void) | null = null;
let onClosedRef: (() => void) | null = null;

export function getPaddle(): PaddleJs | undefined {
  return (window as unknown as { Paddle?: PaddleJs }).Paddle;
}

/**
 * 按需加载 Paddle.js，返回 false 时调用方退化为跳转 checkout.url。
 * 每次调用都会替换回调，指向当前这笔 transaction：
 * - onCompleted：付完了
 * - onClosed：用户自己关掉了 overlay（还没付），用于给「继续支付」入口
 */
export function loadPaddleJs(
  env: PaddleEnv,
  token: string,
  onCompleted: () => void,
  onClosed?: () => void,
): Promise<boolean> {
  onCompletedRef = onCompleted;
  onClosedRef = onClosed ?? null;
  if (paddleLoading) return paddleLoading;

  paddleLoading = new Promise<boolean>((resolve) => {
    const script = document.createElement("script");
    script.src = PADDLE_SDK_URL[env];
    script.async = true;
    script.onload = () => {
      try {
        const paddle = getPaddle();
        if (!paddle) {
          resolve(false);
          return;
        }
        if (env === "sandbox") paddle.Environment.set("sandbox");
        paddle.Initialize({
          token,
          eventCallback: (event) => {
            if (event.name === "checkout.completed") onCompletedRef?.();
            // 付完单后 overlay 关闭也会发 closed，调用方用 completed 标志过滤
            else if (event.name === "checkout.closed") onClosedRef?.();
          },
        });
        resolve(true);
      } catch {
        resolve(false);
      }
    };
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });

  return paddleLoading;
}