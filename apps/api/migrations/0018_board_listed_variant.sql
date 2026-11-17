-- 趋势词的别名（variantOf）必须随榜单一起入库
--
-- 背景：publish-trends.ts 的 toRows 按「别名不占名次」的规则过滤了 variantOf，
-- 所以 board_listed 里只有 367 个代表词，而 content/trends.json 有 487 条
-- （367 代表词 + 120 别名）。一旦榜单文件不再入库，这 120 个别名就没有来源，
-- 线上 /trends/<slug> 的别名页会直接 404。
--
-- 存法：别名也写一行，rank 继承代表词，variant_of 记代表词的 slug。
-- 读取时 `variant_of IS NULL` 才是真正占名次的主榜，别名单独取。
--
-- 其余五个榜没有别名概念，该列恒为 NULL，行为不变。
ALTER TABLE board_listed ADD COLUMN variant_of TEXT;

-- hydrate 要按「version + board」整段取，再按 variant_of 是否为空分组
CREATE INDEX IF NOT EXISTS idx_listed_variant ON board_listed (version, board, variant_of);