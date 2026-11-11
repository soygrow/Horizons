import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { getDomain } from "tldts";
import type { AITool } from "@horizons/shared";
import { getProductHuntToken, config } from "../config";
import { isExcludedHost } from "../../admin/verdict";

/** 名单唯一真源在 scripts/admin/verdict.ts，与后台判定/发布共用 */
function isExcludedDomain(domain: string): boolean {
  return isExcludedHost(domain);
}

/**
 * 单条跳转的等待预算。
 *
 * 原来 12 × 1.5s = 18s，且失败与成功走同一条路径，一轮 60 条要 20 分钟以上。
 * 正常情况下 /r/ 是 302，一次跳转就到，1 秒内足够；这里留 8 次给慢一点的。
 */
const REDIRECT_POLL_MS = 900;
const REDIRECT_POLL_TIMES = 8;
const REDIRECT_GOTO_TIMEOUT_MS = 15_000;

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

/** 解析不出来的原因。日志必须能区分「黑名单拦掉」和「压根没拿到域名」 */
type RedirectFailure = "goto_error" | "not_redirected";

interface RedirectResult {
  /** 跳转后的真实 URL；为空表示失败 */
  url: string;
  failure?: RedirectFailure;
}

async function resolveRedirect(url: string): Promise<RedirectResult> {
  let page: Page | null = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
  } catch {
    return { url: "", failure: "goto_error" };
  }

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: REDIRECT_GOTO_TIMEOUT_MS });
    for (let i = 0; i < REDIRECT_POLL_TIMES; i++) {
      await page.waitForTimeout(REDIRECT_POLL_MS);
      const u = page.url();
      if (!u.includes("producthunt.com/r/")) return { url: u };
    }
    return { url: "", failure: "not_redirected" };
  } catch {
    return { url: "", failure: "goto_error" };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 浏览器路径失败后的兜底：直接读一次 302 的 Location 头。
 *
 * PH 对服务端请求通常回 403，成功率不高，但成本只有一次 fetch，
 * 而且在 CI 里有头 Chrome 被挑战页挡住时，这条路偶尔还能捞回来几条。
 */
async function resolveRedirectViaHeader(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": config.userAgent },
    });
    const loc = res.headers.get("location") ?? "";
    if (!loc) return "";
    const target = new URL(loc, url);
    if (target.hostname.endsWith("producthunt.com")) return "";
    return target.toString();
  } catch {
    return "";
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

interface PostNode {
  name: string;
  tagline: string;
  website: string;
  votesCount: number;
  commentsCount: number;
  createdAt: string;
  topics?: { edges?: Array<{ node: { name: string } }> };
}

interface PostPage {
  pageInfo?: { endCursor?: string | null; hasNextPage?: boolean };
  edges?: Array<{ node: PostNode }>;
}

/**
 * 抓 Product Hunt 新工具。
 *
 * `limit` 是**产出数**（解析成功且未被排除的条数），不是翻页条数 ——
 * 凑够就停，不再像以前那样先拉 `count + 已收录数` 条候选回来逐条解析。
 * 那种写法在库里有 300 多个工具时等于每轮拉 376 条、解析 60 条以上，
 * 且失败一条要白等 18 秒。
 *
 * `seenDomains` 会被就地写入：已收录/已拒绝的域名直接在这里挡掉，
 * 省得回到调用方再筛一遍、还得为了筛而多抓。
 *
 * `maxScan` 只防 PH 返回异常页时死循环，正常路径不会碰到。
 */
export async function fetchProductHuntTools(
  limit: number,
  order: "VOTES" | "NEWEST" = "VOTES",
  topic = "artificial-intelligence",
  existingNames: Set<string> = new Set(),
  seenDomains: Set<string> = new Set(),
  maxScan?: number,
): Promise<AITool[]> {
  const token = getToken();
  if (!token) {
    console.log("[fetch] 未配置 PH 凭据，跳过 Product Hunt 抓取");
    return [];
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

  const pageSize = 20;
  /** 上限只兜底用：正常凑够 limit 会提前 break */
  const scanCap = maxScan ?? Math.min(Math.max(limit * 8, 120), 600);

  const items: AITool[] = [];
  let after: string | null = null;
  let scanned = 0;
  let pages = 0;
  let skippedName = 0;
  let skippedNoDomain = 0;
  let skippedBlocked = 0;
  let skippedSeen = 0;

  while (items.length < limit && scanned < scanCap) {
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
      },
      body: JSON.stringify({
        query,
        variables: { first: pageSize, after },
      }),
    });
    if (!res.ok) throw new Error(`Product Hunt 请求失败：${res.status}`);

    const data = (await res.json()) as { data?: { posts?: PostPage } };
    const posts = data?.data?.posts;
    const pageNodes = posts?.edges?.map((e) => e.node) ?? [];
    if (pageNodes.length === 0) break;

    pages++;
    scanned += pageNodes.length;
    console.log(
      `[fetch] 第 ${pages} 页：${pageNodes.length} 条，已产出 ${items.length}/${limit}`,
    );

    for (const node of pageNodes) {
      if (items.length >= limit) break;
      if (existingNames.has(node.name.toLowerCase())) {
        skippedName++;
        continue;
      }

      let realUrl = "";
      const r = await resolveRedirect(node.website);
      if (r.url) {
        realUrl = r.url;
      } else {
        realUrl = await resolveRedirectViaHeader(node.website);
        if (!realUrl) {
          skippedNoDomain++;
          console.log(
            `[fetch] ${node.name}：域名解析失败（${
              r.failure === "not_redirected" ? "/r/ 未跳转，可能被挑战页挡住" : "打开链接报错"
            }），跳过`,
          );
          continue;
        }
      }

      const domain = extractDomain(realUrl);
      if (!domain) {
        skippedNoDomain++;
        console.log(`[fetch] ${node.name}：跳转后仍取不到域名（${realUrl}），跳过`);
        continue;
      }
      if (isExcludedDomain(domain)) {
        skippedBlocked++;
        console.log(`[fetch] ${node.name}：域名 ${domain} 命中黑名单，跳过`);
        continue;
      }
      if (seenDomains.has(domain)) {
        skippedSeen++;
        console.log(`[fetch] ${node.name}：域名 ${domain} 已在库，跳过`);
        continue;
      }
      seenDomains.add(domain);

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

    if (!posts?.pageInfo?.hasNextPage || !posts?.pageInfo?.endCursor) break;
    after = posts.pageInfo.endCursor;
  }

  console.log(
    `[fetch] PH(${order}, topic=${topic}) 翻 ${pages} 页扫 ${scanned} 条，产出 ${items.length}/${limit}` +
      `｜name已存在 ${skippedName}｜未解析出域名 ${skippedNoDomain}｜黑名单 ${skippedBlocked}｜域名已收录 ${skippedSeen}`,
  );

  return items;
}