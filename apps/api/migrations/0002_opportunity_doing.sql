-- 「我在做」：每个用户对每条机会只有一条参与记录，留言可多条
CREATE TABLE IF NOT EXISTS opportunity_doers (
  id               TEXT PRIMARY KEY,              -- 随机 UUID
  opportunity_slug TEXT NOT NULL,                 -- 机会 slug（content/opportunities.json）
  user_id          TEXT NOT NULL,                 -- users.id
  status           TEXT NOT NULL,                 -- doing | shipped | paused | dropped
  created_at       INTEGER NOT NULL,              -- epoch ms
  updated_at       INTEGER NOT NULL
);

-- 同一用户同一条机会只能加入一次（重复点击 = 更新进展）
CREATE UNIQUE INDEX IF NOT EXISTS idx_doers_slug_user
  ON opportunity_doers (opportunity_slug, user_id);

CREATE INDEX IF NOT EXISTS idx_doers_slug_created
  ON opportunity_doers (opportunity_slug, created_at);

-- 留言：同一用户对同一条机会可以留多条
CREATE TABLE IF NOT EXISTS opportunity_updates (
  id               TEXT PRIMARY KEY,              -- 随机 UUID
  opportunity_slug TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  body             TEXT NOT NULL,                 -- 纯文本，已去标签，≤ 280 字
  status           TEXT NOT NULL,                 -- 留言时的进展状态
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_updates_slug_created
  ON opportunity_updates (opportunity_slug, created_at);

CREATE INDEX IF NOT EXISTS idx_updates_slug_user_created
  ON opportunity_updates (opportunity_slug, user_id, created_at);