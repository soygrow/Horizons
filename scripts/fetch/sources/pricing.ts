/**
 * 定价抓取（免费、合规、尽力而为）：访问首页与常见定价路径，用正则提取公开价格。
 * 结果较脆弱，仅作第一版参考，人工核实后才会转为 verified。
 */
import type { AITool } from "../../../src/lib/types";
import { config } from "../config";

const PRICE_PATHS = ["/pricing", "/plans", "/price", "/pricing.html"];

const PRICE_RE =
  /(\$|US\$|¥|€)\s?(\d{1,5}(?:\.\d{1,2})?)(\s?\/\s?(?:mo|month|月|year|yr|年))?/gi;

const PERIOD_LABEL: Record<string, string> = {
  mo: "/月",
  month: "/月",
  "月": "/月",
  year: "/年",
  yr: "/年",
  "年": "/年",
};

async function tryFetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": config.userAgent },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractPrices(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(PRICE_RE)) {
    const symbol = m[1] === "US$" ? "$" : m[1];
    const amount = parseFloat(m[2]);
    // 过滤明显噪音：$1/$2 等多是「from $1」「per 1k credits」等非定价表述
    if (!Number.isFinite(amount) || amount < 5 || amount > 100000) continue;
    const periodRaw = (m[3] ?? "").replace(/[\/\s]/g, "");
    const period = PERIOD_LABEL[periodRaw] ?? "";
    const label = `${symbol}${amount}${period}`;
    if (seen.has(label)) continue;
    seen.add(label);
  }
  return [...seen];
}

export async function detectPricing(
  homeUrl: string,
  homeHtml: string,
): Promise<NonNullable<AITool["pricing"]> | undefined> {
  let origin = "";
  try {
    origin = new URL(homeUrl).origin;
  } catch {
    return undefined;
  }

  const htmlPool = [homeHtml];
  for (const p of PRICE_PATHS) {
    if (htmlPool.length >= 3) break;
    const html = await tryFetchText(origin + p);
    if (html) htmlPool.push(html);
  }

  const prices = extractPrices(htmlPool.join("\n"));
  if (prices.length === 0) return undefined;

  return prices.slice(0, 3).map((price, i) => ({
    plan: `方案 ${i + 1}`,
    price,
  }));
}
