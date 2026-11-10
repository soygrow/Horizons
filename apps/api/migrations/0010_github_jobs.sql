-- GitHub 榜后台任务记录（采集 / 发布）
--
-- 与 tool_jobs、trend_jobs 同构：只记录「点过什么按钮、对应哪个 Actions run、结果如何」。
-- 候选池与榜单数据都在仓库 JSON（content/github-staging.json、content/github.json），
-- 不进 D1，避免双写不一致。github.json 有 59MB，也根本塞不进 D1。

CREATE TABLE IF NOT EXISTS github_jobs (
  id TEXT PRIMARY KEY,
  -- fetch: 采集候选进候选池；publish: 合并候选进榜单
  kind TEXT NOT NULL,
  -- queued | running | success | failure | cancelled
  status TEXT NOT NULL DEFAULT 'queued',
  -- 请求参数 JSON（目标容量、是否强制重搜等）
  params TEXT NOT NULL DEFAULT '{}',
  gh_run_id INTEGER,
  run_url TEXT,
  -- 流水线末行 JSON 摘要（候选数 / 进榜数 / 显著变动数等）
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_jobs_created ON github_jobs (created_at DESC);