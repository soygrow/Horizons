import type { AITool } from "../../../src/lib/types";
import { getProductHuntToken, config } from "../config";

/**
 * Product Hunt GraphQL API（Developer Token / OAuth token 均可）。
 * 未配置 token 时返回空数组，不报错。
 *
 * 已知限制（2026-10-16 实测）：
 * 1. `website` / `productLinks` / `url` 全部返回 producthunt.com/r/xxx 跳转链接，
 *    而非真实域名，必须跟随重定向解析。
 * 2. 但 /r/ 跳转与 PH 产品页在服务端均被 Cloudflare 拦截（403），纯服务端无法
 *    拿到真实域名。因此当前环境下 PH 条目域名解析失败会被丢弃（贡献 0 条）。
 *    后续两条出路：① 走 OAuth 授权码流程换取带 scope 的 access token；
 *    ② 用 Playwright 无头浏览器带 JS 打开 /r/ 链接拿真实 URL。
 * 3. 待真实域名可解析后，本适配器无需改动即可自动生效（resolveRedirect 已具备）。
 */
export async function fetchProductHuntTools(limit: number): Promise<AITool[]> {
  const token = getProductHuntToken();
  if (!token) {
    console.log("[fetch] 未配置 PH_TOKEN，跳过 Product Hunt 抓取");
    return [];
  }

  const query = `
    query($first: Int!) {
      posts(first: $first, order: VOTES) {
        edges {
          node {
            name
            tagline
            website
            votesCount
            createdAt
            topics { edges { node { name } } }
          }
        }
      }
    }
  `;

  const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": config.userAgent,
    },
    body: JSON.stringify({ query, variables: { first: limit } }),
  });

  if (!res.ok) throw new Error(`Product Hunt 请求失败：${res.status}`);
  const data = (await res.json()) as {
    data?: {
      posts?: {
        edges?: Array<{
          node: {
            name: string;
            tagline: string;
            website: string;
            votesCount: number;
            createdAt: string;
            topics?: { edges?: Array<{ node: { name: string } }> };
          };
        }>;
      };
    };
  };

  const items: AITool[] = [];
  for (const edge of data?.data?.posts?.edges ?? []) {
    const node = edge.node;

    // website 是 PH 跳转链接，解析真实域名
    const realUrl = await resolveRedirect(node.website);
    const domain = realUrl ? extractDomainSafe(realUrl) : "";
    if (!domain || domain === "producthunt.com") continue;

    const topics = (node.topics?.edges ?? [])
      .map((e) => e.node.name)
      .filter(Boolean);
    const now = new Date().toISOString();
    items.push({
      id: `tool-ph-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
      name: node.name.trim(),
      domain,
      url: realUrl,
      description: (node.tagline ?? "").trim(),
      categories: ["Other"],
      topicSlugs: topics,
      heatScore: Math.min(100, Math.round(Math.log10(node.votesCount + 1) * 20)),
      phUpvotes: node.votesCount,
      githubStars: null,
      launchedAt: node.createdAt,
      firstSeenAt: now,
      collectedAt: now,
      verified: "pending",
      sourceType: "producthunt",
      sourceUrl: node.website,
    });
  }

  return items;
}

/** 跟随重定向解析真实 URL（HEAD 优先，失败降级 GET），失败返回空串 */
async function resolveRedirect(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": config.userAgent },
    });
    if (res.url && !res.url.includes("producthunt.com/r/")) return res.url;
  } catch {
    // HEAD 失败时降级 GET
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": config.userAgent },
      });
      if (res.url && !res.url.includes("producthunt.com/r/")) return res.url;
    } catch {
      return "";
    }
  }
  return "";
}

function extractDomainSafe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}
