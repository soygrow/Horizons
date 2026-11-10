// 每日情报：采集配置（全部为免费公开来源）
// 关键词只负责「发现候选」，是否入选由后续 verify + score 决定。

import "../config"; // 副作用导入：加载 .env.local（GITHUB_TOKEN 等）

export interface RssSource {
  name: string;
  url: string;
  /** 官方博客/公告视为一手材料 */
  firstHand?: boolean;
  /**
   * 源权威度权重，乘在影响力上，默认 1。
   *
   * RSS 源没有 points / stars 这类组内信号，归一化后所有条目都拿 50 分，
   * 于是「个人博客的一条工具发布」和「官方模型发布」同权 —— 实测
   * 「Yonkers Rises」这种只有标题的随笔能进头条。个人博客给低于 1 的权重，
   * 让它在分数上与机构来源拉开差距。
   */
  authority?: number;
  /**
   * 只取 feed 的前 N 条，默认全取。
   *
   * 社区类源的日更量远大于媒体，全收进来会把 maxCandidates 挤满、
   * 把新闻类候选挤出榜单，必须截断。
   */
  maxItems?: number;
  /**
   * 覆盖默认 UA。
   *
   * Reddit 对未声明身份的客户端直接 403，它要求 UA 里带平台与联系方式，
   * 形如 `web:horizons.tools:v0.1 (by /u/xxx)`。沿用通用机器人 UA 反而更容易被拦。
   */
  userAgent?: string;
}

export const dailyConfig = {
  /** 时区固定为北京时间，日报按这个时区的「今天」归档 */
  timezone: "Asia/Shanghai",
  /** 回看窗口：覆盖前一晚，避免 05:00 跑任务时漏掉欧美白天发布的内容 */
  lookbackHours: 30,
  /** 单期最多保留候选条数，防止免费接口被过度使用 */
  maxCandidates: 500,

  hackernews: {
    /**
     * 只按分数拉窗口内全部候选，再本地做 AI 相关性过滤。
     *
     * 阈值从 25 降到 15：30 小时窗口里 25 分以上的帖子太少，AI 相关的一只手数得过来。
     * 降下来换量，靠 normalize.isAiRelevant 挡噪音 —— 它已经处理过
     * 「agent 命中移民新闻」这类误判，比单纯提高分数阈值更可靠。
     */
    minPoints: 15,
    hitsPerPage: 100,
    maxPages: 3,
  },

  github: {
    /** 每个 topic 两次查询：活跃榜（最近在动）+ 新星榜（新建且涨得快） */
    topics: ["llm", "ai-agents", "mcp", "llm-inference", "ai-coding", "text-to-image"],
    active: { pushedWithinDays: 7, minStars: 200, perQuery: 8 },
    fresh: { createdWithinDays: 120, minStars: 80, perQuery: 8 },
    /** 采样历史保留次数（用于算 Star 增量） */
    keepSamples: 14,
  },

  /**
   * RSS 源：7 个不够。30 小时窗口里 7 个源只能出 100 条上下候选，
   * 头条要凑 10 条就得把门槛一路降到 45 分，等于拿质量换数量。
   * 扩到 21 个源之后候选翻倍，门槛才能回到 62 以上。
   *
   * 三个层次分工明确：
   * - 综合媒体：转述为主，需要第二来源或官方材料才算 verified
   * - 垂直媒体/通讯：信息密度高，但仍是转述
   * - 官方博客（firstHand）：一手材料，直接 verified
   */
  rss: [
    // 综合科技媒体
    { name: "theverge", url: "https://www.theverge.com/rss/index.xml" },
    { name: "arstechnica", url: "https://feeds.arstechnica.com/arstechnica/index" },
    { name: "bbc-tech", url: "https://feeds.bbci.co.uk/news/technology/rss.xml" },
    { name: "mit-tech-review", url: "https://www.technologyreview.com/topic/artificial-intelligence/feed" },
    { name: "techcrunch-ai", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
    { name: "venturebeat-ai", url: "https://venturebeat.com/category/ai/feed/" },
    { name: "the-decoder", url: "https://the-decoder.com/feed/" },

    // AI 垂直通讯：分析与访谈为主，单条信息量高于综合媒体
    // 个人博客降到 0.7：他的 AI 分析值得看，但 feed 里混着大量自制小工具
    { name: "simon-willison", url: "https://simonwillison.net/tags/llms.atom", authority: 0.7 },
    { name: "latent-space", url: "https://www.latent.space/feed", authority: 0.85 },

    // 官方博客：一手材料
    { name: "openai-blog", url: "https://openai.com/news/rss.xml", firstHand: true },
    { name: "deepmind-blog", url: "https://deepmind.google/blog/rss.xml", firstHand: true },
    { name: "google-ai-blog", url: "https://blog.google/technology/ai/rss/", firstHand: true },
    { name: "google-research", url: "https://research.google/blog/rss/", firstHand: true },
    { name: "huggingface-blog", url: "https://huggingface.co/blog/feed.xml", firstHand: true },
    { name: "meta-engineering", url: "https://engineering.fb.com/feed/", firstHand: true },
    { name: "msr-blog", url: "https://www.microsoft.com/en-us/research/feed/", firstHand: true },
    { name: "aws-ml", url: "https://aws.amazon.com/blogs/machine-learning/feed/", firstHand: true },
    { name: "nvidia-blog", url: "https://blogs.nvidia.com/feed/", firstHand: true },

    // 中文源：国产模型与国内生态，英文源基本不覆盖
    { name: "qbitai", url: "https://www.qbitai.com/feed" },

    /*
     * 社区 / 首发榜。
     *
     * 这两个源的价值不在「权威」，而在「早」——r/LocalLLaMA 经常比媒体先
     * 半天出现一手实测，Product Hunt 是新产品首发处。
     * 但它们的日更量远大于媒体，且单条价值不稳定，
     * 所以统一用低权威度 + 截断，让它们补充而不主导排名。
     *
     * 不接 arXiv：论文是「方法出处」，不是「今天发生了什么」。它进头条突兀、
     * 进钱与机会更不对，在单独开「研究」区块之前先不收。
     *
     * Reddit 对未声明身份的客户端返回 403，按官方要求写清平台与联系方式；
     * 失败只记 note，不影响整轮。
     */
    {
      name: "reddit-localllama",
      url: "https://www.reddit.com/r/LocalLLaMA/.rss",
      authority: 0.75,
      maxItems: 60,
      userAgent: "web:horizons.tools:v0.1 (by /u/horizons_tools)",
    },
    { name: "producthunt-ai", url: "https://www.producthunt.com/feed?category=artificial-intelligence", authority: 0.6, maxItems: 40 },
  ] as RssSource[],
};

/**
 * 各模块的席位（每天最多收几条）。
 *
 * 头条从 4 提到 10：一条情报的价值密度靠「今天有几件事值得知道」撑起来，
 * 4 条经常只覆盖到最热的两三个模型发布。提高席位后分数门槛会自然下探，
 * 见 `allocate()` 里的三级兜底。
 *
 * 凑不满只告警、不阻止发布 —— 宁可某天少一条，也不为了填满席位放低准入线。
 */
export const digestQuota = {
  headline: 10,
  money: 3,
  tools: 5,
  action: 2,
} as const;

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