/** /sitemap.xml：只列「结构已稳定」的频道页。
 *
 * 详情页（工具 / 仓库 / 趋势词 / 日报）不进 sitemap —— 它们每天随榜单增减，
 * 且页面本身是 noindex，列进来只会浪费抓取预算。频道清单见 src/config/seo.ts。
 */
import type { APIRoute } from "astro";
import { SITE, SITEMAP_PATHS, normalizePath } from "../config/seo";

export const prerender = true;

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);
  const urls = SITEMAP_PATHS.map((p) => {
    const path = normalizePath(p);
    const loc = new URL(path, SITE).href;
    const priority = path === "/" ? "1.0" : "0.8";
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};