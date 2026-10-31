import fs from "node:fs";
import path from "node:path";
import type { AITool, AIToolCategory } from "@horizons/shared";
import "./config"; // 加载 .env.local
import { extractTrafficMetrics, fetchLergassyMulti } from "./sources/apify";
import { applyTraffic } from "./apply-traffic";

/**
 * 用「相似站点」扩充候选池。
 *
 * 思路：Product Hunt 的 AI 话题已挖尽（新增骤降），但 SimilarWeb 为每个站点
 * 提供了 similarSites（同类产品 + 相似度）。以已收录的高流量站为种子，
 * 能稳定挖出「同类、有真实流量」的候选，质量远高于 PH 新发布的产品。
 *
 * 用法：
 *   pnpm tsx scripts/fetch/discover-similar.ts [--seeds 60] [--min-visits 5000] [--dry]
 *
 * 成本：该数据源免费，只消耗时间（每 25 个域名约 1.5 分钟）。
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

/** 平台/基础设施型大站，不进入工具榜（见 docs/15-AI工具榜收录原则.md A2） */
const EXCLUDED = new Set([
  "microsoft.com",
  "google.com",
  "apple.com",
  "amazon.com",
  "cloudflare.com",
  "figma.com",
  "adobe.com",
  "notion.com",
  "notion.so",
  "slack.com",
  "zoom.us",
  "1password.com",
  "openai.com",
  "chatgpt.com",
  "anthropic.com",
  "github.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "wikipedia.org",
  // 相似站点里常见的非 AI 噪声：社区、短链、开发者基础设施
  "reddit.com",
  "t.co",
  "huggingface.co",
  "vercel.com",
  "netlify.com",
  "fly.io",
  "prisma.io",
  "pydantic.dev",
  "medium.com",
  "substack.com",
  "wordpress.com",
  "wix.com",
  "shopify.com",
  // AI 导航/目录站：是聚合页而非产品（原则 A1）
  "futuretools.io",
  "theresanaiforthat.com",
  "aitools.fyi",
  "futurepedia.io",
  "topai.tools",
  // 反复被相似站带出的非 AI 工具
  "larksuite.com",
  "kaggle.com",
  "zegocloud.com",
  "typeform.com",
  "notebooklm.google",
]);

/** SimilarWeb 类目是否属于 AI 相关（用于剔除非 AI 的相似站） */
const AI_CATEGORY_RE = /ai_|artificial|chatbot|generative|machine_learning/i;

/** 类目不可靠时，用描述兜底判断是否 AI 产品 */
const AI_DESC_RE = /\b(AI|A\.I\.|artificial intelligence|LLMs?|GPT|generative|machine learning|neural)\b/i;

/** SimilarWeb 类目关键词 → 站点分类 */
const CATEGORY_RULES: [RegExp, AIToolCategory][] = [
  [/chatbot|chat_|_chat/, "AI Chat"],
  [/coding|developer|programming/, "Coding"],
  [/image|photo|graphic|design/, "Image Gen"],
  [/video|streaming/, "Video"],
  [/audio|music|voice|speech|podcast/, "Voice & Audio"],
  [/market|advertis|seo|ecommerce/, "Marketing"],
  [/analytic|data|statistic|research/, "Data & Analytics"],
  [/writ|content|publish|blog/, "Writing"],
  [/automat|workflow|integration/, "Automation"],
  [/productiv|business|office|project/, "Productivity"],
];

function intFlag(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** cursor.com → Cursor；chatpdf.io → Chatpdf */
function nameFromDomain(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** 精确命中或子域命中（gemini.google.com 属于 google.com） */
function isExcluded(dom: string): boolean {
  if (EXCLUDED.has(dom)) return true;
  for (const e of EXCLUDED) if (dom.endsWith(`.${e}`)) return true;
  return false;
}

function mapCategory(raw?: string): AIToolCategory[] {
  if (!raw) return ["Other"];
  for (const [re, cat] of CATEGORY_RULES) if (re.test(raw)) return [cat];
  return ["Other"];
}

/** 热度分：与现有数据量级（55~65）对齐 */
function heatFromVisits(visits: number): number {
  return Math.min(100, Math.max(30, Math.round(40 + Math.log10(visits + 1) * 5)));
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const seedLimit = intFlag("--seeds", 60);
  const minVisits = intFlag("--min-visits", 5000);
  // 单次运行最多查询的候选数：每 12 个约 1 分钟，控制在这里便于一次跑完
  const maxCand = intFlag("--max-cand", 60);

  const tools = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  const known = new Set(tools.map((t) => t.domain));
  const knownNames = new Set(tools.map((t) => t.name.toLowerCase()));

  // 种子按流量降序，用 --seed-offset 分批推进，避免每轮都从同一批种子开始
  const seedOffset = intFlag("--seed-offset", 0);
  // 高流量种子挖完后可下调门槛（如 3000）继续拿候选
  const seedMin = intFlag("--seed-min", 10000);
  const seeds = tools
    .filter((t) => (t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits ?? 0) >= seedMin)
    .sort(
      (a, b) =>
        (b.trafficMetrics?.monthlyVisits ?? b.metrics?.monthlyVisits ?? 0) -
        (a.trafficMetrics?.monthlyVisits ?? a.metrics?.monthlyVisits ?? 0),
    )
    .slice(seedOffset, seedOffset + seedLimit)
    .map((t) => t.domain);

  console.log(`[similar] 种子 ${seeds.length} 个，开始拉取相似站点…`);
  const seedRaw = await fetchLergassyMulti(seeds);

  // domain -> 来源站（用于 sourceUrl 溯源）；affinity 用于优先查询最相似的站
  const candidates = new Map<string, string>();
  const affinity = new Map<string, number>();
  for (const [seed, raw] of seedRaw) {
    if (!raw) continue;
    for (const s of raw.similarSites ?? []) {
      const dom = s.domain?.toLowerCase();
      if (!dom || known.has(dom) || isExcluded(dom)) continue;
      if (!candidates.has(dom)) candidates.set(dom, seed);
      affinity.set(dom, Math.max(affinity.get(dom) ?? 0, s.affinity ?? 0));
    }
  }

  const ordered = [...candidates.keys()]
    .sort((a, b) => (affinity.get(b) ?? 0) - (affinity.get(a) ?? 0))
    .slice(0, maxCand);
  console.log(`[similar] 去重后候选 ${candidates.size} 个，本轮查询最相似的 ${ordered.length} 个…`);

  if (ordered.length === 0) {
    console.log("[similar] 无候选");
    return;
  }

  const rawMap = await fetchLergassyMulti(ordered);

  const now = new Date().toISOString();
  const picked: AITool[] = [];

  for (const [dom, source] of candidates) {
    const raw = rawMap.get(dom);
    if (!raw) continue;
    const metrics = extractTrafficMetrics(raw);
    if (!metrics.monthlyVisits || metrics.monthlyVisits < minVisits) continue;

    // 只收 AI 相关站点：相似站点会带出社区、短链、开发者基础设施等噪声
    const isAI = AI_CATEGORY_RE.test(raw.category ?? "") || AI_DESC_RE.test(raw.description ?? "");
    if (!isAI) continue;

    const name = nameFromDomain(dom);
    if (knownNames.has(name.toLowerCase())) continue;

    const tool: AITool = {
      id: `tool-sw-${slug(dom)}`,
      name,
      domain: dom,
      url: `https://${dom}`,
      description: (raw.description ?? "").slice(0, 120) || `${name}（月访问 ${metrics.monthlyVisits.toLocaleString()}）`,
      descriptionSource: "source",
      categories: mapCategory(raw.category),
      heatScore: heatFromVisits(metrics.monthlyVisits),
      phUpvotes: null,
      phComments: null,
      firstSeenAt: now,
      collectedAt: now,
      verified: "pending",
      sourceType: "directory",
      sourceUrl: `https://${source}`,
    };
    applyTraffic(tool, raw, metrics);
    picked.push(tool);
  }

  picked.sort((a, b) => (b.trafficMetrics?.monthlyVisits ?? 0) - (a.trafficMetrics?.monthlyVisits ?? 0));

  console.log(`[similar] 达标（月访问 ≥${minVisits}）${picked.length} 个：`);
  picked.slice(0, 15).forEach((t) => {
    console.log(
      `  ${t.domain.padEnd(22)} ${(t.trafficMetrics?.monthlyVisits ?? 0).toLocaleString().padStart(12)}  ${t.categories.join("/")}`,
    );
  });

  if (dry) {
    console.log("[similar] dry-run，未写入");
    return;
  }
  const merged = [...tools, ...picked];
  const tmp = `${TOOLS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, TOOLS_PATH);
  console.log(`[similar] 已写入：${tools.length} → ${merged.length} 站`);
}

main().catch((e) => {
  console.error("[similar] 异常：", e);
  process.exit(1);
});