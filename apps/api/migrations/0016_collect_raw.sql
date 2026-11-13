-- 采集原始响应缓存 + 月度访问序列。
--
-- 解决两个问题：
--
-- 1. **重复付费** —— 同一个域名、同一个接口，全生命周期只买一次。
--    准入买过的 vortex base_data，富化阶段只读 `collect_raw`，不再调用。
--
-- 2. **趋势图数据不够** —— vortex 每次只返回最近 3 个月，而页面要展示 6 个月。
--    每采集一次就把返回的所有月份写进 `traffic_history`，按月累积；
--    读的时候取近 6 个月，缺失月份由调用方补 0。
--
-- `period` 只对 vortex base_data 有意义：Similarweb 快照按月刷新，
-- period='2026-10' 的记录到 11 月自然不再命中，于是允许买一次新快照。
-- 「不重复买」因此不依赖 TTL 定时器，也不会因为部署时间漂移提前失效。

CREATE TABLE IF NOT EXISTS collect_raw (
  domain TEXT NOT NULL,
  -- vortex_base | vortex_aitdk | vortex_similar | serp | html | pricing | wayback | crtsh | commoncrawl | lergassy
  source TEXT NOT NULL,
  -- 仅 vortex_base 使用：快照所属月份 YYYY-MM；其他源留空串
  period TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL,
  -- 原始 JSON，不加工：字段映射改了也不需要重新买
  payload TEXT,
  error TEXT,
  -- 真实扣费；缓存命中写 0
  cost_usd REAL NOT NULL DEFAULT 0,
  -- admission | enrich：谁写的，后台据此判断「这个数是什么时候拿到的」
  via TEXT,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (domain, source, period)
);

CREATE INDEX IF NOT EXISTS idx_collect_raw_domain
  ON collect_raw (domain);

CREATE INDEX IF NOT EXISTS idx_collect_raw_source
  ON collect_raw (source, fetched_at DESC);

CREATE TABLE IF NOT EXISTS traffic_history (
  domain TEXT NOT NULL,
  -- YYYY-MM
  month TEXT NOT NULL,
  visits INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'vortex_base',
  -- 快照日期，便于页面标注「数据采集于」
  snapshot_date TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (domain, month)
);

CREATE INDEX IF NOT EXISTS idx_traffic_history_domain
  ON traffic_history (domain, month DESC);