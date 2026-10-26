import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { getDomain } from "tldts";
import type { AITool } from "@horizons/shared";
import { getProductHuntToken, config } from "../config";

// 大厂 / 平台域名：通常是模型发布或官方公告，不是独立 AI 工具产品
const EXCLUDED_DOMAINS = new Set([
  "openai.com",
  "anthropic.com",
  "google.com",
  "blog.google",
  "deepmind.google",
  "chatgpt.com",
  "microsoft.com",
  "meta.com",
  "apple.com",
  "github.com",
  "huggingface.co",
  "producthunt.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "medium.com",
  "youtube.com",
  "behance.net",
]);

// 建站平台 / 应用商店子域：多为学生项目与非 Web 产品
const EXCLUDED_SUFFIXES = [
  "vercel.app",
  "netlify.app",
  "github.io",
  "pages.dev",
  "workers.dev",
  "webflow.io",
  "wixsite.com",
  "weebly.com",
  "blogspot.com",
  "wordpress.com",
  "gumroad.com",
  "play.google.com",
  "apps.apple.com",
];

function isExcludedDomain(domain: string): boolean {
  if (EXCLUDED_DOMAINS.has(domain)) return true;
  return EXCLUDED_SUFFIXES.some((s) => domain === s || domain.endsWith("." + s));
}

// PH 的 website/url/productLinks 全是 /r/ 跳转，且被 Cloudflare 防护（服务端 403、
// headless 被挑战拦截），只有有头 Chrome 能穿透。故用 Playwright 有头模式解析域名。
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  try {
    browser = await chromium.launch({ headless: false, channel: "chrome" });
  } catch {
    browser = await chromium.launch({ headless: false });
  }
  return browser;
}

export async function closePHBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function resolveRedirect(url: string): Promise<string> {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(1500);
      const u = page.url();
      if (!u.includes("producthunt.com/r/")) return u;
    }
    return "";
  } catch {
    return "";
  } finally {
    await page.close();
  }
}

function cleanUrl(raw: string): string {
  const d = extractDomain(raw);
  return d ? `https://${d}` : raw;
}

function extractDomain(raw: string): string {
  try {
    const host = new URL(raw).hostname;
    return getDomain(host) || host;
  } catch {
    return "";
  }
}

function getToken(): string | null {
  try {
    const p = path.resolve(process.cwd(), ".ph-token.json");
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as { access_token?: string };
    if (data.access_token) return data.access_token;
  } catch {
    // 忽略，回退 Developer Token
  }
  return getProductHuntToken();
}

export async function fetchProductHuntTools(
  limit: number,
  order: "VOTES" | "NEWEST" = "VOTES",
  topic = "artificial-intelligence",
  existingNames: Set<string> = new Set(),
): Promise<AITool[]> {
  const token = getToken();
  if (!token) {
    console.log("[fetch] 未配置 PH 凭据，跳过 Product Hunt 抓取");
    return [];
  }

  interface PostNode {
    name: string;
    tagline: string;
    website: string;
    votesCount: number;
    commentsCount: number;
    createdAt: string;
    topics?: { edges?: Array<{ node: { name: string } }> };
  }

  const query = `
    query($first: Int!, $after: String) {
      posts(first: $first, after: $after, order: ${order}, topic: "${topic}") {
        pageInfo { endCursor hasNextPage }
        edges {
          node {
            name
            tagline
            website
            votesCount
            commentsCount
            createdAt
            topics { edges { node { name } } }
          }
        }
      }
    }
  `;

  // 翻页拉取（PH 单页约 20 条，用 endCursor 翻页直到 limit）
  const nodes: PostNode[] = [];
  let after: string | null = null;
  const pageSize = 20;
  while (nodes.length < limit) {
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
      },
      body: JSON.stringify({
        query,
        variables: { first: Math.min(pageSize, limit - nodes.length), after },
      }),
    });
    if (!res.ok) throw new Error(`Product Hunt 请求失败：${res.status}`);
    const data = (await res.json()) as {
      data?: {
        posts?: {
          pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
          edges?: Array<{ node: PostNode }>;
        };
      };
    };
    const posts = data?.data?.posts;
    const pageNodes = posts?.edges?.map((e) => e.node) ?? [];
    nodes.push(...pageNodes);
    if (!posts?.pageInfo?.hasNextPage || !posts?.pageInfo?.endCursor) break;
    if (pageNodes.length === 0) break;
    after = posts.pageInfo.endCursor;
  }

  // name 预筛：已收录的在解析域名前跳过，省浏览器时间
  const pending = nodes.filter((n) => !existingNames.has(n.name.toLowerCase()));
  console.log(
    `[fetch] PH(${order}, topic=${topic}) 翻页拉到 ${nodes.length} 条，新产品 ${pending.length} 个，开始解析域名...`,
  );

  const items: AITool[] = [];
  for (const node of pending) {
    const realUrl = await resolveRedirect(node.website);
    const domain = realUrl ? extractDomain(realUrl) : "";
    if (!domain || isExcludedDomain(domain)) {
      console.log(`[fetch] ${node.name}：域名 ${domain || "?"} 已排除，跳过`);
      continue;
    }

    const topics = (node.topics?.edges ?? []).map((e) => e.node.name).filter(Boolean);
    const now = new Date().toISOString();
    items.push({
      id: `tool-ph-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
      name: node.name.trim(),
      domain,
      url: cleanUrl(realUrl),
      description: (node.tagline ?? "").trim(),
      descriptionSource: "source",
      categories: ["Other"],
      topicSlugs: topics,
      industry: "人工智能",
      heatScore: Math.min(100, Math.round(Math.log10(node.votesCount + 1) * 20)),
      phUpvotes: node.votesCount,
      phComments: node.commentsCount,
      githubStars: null,
      launchedAt: node.createdAt,
      firstSeenAt: now,
      collectedAt: now,
      verified: "pending",
      sourceType: "producthunt",
      sourceUrl: node.website,
      phUrl: `https://www.producthunt.com/posts/${domain}`,
    });
    console.log(`[fetch] ${node.name} → ${domain}`);
  }

  return items;
}
