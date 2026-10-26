-- 用户表：Google 登录
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,        -- 随机 UUID
  google_sub TEXT UNIQUE NOT NULL,    -- Google 唯一标识
  email      TEXT NOT NULL,
  name       TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,        -- epoch ms
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
