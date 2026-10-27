/**
 * 自建站点审计（免费、合规）：只抓官网首页一次，用正则解析页面结构 + 技术栈 + 收款信号。
 * 产出 V5 的 siteAudit / pageStructure / paymentDetected / outboundDomains。
 */
import type { PageStructure, SiteAudit } from "@horizons/shared";
import { config } from "../config";
import { detectTechStack } from "./techstack";

export interface SiteAuditResult {
  pageStructure: PageStructure;
  siteAudit: SiteAudit;
  paymentDetected: string[];
}

const PAYMENT_PROVIDERS: { pattern: RegExp; label: string }[] = [
  { pattern: /stripe\.com|js\.stripe|checkout\.stripe|pay\.stripe/i, label: "Stripe" },
  { pattern: /paddle\.com|cdn\.paddle|checkout\.paddle|paddlepay/i, label: "Paddle" },
  { pattern: /lemonsqueezy\.com|lemonsqueezy|ls\.sessions/i, label: "Lemon Squeezy" },
  { pattern: /gumroad\.com|gumroad/i, label: "Gumroad" },
  { pattern: /paypal\.com|paypalobjects/i, label: "PayPal" },
];

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function matchOne(re: RegExp, html: string): string | undefined {
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : undefined;
}

function matchAll(re: RegExp, html: string): string[] {
  return [...html.matchAll(re)].map((m) => decodeEntities(m[1])).filter(Boolean);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** 抓首页（跟随重定向），返回 HTML、响应头、最终 URL */
export async function fetchHome(url: string): Promise<{
  html: string;
  headers: Record<string, string>;
  finalUrl: string;
}> {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
    headers: { "User-Agent": config.userAgent },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { html, headers, finalUrl: res.url || url };
}

/** 解析结构化数据（JSON-LD @type 列表） */
function parseJsonLdTypes(html: string): string[] {
  const types = new Set<string>();
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item && typeof item === "object" && item["@type"]) {
          const t = item["@type"];
          if (Array.isArray(t)) t.forEach((x: string) => types.add(x));
          else types.add(String(t));
        }
      }
    } catch {
      // 忽略解析失败的 JSON-LD
    }
  }
  return [...types];
}

/** 统计正文字数：中文字符数 + 英文词数 */
function countWords(text: string): number {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latinWords = (text.replace(/[\u4e00-\u9fff]/g, " ").match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + latinWords;
}

export function auditSite(html: string, headers: Record<string, string>, baseUrl: string): SiteAuditResult {
  let origin = baseUrl;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    /* keep as-is */
  }
  let baseHost = origin;
  try {
    baseHost = new URL(origin).hostname;
  } catch {
    /* ignore */
  }

  // 页面语言
  const lang = matchOne(/<html[^>]+lang=["']([^"']+)["']/i, html);

  // 标题 / meta / canonical / robots
  const title = matchOne(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  const metaDescription = matchOne(
    /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']*)["'][^>]*\/?>/i,
    html,
  ) ?? matchOne(
    /<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*\/?>/i,
    html,
  );
  const canonical = matchOne(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i, html)
    ?? matchOne(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i, html);
  const robots = matchOne(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']*)["']/i, html);

  // 标题层级
  const h1 = dedupe(matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, html).map(stripTags));
  const h2 = dedupe(matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, html).map(stripTags));
  const h3 = dedupe(matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, html).map(stripTags));

  // 链接：内链 / 出站
  const internal: { text: string; url: string }[] = [];
  const outbound: { text: string; url: string }[] = [];
  const outboundDomains = new Set<string>();
  const linkRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(linkRe)) {
    const href = m[1];
    const text = stripTags(m[2]) || "";
    let abs: string;
    try {
      abs = new URL(href, origin).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs)) continue;
    const host = new URL(abs).hostname;
    const isSame = host === baseHost || host === baseHost.replace(/^www\./, "") || baseHost === host.replace(/^www\./, "");
    const rec = { text: text.slice(0, 80), url: abs };
    if (isSame) internal.push(rec);
    else {
      outbound.push(rec);
      outboundDomains.add(host);
    }
  }

  // 图片
  const imgRe = /<img[^>]*>/gi;
  const imgs = html.match(imgRe) ?? [];
  const imagesMissingAlt = imgs.filter((t) => !/\salt=/.test(t)).length;

  // 结构化数据
  const structuredData = parseJsonLdTypes(html);

  // 技术栈 + 分析工具
  const techStack = detectTechStack(html, headers);

  // 收款信号
  const paymentDetected = PAYMENT_PROVIDERS.filter((p) => p.pattern.test(html)).map((p) => p.label);

  // 正文字数
  const wordCount = countWords(stripTags(html));

  const siteAudit: SiteAudit = {
    techStack,
    wordCount,
    pageLang: lang?.split("-")[0]?.toLowerCase(),
    internalLinks: internal.length,
    outboundLinks: outbound.length,
    images: imgs.length,
    imagesMissingAlt,
    structuredData,
    outboundDomains: [...outboundDomains].slice(0, 10),
  };

  const pageStructure: PageStructure = {
    title,
    metaDescription,
    canonical,
    robotsDirective: robots,
    h1: h1.slice(0, 20),
    h2: h2.slice(0, 30),
    h3: h3.slice(0, 40),
    internalLinks: internal.slice(0, 80),
    outboundLinks: outbound.slice(0, 10),
  };

  return { pageStructure, siteAudit, paymentDetected };
}

/**
 * RDAP 查询域名注册时间（免费、准确）。
 * 相比 DataForSEO whois 对 .ai 等 ccTLD 的覆盖（可能返回 TLD 早期时间），RDAP 直接返回权威注册信息。
 */
export async function fetchRegistrationDate(domain: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: {
        Accept: "application/rdap+json, application/json",
        "User-Agent": config.userAgent,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      events?: { eventAction?: string; eventDate?: string }[];
    };
    const reg = data.events?.find((e) => e.eventAction === "registration");
    if (reg?.eventDate) return reg.eventDate.slice(0, 10);
    return undefined;
  } catch {
    return undefined;
  }
}

/** 收款信号：额外抓取定价页检测支付平台跳转（首页可能未嵌入支付 SDK） */
export async function detectPaymentSignals(homeUrl: string, homeHtml: string): Promise<string[]> {
  let origin = "";
  try {
    origin = new URL(homeUrl).origin;
  } catch {
    return [];
  }

  const pools = [homeHtml];
  for (const path of ["/pricing", "/pricing/", "/plans", "/signup", "/checkout"]) {
    if (pools.length >= 3) break;
    try {
      const res = await fetch(origin + path, {
        headers: { "User-Agent": config.userAgent },
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) pools.push(await res.text());
    } catch {
      /* ignore */
    }
  }

  const html = pools.join("\n");
  return PAYMENT_PROVIDERS.filter((p) => p.pattern.test(html)).map((p) => p.label);
}

/* ----------------------- 收入信号估算 ----------------------- */

export interface RevenueSignalEstimate {
  /** 估算月收入信号（美元）：月访问量 × 付款转化率 × 客单价；无访问量或付费证据时为 undefined */
  monthlyRevenue?: number;
  /** 采用的付款转化率基准（0.02 = 2%） */
  rate: number;
  /** 采用的客单价（美元）：定价线索中位数，无则行业默认 */
  aov: number;
}

/**
 * 估算「月收入信号」：把月访问量按行业付款转化率 × 客单价折算，作为收入预算参考的估算量级。
 * 注意：这是流量 + 定价推导的估算值，只能体现收入量级，不是真实收入（真实收入只有商户自己的收款后台才有）。
 */
export function estimateRevenueSignal(opts: {
  monthlyVisits?: number;
  paymentDetected?: string[];
  pricingClues?: string[];
  categories?: string[];
}): RevenueSignalEstimate {
  const rate = pickConversionRate(opts.categories);
  const aov = pickAov(opts.pricingClues, opts.categories);
  // 付费证据：检测到支付商 或 有定价线索（有明确定价即可视为存在付费模式）
  const hasMonetization = !!opts.paymentDetected?.length || !!opts.pricingClues?.length;
  if (!hasMonetization) return { rate, aov };
  const visits = opts.monthlyVisits;
  // 没有访问量口径（DFS 仅搜索流量且过小 / 未接入 SimilarWeb）→ 不编造
  if (!visits || visits < 1) return { rate, aov };
  return { monthlyRevenue: Math.round(visits * rate * aov), rate, aov };
}

/** 按赛道给一个合理的付款转化率基准（仅作估算，非真实值） */
function pickConversionRate(categories?: string[]): number {
  const c = (categories ?? []).join(" ").toLowerCase();
  if (/(ecommerce|shop|store|电商|购物|marketplace)/.test(c)) return 0.03; // 电商结算转化偏高
  if (/(chat|writing|coding|productivity|video|image|audio|voice|ai)/.test(c)) return 0.02; // SaaS/订阅偏低
  return 0.025; // 默认
}

/** 客单价：优先取定价线索的中位数，无则按赛道给行业默认值（仅作估算） */
function pickAov(pricingClues?: string[], categories?: string[]): number {
  const nums = (pricingClues ?? [])
    .map((p) => parseFloat(String(p).replace(/[^0-9.]/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 5 && n <= 100000);
  if (nums.length) {
    nums.sort((a, b) => a - b);
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
  }
  const c = (categories ?? []).join(" ").toLowerCase();
  if (/(ecommerce|shop|store|电商|购物|marketplace)/.test(c)) return 50; // 电商客单偏高
  if (/(chat|writing|coding|productivity|video|image|audio|voice|ai)/.test(c)) return 20; // SaaS/订阅客单
  return 25; // 默认
}
