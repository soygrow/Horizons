/** SEO 索引策略：默认不索引，白名单放行。
 *
 * 站点处于 Beta、功能与数据持续增加，所以只有「结构已稳定」的频道进索引；
 * 详情页（长尾、随榜单每日增减）与未定稿频道一律 noindex,follow —— 可以顺着链接
 * 抓取发现新页面，但不会把半成品/易变动的内容沉淀进搜索索引。
 *
 * 上线某个频道时，把它加进 INDEXABLE_PATHS 即可，无需改页面代码。
 */
export const SITE = "https://horizons.tools";

/** 允许被搜索引擎索引的路径（无尾斜杠） */
export const INDEXABLE_PATHS = ["/", "/tools", "/github", "/trends", "/privacy", "/terms", "/refund"];

/** 只在 sitemap 中出现的路径：与 INDEXABLE_PATHS 保持一致 */
export const SITEMAP_PATHS = INDEXABLE_PATHS;

export function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function isIndexablePath(pathname: string): boolean {
  return INDEXABLE_PATHS.includes(normalizePath(pathname));
}