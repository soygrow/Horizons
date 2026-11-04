// 后端环境类型：D1 绑定 + Secret（对应 wrangler.jsonc 与 .dev.vars）

export interface Env {
  /** D1 数据库（users 表） */
  DB: D1Database;
  /** 前端站点地址，用于登录回调后跳转，如 https://horizons.tools */
  APP_URL: string;
  /** 会话 JWT 签名密钥（256-bit 随机） */
  SESSION_SECRET: string;
  /** Google OAuth 客户端凭据 */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Google OAuth 回调地址，如 https://horizons.tools/api/auth/google/callback */
  GOOGLE_REDIRECT_URI: string;
  /** Product Hunt OAuth 客户端凭据（换 token 用） */
  PH_API_KEY: string;
  PH_API_SECRET: string;

  /** Paddle 环境：sandbox（默认）| production */
  PADDLE_ENV?: "sandbox" | "production";
  /** Paddle API key（sandbox 前缀 pdl_sdbx_，live 前缀 pdl_live_） */
  PADDLE_API_KEY: string;
  /** Webhook 通知目标的 secret（pdl_ntfset_...），注意不是 API key */
  PADDLE_WEBHOOK_SECRET: string;
  /**
   * Paddle.js 的 client-side token（test_... / live_...）。
   * 配了就用 overlay 结算（不离开站点），没配则退化为跳转 checkout.url。
   * 这个 token 本来就是给浏览器用的，可以下发到前端。
   */
  PADDLE_CLIENT_TOKEN?: string;

  /**
   * 订阅价格 ID（pri_...，周期型），按币种分开：
   * - USD 面向海外客户（卡 / PayPal / Apple Pay / Google Pay）
   * - CNY 面向中国客户（支付宝要求「CNY 定价商品 + 中国地址」才会在结算页出现）
   * CNY 两个可以不配，此时中国客户会看到美元价格、并只能用卡/PayPal。
   */
  PADDLE_PRICE_MONTH_USD: string;
  PADDLE_PRICE_YEAR_USD: string;
  PADDLE_PRICE_MONTH_CNY?: string;
  PADDLE_PRICE_YEAR_CNY?: string;

  /**
   * 一次性（非续费）价格 ID，必须是非循环 price：
   * 用户付一次得到 30 / 365 天权益，不产生订阅、不会自动扣款。
   * 全部可选；没配就只在页面展示「自动续费」，下单时自动落回订阅价。
   */
  PADDLE_PRICE_MONTH_ONCE_USD?: string;
  PADDLE_PRICE_YEAR_ONCE_USD?: string;
  PADDLE_PRICE_MONTH_ONCE_CNY?: string;
  PADDLE_PRICE_YEAR_ONCE_CNY?: string;
}
