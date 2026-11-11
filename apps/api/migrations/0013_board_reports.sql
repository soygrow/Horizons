-- 0013 · 榜单报告快照
--
-- tools-stats.json / tools-field-report.json / tools-audit.json 这类产物原来只写进仓库，
-- 后台每次看都要走 GitHub Contents API 读文件。后台已经全面转向 D1，这里给它们
-- 一张通用的键值表：脚本照旧写文件（Actions 里还能看 diff），顺手把同一份 JSON 落库，
-- 后台优先读库、库空时才回落到文件。
--
-- 为什么不做成结构化表：这些都是「一次生成、整体消费」的报告，
-- 后台只按 key 取整份 JSON 渲染，拆字段反而要跟着脚本改表结构。

CREATE TABLE IF NOT EXISTS board_reports (
  key        TEXT PRIMARY KEY,   -- tools-stats / tools-field / tools-audit / …
  payload    TEXT NOT NULL,      -- 报告 JSON 原文
  updated_at INTEGER NOT NULL,   -- 本次写入 epoch ms
  source     TEXT NOT NULL       -- 写入来源：脚本名，排查时用
);