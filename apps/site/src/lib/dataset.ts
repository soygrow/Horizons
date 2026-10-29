/** 构建期数据入口：只读 content/dist（由 scripts/build/artifacts.ts 生成） */
import type {
  HomeData,
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
import toolFiltersRaw from "../../../../content/dist/tools/filters.json";
import repoFiltersRaw from "../../../../content/dist/github/filters.json";
import trendFiltersRaw from "../../../../content/dist/trends/filters.json";
import homeRaw from "../../../../content/dist/home.json";

export const toolRows = toolsRaw as unknown as ToolRow[];
export const repoRows = reposRaw as unknown as RepoRow[];
export const trendRows = trendRaw as unknown as TrendRow[];
export const toolFilters = toolFiltersRaw as unknown as ToolFilters;
export const repoFilters = repoFiltersRaw as unknown as RepoFilters;
export const trendFilters = trendFiltersRaw as unknown as TrendFilters;
export const homeData = homeRaw as unknown as HomeData;

/** 每页条数：与现有站 tools/github 列表一致 */
export const PAGE_SIZE = 20;

/** 趋势词默认视图每个分区展示行数（与源站 SECTION_SIZE 一致） */
export const TREND_SECTION_SIZE = 6;

export const totalPages = (n: number) => Math.max(1, Math.ceil(n / PAGE_SIZE));

/** 默认排序：热度降序（与 getToolsSorted 一致） */
export function sortByHeat<T extends { heat: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.heat - a.heat);
}