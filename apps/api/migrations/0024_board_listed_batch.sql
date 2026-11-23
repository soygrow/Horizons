-- 0024 · 线上快照的批次提成列，批次下拉不再逐行解析 card
--
-- 背景：`GET /admin/opps/batches` 原来是
--   SELECT json_extract(card,'$.batch'), COUNT(*) FROM board_listed
--    WHERE version=? AND board=? GROUP BY batch
-- 范围虽然被 version+board 卡住了，但每行都要把 card（几 KB）读出来解析，
-- 再丢进临时 B 树分组。机会榜当前一期 5 行还能忍，可这个路由是六个榜共用的
-- —— 模型榜 366 行、GitHub 榜 1500 行一旦调它就是 0021/0022 修过的老问题复发。
--
-- 做法与 0022 的 data_day 一致：提成列，写入时由发布脚本填，
-- (version, board, batch) 索引让 GROUP BY 直接沿索引有序扫，不回表、不排序。
--
-- 回填只做 opps（别的榜卡片里没有 batch）。
-- 这是本迁移唯一一次全表范围的扫描：一次性，之后都是索引读。

ALTER TABLE board_listed ADD COLUMN batch TEXT;

UPDATE board_listed
   SET batch = json_extract(card, '$.batch')
 WHERE board = 'opps'
   AND batch IS NULL
   AND json_extract(card, '$.batch') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_listed_batch
  ON board_listed (version, board, batch);