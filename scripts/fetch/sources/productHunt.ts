import dns from "node:dns/promises";
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
/** 连续这么多条浏览器都解析失败，就认定出口 IP 被拦，本轮不再尝试 */
const BROWSER_FAIL_STREAK_LIMIT = 2;

// PH 的 website/url/productLinks 全是 /r/ 跳转，且被 Cloudflare 防护（服务端 403、
// headless 被挑战拦截）。解析顺序：
//   1. 有头 Chrome（本地住宅 IP 能过挑战；配了 PH_PROXY 时 CI 也能过）
//   2. 读一次 302 的 Location 头（成本低，偶尔能捞回来）
//   3. 按产品名 / PH slug 推断域名 + 页面校验（零依赖兜底，命中率约四到五成）
// 拿不准的一律丢弃，不写进队列 —— 宁缺毋滥。
let browser: Browser | null = null;

/** 住宅代理，形如 http://user:pass@host:port。填了之后有头 Chrome 走代理，CI 里也能过挑战 */
function proxyConfig(): { server: string; username?: string; password?: string } | undefined {
  const raw = process.env.PH_PROXY?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    console.warn("[fetch] PH_PROXY 格式不对，已忽略（应形如 http://user:pass@host:port）");
    return undefined;
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  const proxy = proxyConfig();
  try {
    browser = await chromium.launch({ headless: false, channel: "chrome", ...(proxy ? { proxy } : {}) });
  } catch {
    browser = await chromium.launch({ headless: false, ...(proxy ? { proxy } : {}) });
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

/** 归一化：小写 + 去掉一切非字母数字，用于「标题里是否含产品名」这类模糊比较 */
const normKey = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** 域名停放/出售页：这类站能探活通过，但内容是错的，必须挡掉 */
const PARKED_PAGE =
  /this domain (is|may be) for sale|buy this domain|domain (is )?parked|(该)?网站正在出售|域名(出售|转让|待售)|该域名[^<]{0,10}(出售|转让)/i;

/**
 * 多词产品名里，首词经常被无关大站占着（"Inbox Zero" → inbox.com 是付费邮箱）。
 * 命中的词一律不做首词候选，只认全名。
 */
const GENERIC_FIRST_WORDS = new Set([
  "product", "inbox", "glass", "beam", "cloud", "data", "smart", "open", "free",
  "best", "super", "mega", "chat", "note", "team", "work", "flow", "space",
  "stack", "labs", "studio", "tools", "agent", "agents", "app", "apps",
]);

/**
 * 词边界匹配：`The Glass Hand` 不算命中 `Glasshand`，但 `Pancake` 算命中 `Pancake`。
 *
 * 用单纯的「包含」判断会被拆词写法骗过 —— glasshand.app 就是这么混进候选的，
 * 它其实是另一个同名产品，跟 PH 上那个「给 agent 一台真 iPhone」毫无关系。
 */
function hasPhrase(text: string, phrase: string): boolean {
  const hay = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const want = phrase.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (want.length === 0 || hay.length < want.length) return false;
  outer: for (let i = 0; i + want.length <= hay.length; i++) {
    for (let j = 0; j < want.length; j++) {
      if (hay[i + j] !== want[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * 生成「候选域名 + 对应的校验片段」。
 *
 * 两者一一对应：出首词候选时也只拿首词去校验，避免「域名按首词猜、校验靠全名」
 * 这种自欺欺人的组合。
 */
function guessPlan(name: string, slug: string): { domains: string[]; phrases: string[] } {
  const bases = new Set<string>();
  const phrases: string[] = [];

  const full = normKey(name);
  if (full.length >= 3) {
    bases.add(full);
    phrases.push(name.trim());
  }

  // 首词只对多词名有意义（单词名的 full 已覆盖），且要求够长、不是通用词：
  // 这条规则挡掉的正是 inbox.com / product.ai 那类误判。
  const words = name.split(/\s+/).filter(Boolean);
  const first = normKey(words[0] ?? "");
  if (words.length > 1 && first.length >= 6 && first !== full && !GENERIC_FIRST_WORDS.has(first)) {
    bases.add(first);
    phrases.push(words[0]);
  }

  const fromSlug = normKey(slug);
  if (fromSlug.length >= 3 && !bases.has(fromSlug)) {
    bases.add(fromSlug);
    phrases.push(slug);
  }

  const tlds = ["com", "ai", "io", "app", "co"];
  const domains: string[] = [];
  for (const b of bases) for (const t of tlds) domains.push(`${b}.${t}`);
  return { domains: domains.slice(0, 15), phrases };
}

/**
 * 探活 + 内容校验：title / og:site_name / h1 里必须按词边界出现名字片段。
 *
 * 只看标题区，不看正文：正文太容易蒙对，停放页和同名大站都能凑出关键词。
 */
async function verifyCandidate(domain: string, phrases: string[]): Promise<boolean> {
  try {
    await dns.lookup(domain);
  } catch {
    return false; // 域名不存在，省掉一次 HTTP
  }

  try {
    const res = await fetch(`https://${domain}/`, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": config.userAgent, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return false;

    const html = (await res.text()).slice(0, 120_000);
    if (PARKED_PAGE.test(html)) return false;

    const title = html.match(/<title[^>]*>([^<]{1,200})/i)?.[1] ?? "";
    const ogSite =
      html.match(/property=["']og:site_name["'][^>]*content=["']([^"']{1,120})/i)?.[1] ?? "";
    const h1 = html.match(/<h1[^>]*>([^<]{1,150})/i)?.[1] ?? "";

    const head = `${title} ${ogSite} ${h1}`;
    return phrases.some((p) => hasPhrase(head, p));
  } catch {
    return false;
  }
}

/**
 * 兜底解析：/r/ 短链拿不到时，按名字/slug 推断域名。
 *
 * 实测（12 条真实 PH 榜单）命中 7 条且全部正确，另外 5 条丢弃。命中率约六成，
 * 换来的是「进队列的域名都对得上产品」——其余交给人工，不从 PH 硬凑。
 */
export async function guessDomain(name: string, slug: string): Promise<string> {
  const { domains, phrases } = guessPlan(name, slug);
  if (phrases.length === 0) return "";

  // 5 个一批并发：绝大多数候选 DNS 就直接挂了，真正发 HTTP 的通常不超过 3 个
  for (let i = 0; i < domains.length; i += 5) {
    const batch = domains.slice(i, i + 5);
    const hits = await Promise.all(
      batch.map(async (d) => ((await verifyCandidate(d, phrases)) ? d : "")),
    );
    const hit = hits.find(Boolean);
    if (hit) return hit;
  }
  return "";
}

/**
 * 取 PH 的 slug 作为名字的规范形态："TheySaid 4.0" → theysaid。
 * 尾部数字是 PH 给重名产品加的后缀（"pancake-7"），推断域名时要剥掉。
 */
function slugOf(node: { slug?: string; url?: string }): string {
  const raw = node.slug || node.url?.match(/\/(?:products|posts)\/([^/?#]+)/)?.[1] || "";
  return raw.replace(/-\d+$/, "");
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
  /** PH 帖子页，形如 https://www.producthunt.com/products/wanaka-studio/launches/... */
  url: string;
  /** 产品 slug（"wanaka-studio"、"pancake-7"），推断域名时比名字干净 */
  slug: string;
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
            url
            slug
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
  let viaGuess = 0;
  /** 有头浏览器连续失败次数：没配代理时它在 CI 里必然过不了挑战，触发后本轮跳过 */
  let browserFailStreak = 0;

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

      // PH 官方的 MCP / Launch 等条目不是第三方产品，域名也推不出来，直接跳过
      if (/product hunt/i.test(node.name)) {
        skippedBlocked++;
        console.log(`[fetch] ${node.name}：Product Hunt 自家条目，跳过`);
        continue;
      }

      if (existingNames.has(node.name.toLowerCase())) {
        skippedName++;
        continue;
      }

      let realUrl = "";

      // 第 1 层：有头 Chrome。连续失败说明当前出口 IP 过不了挑战（CI 常见），
      // 再逐条白等 20 秒只会把一轮采集拖到十几分钟，索性本轮不再尝试。
      if (browserFailStreak < BROWSER_FAIL_STREAK_LIMIT) {
        const r = await resolveRedirect(node.website);
        if (r.url) {
          realUrl = r.url;
          browserFailStreak = 0;
        } else {
          browserFailStreak++;
          if (browserFailStreak === BROWSER_FAIL_STREAK_LIMIT) {
            console.warn(
              "[fetch] 有头浏览器连续解析失败，判定当前出口 IP 被 Cloudflare 拦，本轮改用推断；" +
                "要恢复精确解析请配置 PH_PROXY（住宅代理）",
            );
          }
        }
      }

      // 第 2 层：直接读 302 的 Location
      if (!realUrl) realUrl = await resolveRedirectViaHeader(node.website);

      // 第 3 层：按名字/slug 推断 + 校验
      if (!realUrl) {
        const guessed = await guessDomain(node.name, slugOf(node));
        if (guessed) {
          realUrl = `https://${guessed}`;
          viaGuess++;
        }
      }

      if (!realUrl) {
        skippedNoDomain++;
        console.log(`[fetch] ${node.name}：域名解析不到（浏览器/302/推断均失败），跳过`);
        continue;
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
        phUrl: node.url,
      });
      console.log(`[fetch] ${node.name} → ${domain}`);
    }

    if (!posts?.pageInfo?.hasNextPage || !posts?.pageInfo?.endCursor) break;
    after = posts.pageInfo.endCursor;
  }

  console.log(
    `[fetch] PH(${order}, topic=${topic}) 翻 ${pages} 页扫 ${scanned} 条，产出 ${items.length}/${limit}` +
      `｜name已存在 ${skippedName}｜未解析出域名 ${skippedNoDomain}｜黑名单 ${skippedBlocked}｜域名已收录 ${skippedSeen}` +
      `｜推断命中 ${viaGuess}`,
  );

  return items;
}