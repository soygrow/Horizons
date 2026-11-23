-- 0023 · 候选池的批次提成列，别再靠 json_extract 过滤整个池子
--
-- 背景（/opps/staging 的真实开销）：
--   前端 20 秒轮询一次预览，每次调 listWorkspace 把 board='opps' 的整个
--   候选池读出来（含所有历史批次、含被拒绝行，card 是几 KB 的完整机会 JSON），
--   再在 JS 里 filter 出本批次的 5 条；batchCounts 又各扫一遍。
--   board_items 只 upsert 不删除，池子逐周变大，轮询再乘 30 次
--   → 一轮生成就是上万行读，且大部分和这一批无关。
--
-- 做法：batch 提成真列 + 复合索引。
--   写入时由 syncCandidates 从 card.batch 填（其余五个榜的 card 没有这个字段，留 NULL）。
--   查询 (board, batch) 直接落在一个 5 条的范围里，连 card 都不用解析。
--
--   索引尾列带 updated_at DESC：listWorkspace 的 ORDER BY updated_at DESC
--   因此不需要临时 B 树。
--
-- 回填只做 opps：别的榜没有 batch 概念，不值得为它们空扫一遍全表。
-- 这也是唯一一次「上万行读」—— 迁移期一次性，之后都是索引点查。

ALTER TABLE board_items ADD COLUMN batch TEXT;

UPDATE board_items
   SET batch = json_extract(card, '$.batch')
 WHERE board = 'opps'
   AND batch IS NULL
   AND json_extract(card, '$.batch') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_batch
  ON board_items (board, batch, updated_at DESC);