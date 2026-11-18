-- ══════════════════════════════════════════════════════════
-- 0019 删掉两个纯冗余索引（节省 rows_written）
-- ══════════════════════════════════════════════════════════
--
-- D1 免费版每天 10 万 rows_written，而「每涉及一个索引就多算一次写入」。
-- 这两个索引都能被主键索引完全替代，多留一份只让每次采集写入多计两行。
--
-- ① idx_collect_raw_domain  ON collect_raw (domain)
--    PK 是 (domain, source, period)。现有查询全是 `WHERE domain = ?`
--    或 `WHERE domain = ? AND source = ?`，走 PK 最左前缀即可；
--    ORDER BY fetched_at 那部分两个索引都不含 fetched_at，本来就要排序。
--
-- ② idx_traffic_history_domain  ON traffic_history (domain, month DESC)
--    PK 是 (domain, month)。SQLite 的 B-tree 索引可以双向扫描：
--    `WHERE domain = ? ORDER BY month DESC` 用 PK 反向扫描即可，
--    `WHERE domain = ? AND month >= ? ORDER BY month` 正向走 PK。
--    反向索引只有在「混合方向排序」（如 ORDER BY a ASC, b DESC）时才有意义。
--
-- DROP INDEX 是 DDL，不计 rows_written。
-- 注意：IF EXISTS 保证重复执行不报错；迁移只跑一次，这里的幂等只是保险。

DROP INDEX IF EXISTS idx_collect_raw_domain;
DROP INDEX IF EXISTS idx_traffic_history_domain;