/**
 * 目标网站侧的一次性抓取：HTML 字段 + 首页正文 + 截图 + Pricing 页正文。
 *
 * 用 Playwright 而不是 fetch+正则，原因很实际：现在大量 AI 工具站是 SPA，
 * fetch 回来的 HTML 里只有 <div id="root">，标题/描述/正文/定价全都没有。
 * 顺带一个页面还能出截图（PC + 手机），这两张图本身就是必采字段。
 *
 * 截图的视口和时机沿用项目现有的截图口径（1280×800 / 390×844，
 * domcontentloaded 后再等 2s 让首屏动画落定，切视口后 600ms 再截），
 * 保证「新采集」的图和线上已有截图是同一种观感，便于对比。
 */
import fs from "node:fs";
import path from "node:path";
import type { Browser } from "playwright";
import { UA } from "./util";

export interface SiteLink {
  href: string;
  text?: string;
}

export interface SiteSnapshot {
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  title: string;
  description: string;
  siteName: string;
  lang: string;
  favicon: string;
  headings: string[];
  text: string;
  links: SiteLink[];
  /** 页面里的 JSON-LD / meta 日期候选（datePublished / dateCreated / article:published_time） */
  publishedDates: string[];
  /** 从链接和文案推断「是否提供 API」 */
  apiHint: boolean;
}

interface RawExtract {
  title: string;
  description: string;
  siteName: string;
  lang: string;
  favicon: string;
  headings: string[];
  text: string;
  links: SiteLink[];
  jsonLd: string;
  metaDates: string[];
}

const VIEWPORTS = [
  { suffix: "desktop", width: 1280, height: 800 },
  { suffix: "mobile", width: 390, height: 844 },
] as const;

function safeName(domain: string): string {
  return domain.replace(/[^a-z0-9.-]/gi, "-");
}

/**
 * 页面内提取脚本。
 *
 * 必须以「字符串」形式传给 page.evaluate，不能传函数：
 * 本脚本用 tsx 运行，esbuild 的 keepNames 会给函数体注入 `__name(...)` 包装，
 * 这个 helper 只存在于 Node 侧，传到浏览器里就变成
 * `ReferenceError: __name is not defined`，整页字段全挂（基本信息和定价组会一起空）。
 * 字符串形式的表达式不经过 esbuild 改写，浏览器里原样执行。
 */
const EXTRACT_SRC = `(() => {
  var abs = function (u) {
    if (!u) return "";
    try { return new URL(u, location.href).toString(); } catch (e) { return ""; }
  };
  var metaContent = function (selector) {
    var el = document.querySelector(selector);
    return el ? (el.getAttribute("content") || "").trim() : "";
  };

  var iconEl =
    document.querySelector('link[rel~="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]') ||
    document.querySelector('link[rel="apple-touch-icon"]') ||
    document.querySelector('link[rel="mask-icon"]');

  var links = [];
  var anchors = document.querySelectorAll("a[href]");
  for (var i = 0; i < anchors.length && links.length < 500; i++) {
    var href = abs(anchors[i].getAttribute("href"));
    if (!href || !/^https?:/i.test(href)) continue;
    links.push({ href: href, text: (anchors[i].textContent || "").trim().slice(0, 100) });
  }

  var headings = [];
  var hs = document.querySelectorAll("h1, h2");
  for (var j = 0; j < hs.length && headings.length < 12; j++) {
    var t = (hs[j].textContent || "").replace(/\\s+/g, " ").trim();
    if (t) headings.push(t);
  }

  var jsonLd = "";
  var scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (var k = 0; k < scripts.length && k < 20; k++) {
    jsonLd += (scripts[k].textContent || "") + "\\n";
  }
  jsonLd = jsonLd.slice(0, 200000);

  var metaDates = [
    metaContent('meta[property="article:published_time"]'),
    metaContent('meta[property="article:modified_time"]'),
    metaContent('meta[name="date"]'),
    metaContent('meta[itemprop="datePublished"]')
  ].filter(Boolean);

  return {
    title: (document.title || "").trim(),
    description: metaContent('meta[name="description"]') || metaContent('meta[property="og:description"]'),
    siteName: metaContent('meta[property="og:site_name"]') || metaContent('meta[name="application-name"]'),
    lang: document.documentElement.getAttribute("lang") || "",
    favicon: abs(iconEl ? iconEl.getAttribute("href") : ""),
    headings: headings,
    text: ((document.body && document.body.innerText) || "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 300000),
    links: links,
    jsonLd: jsonLd,
    metaDates: metaDates
  };
})()`;

/** 页面内提取（字符串表达式，原因见 EXTRACT_SRC 注释） */
async function extract(page: import("playwright").Page): Promise<RawExtract> {
  return (await page.evaluate(EXTRACT_SRC)) as RawExtract;
}

/** 从 JSON-LD 里挖 datePublished / dateCreated / dateModified */
function datesFromJsonLd(jsonLd: string): string[] {
  const out: string[] = [];
  const re = /"(?:datePublished|dateCreated)"\s*:\s*"([^"]{6,40})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsonLd))) out.push(m[1]);
  return out;
}

function isApiHint(links: SiteLink[], text: string): boolean {
  if (links.some((l) => /(^|\.)api\.|docs?\.|\/api(\/|$)|\/docs|developer/i.test(l.href))) return true;
  return /(\bAPI\b|API key|开发者文档|developer (docs|platform))/i.test(text.slice(0, 60_000));
}

export interface SiteResult {
  snapshot: SiteSnapshot | null;
  shots: { desktop?: string; mobile?: string };
  error?: string;
}

/**
 * 打开官网：拿 HTTP 状态、HTML 字段、正文，顺手截两张图。
 *
 * 页面打不开（DNS/证书/超时）不抛，返回 error —— 「网站状态」这个字段本身就是
 * 要采集的对象，打不开也是结果。
 */
export async function loadSite(
  browser: Browser,
  url: string,
  opts: { screenshotDir: string; domain: string },
): Promise<SiteResult> {
  const shots: { desktop?: string; mobile?: string } = {};
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
    locale: "en-US",
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
    const httpStatus = res?.status() ?? 0;
    await page.waitForTimeout(2000);

    // 先截图再抽取：抽取万一失败，两张图仍在（截图本身也是必采字段）
    fs.mkdirSync(opts.screenshotDir, { recursive: true });
    const base = safeName(opts.domain);
    for (const vp of VIEWPORTS) {
      try {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(600);
        const file = path.join(opts.screenshotDir, `${base}-${vp.suffix}.png`);
        await page.screenshot({ path: file, type: "png" });
        shots[vp.suffix] = file;
      } catch (e) {
        console.warn(`[field-collect] ${vp.suffix} 截图失败：`, e instanceof Error ? e.message : e);
      }
    }

    const raw = await extract(page);

    const snapshot: SiteSnapshot = {
      requestedUrl: url,
      finalUrl: page.url(),
      httpStatus,
      title: raw.title,
      description: raw.description,
      siteName: raw.siteName,
      lang: raw.lang,
      favicon: raw.favicon,
      headings: raw.headings,
      text: raw.text,
      links: raw.links,
      publishedDates: [...datesFromJsonLd(raw.jsonLd), ...raw.metaDates],
      apiHint: isApiHint(raw.links, raw.text),
    };
    return { snapshot, shots };
  } catch (e) {
    return { snapshot: null, shots, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

/** 官网链接里挑出定价页（优先官方域名、路径里带 pricing/plans） */
export function pickPricingUrls(snapshot: SiteSnapshot, domain: string): string[] {
  const scored = snapshot.links
    .map((l) => {
      const u = l.href.toLowerCase();
      let score = 0;
      if (/\/(pricing|plans|price|packages)(\/|$|\?)/.test(u)) score += 10;
      else if (/(^|\/)(pricing|plans)/.test(u)) score += 6;
      if (/price|pricing|套餐|定价/.test(l.text ?? "")) score += 4;
      if (u.includes(domain)) score += 3;
      if (/\.(png|jpg|svg|pdf|zip)$/.test(u)) score -= 20;
      return { url: l.href, score };
    })
    .filter((s) => s.score >= 6)
    .sort((a, b) => b.score - a.score);

  const out: string[] = [];
  for (const s of scored) {
    if (out.length >= 2) break;
    if (!out.includes(s.url)) out.push(s.url);
  }
  // 官网没有显式链接时，直接猜一个最常见的路径（很多站只在页脚用 JS 渲染导航）
  if (!out.length) out.push(`https://${domain}/pricing`);
  return out;
}

export interface PricingPage {
  url: string;
  text: string;
  /** 页面里能看到的套餐价（原始数字串），用于人工核对解析结果 */
  error?: string;
}

/** 打开定价页取正文（只取文字，不做 DOM 抽取：定价卡片结构千站千样，正则反而更稳） */
export async function loadPricingPage(browser: Browser, urls: string[]): Promise<PricingPage> {
  let last: PricingPage = { url: urls[0] ?? "", text: "" };
  for (const url of urls) {
    const context = await browser.newContext({ userAgent: UA, locale: "en-US" });
    const page = await context.newPage();
    try {
      const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (!res || res.status() >= 400) {
        last = { url, text: "", error: `HTTP ${res?.status() ?? 0}` };
        continue;
      }
      await page.waitForTimeout(1500);
      // 用 locator 取正文，不传回调（理由同 EXTRACT_SRC：避免 __name 注入）
      const text = (await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "")).slice(0, 60_000);
      if (text.trim().length > 40) return { url, text };
      last = { url, text, error: "页面正文为空" };
    } catch (e) {
      last = { url, text: "", error: e instanceof Error ? e.message : String(e) };
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }
  return last;
}