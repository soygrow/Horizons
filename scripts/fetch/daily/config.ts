// 每日情报：采集配置（全部为免费公开来源）
// 关键词只负责「发现候选」，是否入选由后续 verify + score 决定。

import "../config"; // 副作用导入：加载 .env.local（GITHUB_TOKEN 等）

export interface RssSource {
  name: string;
  url: string;
  /** 官方博客/公告视为一手材料 */
  firstHand?: boolean;
}

export const dailyConfig = {
  /** 时区固定为北京时间，日报按这个时区的「今天」归档 */
  timezone: "Asia/Shanghai",
  /** 回看窗口：覆盖前一晚，避免 05:00 跑任务时漏掉欧美白天发布的内容 */
  lookbackHours: 30,
  /** 单期最多保留候选条数，防止免费接口被过度使用 */
  maxCandidates: 320,

  hackernews: {
    /** 只按分数拉窗口内全部候选，再本地做 AI 相关性过滤 */
    minPoints: 25,
    hitsPerPage: 100,
    maxPages: 2,
  },

  github: {
    /** 每个 topic 两次查询：活跃榜（最近在动）+ 新星榜（新建且涨得快） */
    topics: ["llm", "ai-agents", "mcp", "llm-inference", "ai-coding", "text-to-image"],
    active: { pushedWithinDays: 7, minStars: 200, perQuery: 8 },
    fresh: { createdWithinDays: 120, minStars: 80, perQuery: 8 },
    /** 采样历史保留次数（用于算 Star 增量） */
    keepSamples: 14,
  },

  rss: [
    { name: "theverge", url: "https://www.theverge.com/rss/index.xml" },
    { name: "arstechnica", url: "https://feeds.arstechnica.com/arstechnica/index" },
    { name: "bbc-tech", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
    { name: "openai-blog", url: "https://openai.com/news/rss.xml", firstHand: true },
    { name: "huggingface-blog", url: "https://huggingface.co/blog/feed.xml", firstHand: true },
  ] as RssSource[],
};

/** 关键词 → 模块粗分类，只用于打标签，不决定是否入选 */
export const keywordGroups: Record<string, string[]> = {
  model_release: ["model", "llm", "release", "开源模型", "模型发布", "weights"],
  ai_agent: ["agent", "智能体", "mcp", "tool use", "workflow"],
  ai_coding: ["coding", "code assistant", "copilot", "ide", "programming"],
  product_launch: ["launch", "launched", "now available", "beta", "上线", "开放"],
  open_source: ["open source", "github", "开源", "self-hosted", "mit license"],
  business: ["funding", "raises", "acquisition", "pricing", "api price", "融资", "收购", "降价"],
};

/** GitHub Token：匿名也能用，但限流严重；个人 PAT 免费且额度高得多 */
export function githubToken(): string | null {
  return process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
}

/** 北京时间「今天」，YYYY-MM-DD */
export function todayInTimezone(timezone = dailyConfig.timezone): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}