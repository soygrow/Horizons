/** 构建期数据入口：只读 content/dist（由 scripts/build/artifacts.ts 生成） */
import type {
  HomeData,
  ModelFilters,
  ModelRow,
  RepoFilters,
  RepoRow,
  ToolFilters,
  ToolRow,
  TrendFilters,
  TrendRow,
} from "./types";

import toolsRaw from "../../../../content/dist/tools/index.json";
import reposRaw from "../../../../content/dist/github/index.json";
import trendRaw from "../../../../content/dist/trends/index.json";
import modelsRaw from "../../../../content/dist/models/index.json";
import toolFiltersRaw from "../../../../content/dist/tools/filters.json";
import repoFiltersRaw from "../../../../content/dist/github/filters.json";
import trendFiltersRaw from "../../../../content/dist/trends/filters.json";
import modelFiltersRaw from "../../../../content/dist/models/filters.json";
import homeRaw from "../../../../content/dist/home.json";
import oppIndexRaw from "../../../../content/dist/opportunity/index.json";

import type { OpportunityDetail, OpportunityIndex } from "./opportunity";

export const toolRows = toolsRaw as unknown as ToolRow[];
export const repoRows = reposRaw as unknown as RepoRow[];
export const trendRows = trendRaw as unknown as TrendRow[];
export const modelRows = modelsRaw as unknown as ModelRow[];
export const toolFilters = toolFiltersRaw as unknown as ToolFilters;
export const repoFilters = repoFiltersRaw as unknown as RepoFilters;
export const trendFilters = trendFiltersRaw as unknown as TrendFilters;
export const modelFilters = modelFiltersRaw as unknown as ModelFilters;
export const homeData = homeRaw as unknown as HomeData;

/* ------------------------------- 机会榜 ------------------------------- */

export const opportunityIndex = oppIndexRaw as unknown as OpportunityIndex;
export const opportunityPolicy = opportunityIndex.policy;
export const opportunityRows = opportunityIndex.rows;
export const opportunityBatches = opportunityIndex.batches;
export const latestBatch = opportunityIndex.latestBatch;

/** 最新一批：列表页只渲染这些 */
export const latestOpportunityRows = opportunityRows.filter((r) => r.isLatest);
/** 历史批次：归档页承接 */
export const archivedOpportunityRows = opportunityRows.filter((r) => !r.isLatest);

export function rowsOfBatch(batch: string) {
  return opportunityRows.filter((r) => r.batch === batch);
}

/** 详情页数据：5 条固定，用 glob 免去新增机会时改导入列表 */
const opportunityDetails = import.meta.glob<OpportunityDetail>(
  "../../../../content/dist/opportunity/detail/*.json",
  { eager: true, import: "default" },
);

export function getOpportunity(slug: string): OpportunityDetail | null {
  return opportunityDetails[`../../../../content/dist/opportunity/detail/${slug}.json`] ?? null;
}

export function allOpportunities(): OpportunityDetail[] {
  return opportunityRows
    .map((r) => getOpportunity(r.slug))
    .filter((d): d is OpportunityDetail => Boolean(d));
}

/** 每页条数：与现有站 tools/github 列表一致 */
export const PAGE_SIZE = 20;

/** 趋势词默认视图每个分区展示行数（与源站 SECTION_SIZE 一致） */
export const TREND_SECTION_SIZE = 6;

export const totalPages = (n: number) => Math.max(1, Math.ceil(n / PAGE_SIZE));

/**
 * 默认排序：综合得分降序。
 * rank 由构建期按综合得分固化（1 = 全库最高分），因此按 rank 升序即等于按得分降序。
 */
export function sortByScore<T extends { rank: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.rank - b.rank);
}