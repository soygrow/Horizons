import type { GitHubInsight } from "@horizons/shared";
import { PART_1 } from "./curated-github-insights-p1";
import { PART_2 } from "./curated-github-insights-p2";
import { PART_3 } from "./curated-github-insights-p3";
import { PART_4 } from "./curated-github-insights-p4";

/**
 * 精编情报合集（分片维护，避免单文件过长）。
 * 主文件 `curated-github-insights.ts` 里的同名条目优先级更高。
 */
export const CURATED_INSIGHTS_EXTRA: Record<string, GitHubInsight> = {
  ...PART_1,
  ...PART_2,
  ...PART_3,
  ...PART_4,
};