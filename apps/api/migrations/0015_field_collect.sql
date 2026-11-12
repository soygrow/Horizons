-- 「新采集」：docs/18-AI工具字段采集方案.md 的字段采集验证。
--
-- 这张表刻意与工具榜/候选池等都无关：它只回答一个问题 ——
-- 按文档的方案，单个网站到底能采到多少字段。所以：
--   - 一行 = 一次采集（输入一个 URL），result 里存整份字段 JSON；
--   - filled / total 是冗余列，只为列表页不解析大 JSON 就能显示覆盖率；
--   - 表里不存任何业务数据，验完方案可以整表清空。

CREATE TABLE IF NOT EXISTS field_collect_runs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  -- queued | running | success | failure | cancelled
  status TEXT NOT NULL DEFAULT 'queued',
  -- 采集进度（人可读，如「查询 Similarweb 流量」），前端轮询展示
  step TEXT,
  filled INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  desktop_url TEXT,
  mobile_url TEXT,
  gh_run_id INTEGER,
  run_url TEXT,
  -- 整份采集结果 JSON（{ fields, groups, coverage, sources, screenshots }）
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_field_collect_created
  ON field_collect_runs (created_at DESC);