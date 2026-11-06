/**
 * GitHub 详情页的纯计算：与 data.ts 的
 * computeStarGrowth / isPermissiveLicense / toTrendPoints 口径一致。
 * 详情数据直接取自 content/dist/github/detail/*.json，避免引入体积较大的源站 lib。
 */

interface HistoryPoint {
  date: string;
  stars: number;
  synthetic?: boolean;
}

/**
 * 近 N 天 Star 增量 %。
 * 剔除 synthetic=true 的回填估算点：那些点按当前星标反推，
 * 会让所有项目都呈现「匀速上涨」，是编造出来的增速。
 */
export function starGrowth(history: HistoryPoint[] | undefined, days: number): number | null {
  const h = [...(history ?? [])]
    .filter((p) => !p.synthetic)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (h.length < 2) return null;
  const last = h[h.length - 1];
  const target =
    h.find((p) => (Date.parse(last.date) - Date.parse(p.date)) / 86_400_000 >= days - 1) ?? h[0];
  const prev = target.stars;
  if (prev <= 0) return null;
  const span = (Date.parse(last.date) - Date.parse(target.date)) / 86_400_000;
  if (span < 7) return null;
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