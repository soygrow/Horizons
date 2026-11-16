-- 工作区条目区分「新增」与「更新线上」
--
-- 两个 tab 的数据在库里就必须分开，否则发布时会把另一个 tab 的待审条目
-- 一起带走（线上榜单点发布，结果新采集的 9 条也上线了）。
--
--   new     采集到的新工具，发布时追加
--   refresh 线上已有条目的重采结果，发布时覆盖同域名条目
--
-- 默认 new：迁移前已有的行都是新条目语义，历史行为不变。
ALTER TABLE board_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'new';

-- 后台按 kind + status 分页（线上榜单的「更新待审核」就是 kind=refresh & status=enriched）
CREATE INDEX IF NOT EXISTS idx_items_kind ON board_items (board, kind, status, updated_at DESC);