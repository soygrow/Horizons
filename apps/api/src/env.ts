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
}
