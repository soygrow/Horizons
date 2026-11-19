-- 榜单元数据：模型榜的 sources / updatedAt、GitHub 榜的 ruleVersion 等。
--
-- 为什么需要它：模型榜与 GitHub 榜改成「只写库」之后，构建时要从库里把榜单
-- 还原成 content/*.json。名次和条目都在 board_listed / board_listed_details 里，
-- 但这两个榜的文件还带着一层元数据（数据来源统计、文案说明、评分规则版本）——
-- 那不是条目的字段，没地方放。board_releases.stats 放的是各榜条数（后台要用），
-- 混进去就得改读取方；board_stats 是「当前生效版本」的单行摘要，正合适。
--
-- 存的是该榜最近一次发布时写进来的原始 JSON，读的时候不解析、原样带回文件。
ALTER TABLE board_stats ADD COLUMN meta TEXT;