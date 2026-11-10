-- 工具榜后台任务记录（抓取 / 发布）
--
-- 只记录「点过什么按钮、对应哪个 GitHub Actions run、结果如何」，
-- 候选与榜单数据本身仍在仓库的 JSON 文件里，避免双写导致状态不一致。

CREATE TABLE IF NOT EXISTS tool_jobs (
  id TEXT PRIMARY KEY,
  -- fetch: 抓取新工具进待发布队列；publish: 把待发布队列合并进榜单
  kind TEXT NOT NULL,
  -- queued | running | success | failure | cancelled
  status TEXT NOT NULL DEFAULT 'queued',
  -- 请求参数 JSON（数量、排序、是否富化等）
  params TEXT NOT NULL DEFAULT '{}',
  gh_run_id INTEGER,
  run_url TEXT,
  -- 流水线最后一行 JSON 摘要（新增数 / 跳过数等）
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_jobs_created ON tool_jobs (created_at DESC);