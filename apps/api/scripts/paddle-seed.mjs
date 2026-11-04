#!/usr/bin/env node
/**
 * Paddle 目录初始化（幂等，可重复执行）。
 *
 *   node scripts/paddle-seed.mjs --key pdl_sdbx_apikey_xxx --env sandbox
 *
 * 做三件事：
 *   1. 建（或复用）Product: Horizons Pro，tax_category = saas
 *   2. 建 8 个 Price：订阅 4 个（recurring / $20·$160·¥149·¥1,099）
 *                    + 一次性 4 个（无 billing_cycle / $23·$180·¥169·¥1,299）
 *   3. 打印可直接粘贴的 `wrangler secret put` 命令
 *
 * 幂等靠 custom_data.seed_key：已存在同 key 的 price 就跳过，不会重复建。
 * 一次性 price 的区别就是「不传 billing_cycle」——不传即 one-time，传了即订阅。
 *
 * 为什么要脚本而不是后台点：8 个价格手点容易把 one-time 选成 standard（变成订阅），
 * 脚本把 billing_cycle 的有无写死，不可能点错。
 */

const BASE = {
  sandbox: "https://sandbox-api.paddle.com",
  production: "https://api.paddle.com",
};

const PRODUCT = {
  name: "Horizons Pro",
  tax_category: "saas",
  description: "Horizons AI 工具榜 / GitHub 榜 / 模型榜 / 趋势词榜的 Pro 订阅与买断",
  seed_key: "horizons-pro",
};

/** cycle 为 null 即一次性（one-time），否则为订阅（recurring） */
const PLANS = [
  { seed: "month_usd", secret: "PADDLE_PRICE_MONTH_USD", amount: "2000", currency: "USD", cycle: ["month", 1], name: "Pro · Monthly (auto-renew)" },
  { seed: "year_usd", secret: "PADDLE_PRICE_YEAR_USD", amount: "16000", currency: "USD", cycle: ["year", 1], name: "Pro · Yearly (auto-renew)" },
  { seed: "month_cny", secret: "PADDLE_PRICE_MONTH_CNY", amount: "14900", currency: "CNY", cycle: ["month", 1], name: "Pro · Monthly (auto-renew, CNY)" },
  { seed: "year_cny", secret: "PADDLE_PRICE_YEAR_CNY", amount: "109900", currency: "CNY", cycle: ["year", 1], name: "Pro · Yearly (auto-renew, CNY)" },
  { seed: "once_month_usd", secret: "PADDLE_PRICE_MONTH_ONCE_USD", amount: "2300", currency: "USD", cycle: null, name: "Pro · 30 days (one-time)" },
  { seed: "once_year_usd", secret: "PADDLE_PRICE_YEAR_ONCE_USD", amount: "18000", currency: "USD", cycle: null, name: "Pro · 365 days (one-time)" },
  { seed: "once_month_cny", secret: "PADDLE_PRICE_MONTH_ONCE_CNY", amount: "16900", currency: "CNY", cycle: null, name: "Pro · 30 days (one-time, CNY)" },
  { seed: "once_year_cny", secret: "PADDLE_PRICE_YEAR_ONCE_CNY", amount: "129900", currency: "CNY", cycle: null, name: "Pro · 365 days (one-time, CNY)" },
];

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const envName = flag("env") || process.env.PADDLE_ENV || "sandbox";
const apiKey = flag("key") || process.env.PADDLE_API_KEY;

if (!BASE[envName]) {
  console.error(`--env 只能是 sandbox 或 production，收到 ${envName}`);
  process.exit(1);
}
if (!apiKey || !apiKey.startsWith("pdl_")) {
  console.error(
    [
      "缺少 API key。到下面地址生成一个（权限至少 product.write + price.write）：",
      "  sandbox: https://sandbox-vendors.paddle.com/authentication-v2",
      "  live:    https://vendors.paddle.com/authentication-v2",
      "",
      "然后：node scripts/paddle-seed.mjs --key pdl_sdbx_apikey_xxx --env sandbox",
    ].join("\n"),
  );
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE[envName]}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}\n${text.slice(0, 600)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function listAll(path) {
  const out = [];
  let next = path.includes("?") ? `${path}&per_page=200` : `${path}?per_page=200`;
  while (next) {
    const page = await api("GET", next);
    out.push(...(page.data ?? []));
    const p = page.meta?.pagination;
    next = p?.has_more ? `${new URL(p.next).pathname}${new URL(p.next).search}` : null;
  }
  return out;
}

const currency = (code, amount) => `${code} ${(Number(amount) / 100).toFixed(2)}`;

async function ensureProduct() {
  const products = await listAll("/products?status=active");
  const hit = products.find((p) => p.custom_data?.seed_key === PRODUCT.seed_key);
  if (hit) {
    console.log(`· 复用 Product ${hit.id} (${hit.name})`);
    return hit;
  }
  const { data } = await api("POST", "/products", {
    name: PRODUCT.name,
    tax_category: PRODUCT.tax_category,
    description: PRODUCT.description,
    custom_data: { seed_key: PRODUCT.seed_key },
  });
  console.log(`+ 新建 Product ${data.id} (${data.name})`);
  return data;
}

async function ensurePrices(productId) {
  const existing = await listAll(`/prices?product_id=${productId}&status=active`);
  const bySeed = new Map(existing.map((p) => [p.custom_data?.seed_key, p]));
  const result = {};

  for (const plan of PLANS) {
    const hit = bySeed.get(plan.seed);
    if (hit) {
      const kind = hit.billing_cycle ? "订阅" : "一次性";
      console.log(`· 复用 ${plan.seed.padEnd(16)} ${hit.id}  ${currency(hit.unit_price.currency_code, hit.unit_price.amount).padEnd(12)} ${kind}`);
      result[plan.secret] = hit.id;
      continue;
    }

    const body = {
      product_id: productId,
      description: `Horizons Pro · ${plan.seed}`,
      name: plan.name,
      unit_price: { amount: plan.amount, currency_code: plan.currency },
      custom_data: { seed_key: plan.seed },
    };
    // 关键：一次性价格不传 billing_cycle。传了就成了订阅。
    if (plan.cycle) {
      body.billing_cycle = { interval: plan.cycle[0], frequency: plan.cycle[1] };
    }

    const { data } = await api("POST", "/prices", body);
    const kind = data.billing_cycle ? `订阅 ${data.billing_cycle.interval}` : "一次性";
    console.log(`+ 新建 ${plan.seed.padEnd(16)} ${data.id}  ${currency(data.unit_price.currency_code, data.unit_price.amount).padEnd(12)} ${kind}`);
    result[plan.secret] = data.id;
  }

  return result;
}

function printSecrets(secrets) {
  console.log("\n" + "=".repeat(64));
  console.log(`环境：${envName}　—　以下 8 个值写入 Workers secret`);
  console.log("=".repeat(64) + "\n");
  for (const [k, v] of Object.entries(secrets)) console.log(`${k}=${v}`);
  console.log("\n# 写入（在 apps/api 下逐个执行；本项目没有 wrangler 环境分层）");
  for (const [k, v] of Object.entries(secrets)) {
    console.log(`npx wrangler secret put ${k}    # 粘贴 ${v}`);
  }
  console.log("\n# 本地开发（.dev.vars）");
  console.log(Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"));
}

try {
  console.log(`Paddle ${envName} 目录初始化\n`);
  const product = await ensureProduct();
  const secrets = await ensurePrices(product.id);
  printSecrets(secrets);
  console.log("\n完成。记得：支付宝需单独提交审批（CNY 定价 + 订阅续费 ≤ 1,600 CNY）。");
} catch (err) {
  console.error(`\n失败：${err.message}`);
  process.exit(1);
}