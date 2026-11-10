-- 0011 · 榜单数据入库
--
-- 12 张表，分两组：
--   内容组（6）：boards / board_items / board_item_details
--                board_listed / board_listed_details / board_item_evidence
--   治理组（6）：board_releases / board_release_items / board_changes
--                board_allowlist / enrich_reports / app_config
--
-- 核心设计：工作区（无版本）与已发布（带版本）物理分离。
-- 发布只往新 version 写，绝不动旧 version；回滚 = 改一个配置值。
-- 详见 docs/17-数据入库与后台化方案.md §4

-- ══════════════════════════════════════════════════════════
-- 内容组
-- ══════════════════════════════════════════════════════════

-- ① 榜单注册
CREATE TABLE IF NOT EXISTS boards (
  board      TEXT PRIMARY KEY,        -- tools/github/trends/models/opps/digest
  title      TEXT NOT NULL,
  policy     TEXT NOT NULL,           -- JSON：付费策略快照
  sort_mode  TEXT NOT NULL,           -- rank | score
  updated_at INTEGER NOT NULL         -- epoch ms
);

-- ② 工作区：采集与富化过程中的候选，没有版本概念
CREATE TABLE IF NOT EXISTS board_items (
  board      TEXT NOT NULL,
  item_key   TEXT NOT NULL,           -- domain / owner-repo / slug / model-id
  status     TEXT NOT NULL,           -- candidate | enriched | rejected
  name       TEXT NOT NULL,
  url        TEXT,
  cats       TEXT,                    -- JSON array
  judge      TEXT,                    -- JSON：采集期判定字段（约 200B）
  card       TEXT,                    -- JSON：富化后卡片字段（1–3KB）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (board, item_key)
);
CREATE INDEX IF NOT EXISTS idx_items_status ON board_items (board, status, updated_at DESC);

-- ③ 工作区详情：与卡片分开，列表查询永不触碰
--    SQLite 是行存，SELECT * 会连 detail 一起读，3000 行列表会拖动上百 MB
CREATE TABLE IF NOT EXISTS board_item_details (
  board    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  detail   TEXT NOT NULL,             -- JSON：10–40 KB
  PRIMARY KEY (board, item_key)
);

-- ④ 已发布快照：带 version，保留最近 3 期
CREATE TABLE IF NOT EXISTS board_listed (
  version  TEXT NOT NULL,             -- 2026-11-10T12:00
  board    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  rank     INTEGER NOT NULL,
  score    REAL NOT NULL,
  tier     TEXT NOT NULL,
  name     TEXT NOT NULL,
  url      TEXT,
  cats     TEXT,
  card     TEXT,
  PRIMARY KEY (version, board, item_key)
);
-- 查询永远带 version，索引必须以 version 打头，否则退化为全表扫描
CREATE INDEX IF NOT EXISTS idx_listed_rank ON board_listed (version, board, rank);

CREATE TABLE IF NOT EXISTS board_listed_details (
  version  TEXT NOT NULL,
  board    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  detail   TEXT NOT NULL,
  PRIMARY KEY (version, board, item_key)
);

-- ⑤ 判决证据：只有后台读，与渲染路径物理隔离
CREATE TABLE IF NOT EXISTS board_item_evidence (
  board     TEXT NOT NULL,
  item_key  TEXT NOT NULL,
  verdict   TEXT,                     -- JSON：判定结论
  gaps      TEXT,                     -- JSON：字段缺失清单
  raw_ref   TEXT,                     -- R2 路径，如 raw/github/2026-11-10.json
  PRIMARY KEY (board, item_key)
);

-- ══════════════════════════════════════════════════════════
-- 治理组
-- ══════════════════════════════════════════════════════════

-- ⑥ 发布记录：一期一行
CREATE TABLE IF NOT EXISTS board_releases (
  version     TEXT PRIMARY KEY,
  board_scope TEXT NOT NULL,          -- JSON：本次发布了哪些榜
  stats       TEXT NOT NULL,          -- JSON：各榜条数
  allowlist   TEXT NOT NULL,          -- JSON：这期免费名单快照
  actor       TEXT NOT NULL,
  applied     INTEGER NOT NULL DEFAULT 0,  -- 1 = 已切指针生效
  created_at  INTEGER NOT NULL
);

-- ⑦ 永久名单：只存 key+rank+name，60B/条，永不删除
--    存 name 才能回答「上期第 37 名叫什么」——工作区的名称可能已改，只有快照能还原
CREATE TABLE IF NOT EXISTS board_release_items (
  version  TEXT NOT NULL,
  board    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  rank     INTEGER NOT NULL,
  tier     TEXT,
  name     TEXT NOT NULL,
  PRIMARY KEY (version, board, item_key)
);
CREATE INDEX IF NOT EXISTS idx_release_items_board ON board_release_items (board, version, rank);

-- ⑧ 变更审计：替代 git diff
CREATE TABLE IF NOT EXISTS board_changes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    TEXT NOT NULL,
  board      TEXT NOT NULL,
  item_key   TEXT NOT NULL,
  action     TEXT NOT NULL,           -- add | update | drop | restore
  diff       TEXT,                    -- {"name":{"from":"x","to":"y"}}
  applied    INTEGER NOT NULL DEFAULT 0,
  actor      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_version ON board_changes (version, board);

-- ⑨ 免费名单：当前生效值。后台增删条目即时生效，不需要重新发布
CREATE TABLE IF NOT EXISTS board_allowlist (
  board    TEXT NOT NULL,
  item_key TEXT NOT NULL,
  note     TEXT,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (board, item_key)
);

-- ⑩ 富化质量报告
CREATE TABLE IF NOT EXISTS enrich_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     TEXT NOT NULL,
  board      TEXT NOT NULL,
  scope      TEXT NOT NULL,           -- {"selected":500,"enriched":487}
  report     TEXT NOT NULL,           -- {"readme":{"empty":12,"total":487}}
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_enrich_reports_board ON enrich_reports (board, created_at DESC);

-- ⑪ 全局配置
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  val        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ══════════════════════════════════════════════════════════
-- 初始配置：全部指向 file，迁移期零行为变化
-- ══════════════════════════════════════════════════════════
INSERT OR IGNORE INTO app_config (key, val, updated_at) VALUES
  ('paywall.enabled',         'false', (unixepoch() * 1000)),
  ('data_source.tools',       'file',  (unixepoch() * 1000)),
  ('data_source.github',      'file',  (unixepoch() * 1000)),
  ('data_source.trends',      'file',  (unixepoch() * 1000)),
  ('data_source.models',      'file',  (unixepoch() * 1000)),
  ('data_source.opps',        'file',  (unixepoch() * 1000)),
  ('data_source.digest',      'file',  (unixepoch() * 1000)),
  ('config.current_version',  '',      (unixepoch() * 1000));

-- 六个榜的注册信息
INSERT OR IGNORE INTO boards (board, title, policy, sort_mode, updated_at) VALUES
  ('tools',  'AI 工具榜',    '{"mode":"paywall"}', 'rank',  (unixepoch() * 1000)),
  ('github', 'GitHub 热门',  '{"mode":"paywall"}', 'rank',  (unixepoch() * 1000)),
  ('trends', '趋势词',       '{"mode":"paywall"}', 'score', (unixepoch() * 1000)),
  ('models', 'AI 模型',      '{"mode":"public"}',  'score', (unixepoch() * 1000)),
  ('opps',   '机会榜',       '{"mode":"public"}',  'rank',  (unixepoch() * 1000)),
  ('digest', '每日情报',     '{"mode":"public"}',  'rank',  (unixepoch() * 1000));

-- ══════════════════════════════════════════════════════════
-- paywall_clicks 放开匿名
-- ══════════════════════════════════════════════════════════
-- 原口径：user_id NOT NULL，匿名点击不入库。
-- 但详情页锁定页的访问者绝大多数未登录，按原口径会丢掉 90% 以上的转化意图。
-- SQLite 无法直接改 NOT NULL，只能重建表。

CREATE TABLE IF NOT EXISTS paywall_clicks_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,                   -- 可空：NULL = 匿名点击
  button_key  TEXT NOT NULL,
  page        TEXT,
  created_at  INTEGER NOT NULL,
  ip_hash     TEXT                    -- sha256(IP)，仅用于归因与排查
);

INSERT INTO paywall_clicks_new (id, user_id, button_key, page, created_at, ip_hash)
SELECT id, user_id, button_key, page, created_at, ip_hash FROM paywall_clicks;

DROP TABLE paywall_clicks;

ALTER TABLE paywall_clicks_new RENAME TO paywall_clicks;

CREATE INDEX IF NOT EXISTS idx_paywall_clicks_created ON paywall_clicks (created_at);
CREATE INDEX IF NOT EXISTS idx_paywall_clicks_button ON paywall_clicks (button_key, created_at);
CREATE INDEX IF NOT EXISTS idx_paywall_clicks_user ON paywall_clicks (user_id, created_at);