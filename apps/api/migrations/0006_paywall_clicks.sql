-- 付费按钮点击埋点（只记已登录用户）
--
-- 口径：匿名点击不计数。定价页点按钮若未登录会先跳 Google 登录，登录回来再点才算；
-- 因此这里没有「设备归因」概念，一行 = 一次已登录用户的购买意图。
-- 支付结果不在这张表（看 orders），这里只回答「谁想买、点的哪个按钮」。
CREATE TABLE IF NOT EXISTS paywall_clicks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,        -- users.id，匿名点击不入库
  button_key  TEXT NOT NULL,        -- 按钮标识，白名单见 apps/api/src/lib/paywall.ts
  page        TEXT,                 -- 点击所在页面 pathname
  created_at  INTEGER NOT NULL,     -- epoch ms
  ip_hash     TEXT                  -- sha256(IP)，只用于异常排查，不存原始 IP
);

CREATE INDEX IF NOT EXISTS idx_paywall_clicks_created ON paywall_clicks (created_at);
CREATE INDEX IF NOT EXISTS idx_paywall_clicks_button ON paywall_clicks (button_key, created_at);
CREATE INDEX IF NOT EXISTS idx_paywall_clicks_user ON paywall_clicks (user_id, created_at);