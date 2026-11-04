-- 订阅（自动续费）：一个用户最多一条有效订阅，见 docs/15-Paddle订阅落地方案.md
-- users.pro_until 保留，作为「权益到期时间」的物化缓存，前端与权限判定只读它；
-- 真正的真相在 Paddle（subscription.current_billing_period.ends_at），由 webhook 同步下来。

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,       -- Paddle 订阅 ID（sub_...）
  user_id            TEXT NOT NULL,          -- users.id
  customer_id        TEXT,                   -- ctm_...
  price_id           TEXT NOT NULL,          -- pri_...
  plan               TEXT NOT NULL,          -- month | year
  status             TEXT NOT NULL,          -- active | trialing | past_due | paused | canceled
  currency           TEXT NOT NULL,          -- USD / CNY
  amount_cents       INTEGER NOT NULL,       -- 每期金额快照（最小货币单位）
  current_period_end INTEGER,                -- epoch ms；paused/canceled 时为 NULL
  next_billed_at     INTEGER,                -- epoch ms；取消或暂停后为 NULL
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  canceled_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  raw                TEXT                    -- 最近一次 webhook 原文，排查用
);

-- 一个用户只保留一条订阅记录（续订沿用同一条，不新建）
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions (status);

-- 订单新增订阅关联：续费产生的交易也记在 orders 里，便于对账
ALTER TABLE orders ADD COLUMN subscription_id TEXT;