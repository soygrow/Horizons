import type { AITool, AIToolCategory } from "../../../src/lib/types";
import { extractDomain, truncate } from "../normalize";
import { config } from "../config";

interface GithubRepo {
  full_name: string;
  name: string;
  html_url: string;
  homepage?: string | null;
  description?: string | null;
  stargazers_count: number;
  created_at?: string;
  topics?: string[];
}

function mapCategories(topics: string[] = []): AIToolCategory[] {
  const joined = topics.join(" ").toLowerCase();
  const cats = new Set<AIToolCategory>();
  if (/chat|gpt|llm|chatbot|assistant|conversation|rag|prompt/.test(joined))
    cats.add("AI Chat");
  if (/image|diffusion|stable|photo|picture|text-to-image|img2img/.test(joined))
    cats.add("Image Gen");
  if (/video|movie|animation|text-to-video/.test(joined)) cats.add("Video");
  if (/audio|voice|tts|speech|sound|music|text-to-speech/.test(joined))
    cats.add("Voice & Audio");
  if (/writing|writer|content|copy|summar|translate/.test(joined))
    cats.add("Writing");
  if (/coding|code|developer|programming|ide|cli|sdk/.test(joined))
    cats.add("Coding");
  if (/automation|workflow|pipeline|orchestr/.test(joined))
    cats.add("Automation");
  if (/marketing|seo|sales|ads|crm/.test(joined)) cats.add("Marketing");
  if (/productivity|task|todo|workspace|note|ppt|slides|presentation|doc|pdf/.test(joined))
    cats.add("Productivity");
  if (/data|analytics|database|sql|machine-learning|deep-learning/.test(joined))
    cats.add("Data & Analytics");
  if (cats.size === 0) cats.add("Other");
  return [...cats].slice(0, 3);
}

function heatFromStars(stars: number): number {
  return Math.min(100, Math.round(Math.log10(stars + 1) * 20));
}

/**
 * 从 GitHub API 发现开源 AI 工具（官方接口，匿名可用，低频访问）。
 * 只保留有独立官网（homepage 域名非 github）的仓库，保证 domain 是纯域名。
 */
export async function fetchGithubTools(limit: number): Promise<AITool[]> {
  const results: AITool[] = [];

  for (const query of config.github.queries) {
    if (results.length >= limit) break;
    // 请求较大候选池，过滤（minStars + 独立官网）后再取前 limit 个
    const perPage = 10;
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${perPage}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": config.userAgent,
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) throw new Error(`GitHub 请求失败：${res.status}`);
    const data = (await res.json()) as { items?: GithubRepo[] };

    for (const repo of data.items ?? []) {
      if (results.length >= limit) break;
      if ((repo.stargazers_count ?? 0) < config.github.minStars) continue;

      const domain = repo.homepage ? extractDomain(repo.homepage) : "";
      if (
        !domain ||
        domain.endsWith("github.io") ||
        domain.startsWith("github.com")
      ) {
        continue; // 只收录有独立官网的工具
      }

      const now = new Date().toISOString();
      results.push({
        id: `tool-gh-${repo.full_name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
        name: repo.name,
        domain,
        url: repo.homepage || repo.html_url,
        description: truncate(repo.description ?? "", 300),
        categories: mapCategories(repo.topics ?? []),
        topicSlugs: repo.topics ?? [],
        launchedAt: repo.created_at,
        heatScore: heatFromStars(repo.stargazers_count ?? 0),
        githubStars: repo.stargazers_count ?? 0,
        phUpvotes: null,
        firstSeenAt: now,
        collectedAt: now,
        verified: "pending",
        sourceType: "github",
        sourceUrl: repo.html_url,
      });
    }
  }

  return results;
}
