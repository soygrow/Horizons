-- 工具收藏：账号级、跨设备。
-- 未登录阶段前端暂存 localStorage，登录后由前端 merge 上来（幂等），
-- 因此这里只存「最终态」，不保留本地痕迹。
CREATE TABLE IF NOT EXISTS tool_favorites (
  id         TEXT PRIMARY KEY,        -- 随机 UUID
  user_id    TEXT NOT NULL,           -- users.id
  domain     TEXT NOT NULL,           -- 工具域名（与 content/aitools.json 对齐）
  created_at INTEGER NOT NULL         -- epoch ms，收藏时间
);

-- 同一用户同一工具只收藏一次（重复收藏 = 无操作）
CREATE UNIQUE INDEX IF NOT EXISTS idx_favorites_user_domain
  ON tool_favorites (user_id, domain);

-- 账户页按收藏时间倒序读取
CREATE INDEX IF NOT EXISTS idx_favorites_user_created
  ON tool_favorites (user_id, created_at);