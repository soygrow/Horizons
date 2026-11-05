-- 后台管理（仅站主本人使用）：会话表 + 登录失败限流
--
-- 会话：明文 token 只存在于浏览器的 HttpOnly Cookie 里，库里只存 sha256(token)，
-- 即使数据库被读走也无法反推出可用的登录凭据；同时支持「立即下线」（删行即失效）。
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,      -- sha256(token) 的小写十六进制
  created_at INTEGER NOT NULL,      -- epoch ms
  expires_at INTEGER NOT NULL,      -- epoch ms
  ip_hash    TEXT,                  -- sha256(IP)，不存原始 IP
  user_agent TEXT                   -- 截断后的 UA，仅用于自查异常登录
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions (expires_at);

-- 登录失败限流：按 IP 哈希计数，15 分钟窗口内失败 5 次即封锁 15 分钟
CREATE TABLE IF NOT EXISTS admin_login_limits (
  ip_hash       TEXT PRIMARY KEY,   -- sha256(IP)
  fails         INTEGER NOT NULL DEFAULT 0,
  window_start  INTEGER NOT NULL,   -- 当前窗口起点（epoch ms）
  blocked_until INTEGER             -- 封锁截止时间（epoch ms），NULL = 未封锁
);