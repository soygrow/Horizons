-- 每日情报的历史期。
--
-- 站点仍按 content/digest/<date>.json 构建（/daily/[date] 走静态路径），
-- 但后台要看往期列表与全文，不该再为此每次去打 GitHub Contents API，
-- 所以整期 JSON 原样存一份。payload 是那期的完整文件内容。
CREATE TABLE IF NOT EXISTS digest_issues (
  date         TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,
  generated_at TEXT,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_digest_issues_date ON digest_issues (date DESC);