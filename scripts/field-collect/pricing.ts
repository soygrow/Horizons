/**
 * 文档第 6 节：从定价页正文里解析「定价模式 / 免费版 / 试用 / 起步价 / 币种」。
 *
 * 只做文本级解析，不上 DOM 选择器：定价卡片各家结构完全不同，选择器一改版就废，
 * 而「$20 / month」「Free」「14-day free trial」这类文案是产品经理写的，跨站反而稳定。
 * 解析不出来的字段一律留 NULL（文档要求），不猜。
 */

export interface PricingParsed {
  model: string | null;
  hasFreePlan: boolean | null;
  hasFreeTrial: boolean | null;
  startingPrice: number | null;
  currency: string | null;
  /** 命中的价格文案，方便在页面上一眼核对 */
  samples: string[];
  note: string;
}

interface PriceHit {
  amount: number;
  currency: string;
  raw: string;
}

const CURRENCY_PATTERNS: { re: RegExp; currency: string }[] = [
  { re: /US\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/g, currency: "USD" },
  { re: /\$\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/g, currency: "USD" },
  { re: /€\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/g, currency: "EUR" },
  { re: /£\s?(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)/g, currency: "GBP" },
  { re: /(?:¥|￥)\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g, currency: "CNY" },
  { re: /(\d{1,5}(?:,\d{3})*(?:\.\d{1,2})?)\s?(?:USD|EUR|GBP|CNY|JPY|INR|CAD|AUD)/gi, currency: "" },
];

function collectPrices(text: string): PriceHit[] {
  const hits: PriceHit[] = [];
  for (const { re, currency } of CURRENCY_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const amount = Number(m[1].replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) continue;
      let cur = currency;
      if (!cur) {
        const iso = /(USD|EUR|GBP|CNY|JPY|INR|CAD|AUD)/i.exec(m[0])?.[1];
        cur = (iso ?? "").toUpperCase();
      }
      hits.push({ amount, currency: cur || "USD", raw: m[0].trim() });
    }
  }
  return hits;
}

const FREE_PLAN_TELLS = [
  /\bfree (plan|tier|forever|account|edition)\b/i,
  /(^|\n)\s*free\b[^\n]{0,60}$/im,
  /免费版|免费套餐|永久免费/,
  /\$0\b[^\n]{0,40}(forever|forever free)/i,
];

const TRIAL_TELLS = [
  /free trial/i,
  /(7|14|15|30)[-\s]?day (free )?trial/i,
  /try [^\n]{0,30}free/i,
  /免费试用|免费体验/,
];

export function parsePricing(text: string, pageUrl: string): PricingParsed {
  const body = text.replace(/\r/g, "");
  if (!body.trim()) {
    return {
      model: null,
      hasFreePlan: null,
      hasFreeTrial: null,
      startingPrice: null,
      currency: null,
      samples: [],
      note: `定价页无正文（${pageUrl}）`,
    };
  }

  const prices = collectPrices(body);
  const samples = [...new Set(prices.map((p) => p.raw))].slice(0, 8);

  // 起步价 = 所有「非 0」标价里最小的那个。年付档常见 $8/月（按年计费），
  // 与文档口径「起步价格」一致：就是页面上能看到的最低价格。
  const sorted = [...prices].sort((a, b) => a.amount - b.amount);
  const cheapest = sorted[0];
  const startingPrice = cheapest?.amount ?? null;
  const currency = cheapest?.currency ?? null;

  const hasFreePlan = FREE_PLAN_TELLS.some((re) => re.test(body)) ? true : null;
  const hasFreeTrial = TRIAL_TELLS.some((re) => re.test(body)) ? true : null;

  const parts: string[] = [];
  if (hasFreePlan) parts.push("Freemium（含免费版）");
  if (/\b(per month|\/mo\b|\/month|monthly|billed (monthly|annually|yearly)|annual|yearly|订阅|按月|按年)/i.test(body)) {
    parts.push("订阅制");
  }
  if (/\b(pay[- ]as[- ]you[- ]go|usage[- ]based|per (token|credit|1k|1000|request)|credits?|按量付费)/i.test(body)) {
    parts.push("按量付费");
  }
  if (/\b(lifetime|one[- ]time (payment|fee)|买断|永久授权)/i.test(body)) parts.push("一次性买断");
  if (/\b(enterprise|custom pricing|contact (us|sales)|定制|私有化)/i.test(body)) parts.push("企业定制");

  const model = parts.length ? [...new Set(parts)].join(" + ") : null;

  const bits: string[] = [];
  if (!prices.length) bits.push("正文未出现带币种的价格（可能需登录或价格用图片/JS 动态渲染）");
  if (!model) bits.push("未命中任何定价模式关键词");

  return {
    model,
    hasFreePlan,
    hasFreeTrial,
    startingPrice,
    currency,
    samples,
    note: bits.join("；") || `解析自 ${pageUrl}`,
  };
}