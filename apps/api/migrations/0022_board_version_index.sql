-- 0022 · 后台反复查的三样东西物化成表/列，别再扫整张 board_listed
--
-- 问题：`SELECT version, COUNT(*) ... WHERE board = ?` 走不了索引
--      （主键 (version, board, item_key) 与 idx_listed_rank 的前导列都是 version），
--      每次都是全表扫 + 每行 json_extract(card)，10k 行一行不落。
--      而版本下拉要的「每版多少条」发布时就知道，存在 board_releases.stats 里。
--
-- 做法：
--   1. `data_day` 把「这一行是哪天采的」提成真列 + 覆盖索引，按天分组不再读 card
--   2. `board_version_index` 存每版每榜的条数与数据截止日，版本下拉 O(版本数)
--
-- 两样都由发布脚本维护；历史数据用 `scripts/admin/backfill-query-index.ts` 回填。

-- ① 行级数据日：与 versions.ts 的 DATA_AT_ROW_EXPR 同序
--    （last_crawled_at → card.lastCrawledAt → card.dataAt → card.updatedAt → card.lastSeenAt）
ALTER TABLE board_listed ADD COLUMN data_day TEXT;

-- 按天分组只读索引不回表：1500 行的榜从「索引+回表 3000 行」降到 1500 行
CREATE INDEX IF NOT EXISTS idx_listed_day ON board_listed (version, board, data_day);

-- ② 版本下拉的数据源：一行 = 一个榜的一期
--    total  发布时统计好的条数（board_releases.stats 的对应项）
--    data_at 该期该榜的数据截止日 = MAX(data_day)，没有行级日期时回落 null
CREATE TABLE IF NOT EXISTS board_version_index (
  board      TEXT NOT NULL,
  version    TEXT NOT NULL,
  total      INTEGER NOT NULL,
  data_at    TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board, version)
);