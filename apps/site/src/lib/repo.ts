/**
 * GitHub 详情页的纯计算：与 apps/web/src/lib/data.ts 的
 * computeStarGrowth / isPermissiveLicense / toTrendPoints 口径一致。
 * 详情数据直接取自 content/dist/github/detail/*.json，避免引入体积较大的源站 lib。
 */

interface HistoryPoint {
  date: string;
  stars: number;
}

/** 近 N 天 Star 增量 %；历史不足返回 null */
export function starGrowth(history: HistoryPoint[] | undefined, days: number): number | null {
  const h = [...(history ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const target =
    h.find((p) => (Date.parse(last.date) - Date.parse(p.date)) / 86_400_000 >= days - 1) ?? h[0];
  const prev = target.stars;
  if (prev <= 0) return null;
  return Math.round(((last.stars - prev) / prev) * 1000) / 10;
}

/** 星标趋势折线点（total = stars，星标视图不画 organic） */
export function starTrendPoints(history: HistoryPoint[] | undefined) {
  return (history ?? []).map((h) => ({ date: h.date, total: h.stars, organic: 0 }));
}

/** GitHub 返回的是各语言字节数，换算成占比后再展示（最多 6 项） */
export function languageShares(languages: Record<string, number> | undefined): [string, number][] {
  const entries = Object.entries(languages ?? {}).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  return entries
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, bytes]) => [name, total > 0 ? Math.round((bytes / total) * 100) : 0]);
}