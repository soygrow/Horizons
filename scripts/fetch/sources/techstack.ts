/**
 * 自建技术栈检测（免费、合规）：只请求首页，解析响应头 + HTML 特征。
 * 不依赖 Wappalyzer / BuiltWith 等付费 API。
 *
 * 输入为已抓取的首页 HTML 与响应头，输出去重后的技术标签数组。
 */

type HeaderMap = Record<string, string>;

const headerRules: { header: string; pattern: RegExp; label: string }[] = [
  { header: "server", pattern: /cloudflare/i, label: "Cloudflare" },
  { header: "server", pattern: /openresty/i, label: "OpenResty" },
  { header: "server", pattern: /nginx/i, label: "Nginx" },
  { header: "server", pattern: /apache/i, label: "Apache" },
  { header: "server", pattern: /caddy/i, label: "Caddy" },
  { header: "x-powered-by", pattern: /next\.js/i, label: "Next.js" },
  { header: "x-powered-by", pattern: /express/i, label: "Express" },
  { header: "x-powered-by", pattern: /php/i, label: "PHP" },
  { header: "x-powered-by", pattern: /asp\.net/i, label: "ASP.NET" },
  { header: "x-powered-by", pattern: /remix/i, label: "Remix" },
];

const headerPresence: { header: string; label: string }[] = [
  { header: "cf-ray", label: "Cloudflare" },
  { header: "x-vercel-id", label: "Vercel" },
  { header: "x-nf-request-id", label: "Netlify" },
  { header: "x-amz-cf-id", label: "CloudFront" },
];

const htmlRules: { pattern: RegExp; label: string }[] = [
  { pattern: /__NEXT_DATA__|_next\/static\//i, label: "Next.js" },
  { pattern: /<meta[^>]+name=["']generator["'][^>]+content=["'][^"']*WordPress/i, label: "WordPress" },
  { pattern: /wp-content\/|wp-includes\//i, label: "WordPress" },
  { pattern: /_nuxt\/|__NUXT__/i, label: "Nuxt.js" },
  { pattern: /__GATSBY|gatsby-/, label: "Gatsby" },
  { pattern: /astro|astro\//, label: "Astro" },
  { pattern: /react(-dom)?(\.production|\.development)?\.min\.js/i, label: "React" },
  { pattern: /vue(\.runtime)?(\.global)?(\.prod)?\.js|data-v-[0-9a-f]{6,}/i, label: "Vue.js" },
  { pattern: /cdn\.shopify\.com|Shopify\.theme/i, label: "Shopify" },
  { pattern: /data-wf-page|webflow/i, label: "Webflow" },
  { pattern: /static1\.squarespace|squarespace/i, label: "Squarespace" },
  { pattern: /wixstatic\.com|wix\.com/i, label: "Wix" },
  { pattern: /cdn\.framer\.com|data-framer/i, label: "Framer" },
  { pattern: /cdn\.tailwindcss\.com/i, label: "Tailwind CSS" },
  { pattern: /googletagmanager\.com\/gtag\/js|gtag\(/i, label: "Google Analytics" },
  { pattern: /googletagmanager\.com\/gtm\.js/i, label: "Google Tag Manager" },
  { pattern: /browser\.sentry-cdn\.com|js\.sentry-cdn\.com/i, label: "Sentry" },
  { pattern: /js\.stripe\.com/i, label: "Stripe" },
  { pattern: /widget\.intercom\.io/i, label: "Intercom" },
  { pattern: /cdn\.amplitude\.com/i, label: "Amplitude" },
  { pattern: /segment\.com\/analytics\.js|cdn\.segment\.com/i, label: "Segment" },
  { pattern: /static\.hotjar\.com/i, label: "Hotjar" },
  { pattern: /webpack|__webpack_require__/i, label: "Webpack" },
  { pattern: /vite\/client|__vite__/i, label: "Vite" },
];

export function detectTechStack(html: string, headers: HeaderMap): string[] {
  const found = new Set<string>();
  const lowerHeaders = new Set(Object.keys(headers).map((k) => k.toLowerCase()));

  for (const r of headerRules) {
    const val = headers[r.header.toLowerCase()] ?? headers[r.header];
    if (val && r.pattern.test(val)) found.add(r.label);
  }
  for (const p of headerPresence) {
    if (lowerHeaders.has(p.header.toLowerCase())) found.add(p.label);
  }
  for (const r of htmlRules) {
    if (r.pattern.test(html)) found.add(r.label);
  }

  return [...found];
}
