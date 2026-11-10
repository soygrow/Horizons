-- 趋势榜后台任务记录（采集 / 发布）
--
-- 与 tool_jobs 同构：只记录「点过什么按钮、对应哪个 Actions run、结果如何」。
-- 候选词与榜单数据都在仓库 JSON（content/trends-staging.json、content/trends.json），
-- 不进 D1，避免双写不一致。

CREATE TABLE IF NOT EXISTS trend_jobs (
  id TEXT PRIMARY KEY,
  -- fetch: 采集新词进候选池；publish: 把候选池合并进榜单
  kind TEXT NOT NULL,
  -- queued | running | success | failure | cancelled
  status TEXT NOT NULL DEFAULT 'queued',
  -- 请求参数 JSON（数量上限、地区等）
  params TEXT NOT NULL DEFAULT '{}',
  gh_run_id INTEGER,
  run_url TEXT,
  -- 流水线末行 JSON 摘要（候选数 / 位次变动数等）
  summary TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trend_jobs_created ON trend_jobs (created_at DESC);