-- 0012 · 榜单统计快照
--
-- 后台概览要显示「各榜在榜条数 + 更新时间」，但正式榜文件读不起：
-- github.json 59MB、trends.json 5MB，都超过 GitHub Contents API 单文件上限（1MB），
-- 也不该为了看几个数字去读仓库、拉分支、等缓存。
--
-- 发布链路本来就写 D1（board_listed / board_releases），所以在
-- syncBoardToD1 写库成功后顺手 upsert 一行这里是零额外成本。
--
-- 这张表是纯派生数据：随时可由 board_listed 当前版本重建，
-- 不参与任何渲染路径，只是后台的一个查询加速副本。

CREATE TABLE IF NOT EXISTS board_stats (
  board        TEXT PRIMARY KEY,   -- tools / github / trends / models / opps / digest
  total        INTEGER NOT NULL,   -- 当前生效版本的在榜条数
  updated_at   TEXT,               -- 该期版本号（ISO），NULL 表示未知
  generated_at INTEGER NOT NULL,   -- 本次写入的 epoch ms
  source       TEXT NOT NULL       -- 写入来源，排查时区分 publish / backfill
);