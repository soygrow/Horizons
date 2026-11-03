/** 流量与搜索表现的埋点配置（GA4 / Cloudflare Web Analytics / Google Search Console）。
 *
 * 三个 ID 都是「写进 HTML 就是公开」的值，不是密钥，所以默认直接写在代码里，
 * 保证 push 到 main 后自动部署即可生效，无需再配 GitHub Secrets。
 * 需要切换成测试属性时，用同名环境变量覆盖（构建期读取）：
 *   PUBLIC_GA4_ID              GA4 衡量 ID
 *   PUBLIC_CF_BEACON_TOKEN     Cloudflare Web Analytics 的 Beacon token
 *   PUBLIC_GSC_VERIFICATION    GSC 的 google-site-verification 值（meta 标签方式）
 *   PUBLIC_ANALYTICS_DEV=1     本地 dev 也加载埋点（默认只在 build 产物里注入）
 */

const env = import.meta.env;

/** GA4 衡量 ID（数据流：网站） */
export const GA4_ID = (env.PUBLIC_GA4_ID as string | undefined) || "G-LNYG7774H6";

/** Cloudflare Web Analytics beacon token
 *
 * 取值：Cloudflare Dashboard → Web Analytics → horizons.tools → 「JS 代码段」里的 token。
 * 留空则不注入 —— 若站点改走 Cloudflare 的「自动设置」，边缘会自动插入同一段脚本，
 * 两处同时存在会产生重复上报，所以二者只启用一处（当前站是手动代码段）。
 */
export const CF_BEACON_TOKEN =
  (env.PUBLIC_CF_BEACON_TOKEN as string | undefined) || "bfaf53c13258418abe97581d45e80ea2";

/** GSC 域名验证值（搜索引擎只能看到 meta，不需要令牌以外的信息）
 *
 * 取值：Search Console → 添加资源 → 「HTML 标记」方式里的 content 值。
 * 偏好 DNS 验证的话留空即可，用 Cloudflare DNS 加 TXT 记录验证，不依赖这段代码。
 */
export const GSC_VERIFICATION = (env.PUBLIC_GSC_VERIFICATION as string | undefined) || "";

/** 是否注入埋点：只在生产构建注入，避免 `astro dev` / 本地预览污染 GA4 数据 */
export const ANALYTICS_ENABLED =
  env.PROD || Boolean(env.PUBLIC_ANALYTICS_DEV);