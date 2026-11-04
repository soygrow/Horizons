-- Paddle 支付：一次性付款 + 到期时间戳权益（见 docs/14-支付与订阅接入方案.md）
-- 权益只有一个字段：pro_until。NULL 或 <= now 视为免费。

ALTER TABLE users ADD COLUMN pro_until INTEGER;
ALTER TABLE users ADD COLUMN paddle_customer_id TEXT;

-- 订单：provider_order_id（Paddle transaction id）为幂等键
CREATE TABLE IF NOT EXISTS orders (
  id                TEXT PRIMARY KEY,        -- 随机 UUID
  user_id           TEXT NOT NULL,           -- users.id
  provider          TEXT NOT NULL,           -- paddle | manual
  provider_order_id TEXT NOT NULL,           -- txn_... 幂等键
  plan              TEXT NOT NULL,           -- month | year
  amount_cents      INTEGER NOT NULL,        -- 下单/成交时快照（最小货币单位）
  currency          TEXT NOT NULL,           -- USD / CNY ...
  status            TEXT NOT NULL,           -- paid | refunded | failed
  paid_at           INTEGER,                 -- Paddle 成交时间（epoch ms）
  granted_at        INTEGER,                 -- 权益发放完成时间；NULL = 已落库但还没加时长
  created_at        INTEGER NOT NULL,
  raw               TEXT                     -- webhook / API 原文，排查用
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_provider_order ON orders (provider_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id, created_at);