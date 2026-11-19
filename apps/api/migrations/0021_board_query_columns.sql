-- 0021 · 让列表查询不再解析 JSON 大字段
--
-- 背景（今天 D1 的真实开销）：
--   1. 后台 /admin/github/listed 一次查 1500 行，每行对 card 做 7 次 json_extract。
--      card 是 1–3KB 的 JSON，1500 行就是 2–4MB —— 而调用方只要 7 个数字。
--   2. 增量发布判断「详情有没有变」靠 `length(CAST(detail AS BLOB))`，
--      为此要把整版 detail（github 瘦身前 59MB）读出来。
--
-- board_listed 是「列表 + 卡片」表，本来就是为读得多、读得快存在的；
-- 把被查询的标量从 JSON 里提成列，是最直接的解法（写一份，读无数次）。
-- 列可空：其余五个榜没有这些字段，不值得为它们编默认值。
--
-- bytes 两处：
--   board_listed_details.bytes  写库时算好，比对差异不再读 detail 正文
--   board_stats.bytes           整榜体积，省掉 SUM(LENGTH(detail)) 全表扫描

ALTER TABLE board_listed ADD COLUMN stars INTEGER;
ALTER TABLE board_listed ADD COLUMN forks INTEGER;
ALTER TABLE board_listed ADD COLUMN language TEXT;
ALTER TABLE board_listed ADD COLUMN description TEXT;
ALTER TABLE board_listed ADD COLUMN pushed_at TEXT;
ALTER TABLE board_listed ADD COLUMN last_crawled_at TEXT;
ALTER TABLE board_listed ADD COLUMN grade TEXT;

ALTER TABLE board_listed_details ADD COLUMN bytes INTEGER;

ALTER TABLE board_stats ADD COLUMN bytes INTEGER;