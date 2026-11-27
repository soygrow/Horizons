// 成稿：模板生成中文正文，不调用任何付费模型。
// 硬规则：只写材料能支持的事实；数字一律来自 raw，不估算、不润色、不补全。
//
// 只发已核验的条目（见 score.ts 的 allocate）：缺一手材料的内容不进成稿，
// 页面上也就不会出现「待核实」这种让读者起疑的标签。

import { dailyConfig } from "./config";
import type { Allocation, Scored } from "./score";
import type { BodyResult } from "./sources/body";
import type {
  Digest,
  DailySummary,
  DigestItem,
  DigestSource,
  ModuleKey,
  RawDigest,
  RawItem,
} from "./types";

const FEED_LABEL: Record<string, string> = {
  theverge: "The Verge",
  arstechnica: "Ars Technica",
  "bbc-tech": "BBC 科技",
  "mit-tech-review": "MIT 科技评论",
  "openai-blog": "OpenAI 官方博客",
  "deepmind-blog": "DeepMind 官方博客",
  "huggingface-blog": "Hugging Face 博客",
};

const MODULE_WHY: Record<ModuleKey, string> = {
  headline: "当天影响面较大的一条，先看原始发布有没有给出可复现数据——标题里的规模数字通常不等于你自己的收益。",
  tools: "可以直接拿到手用，先看许可证和最近一次提交时间，这两项比 Star 数更能说明它还在不在维护。",
  money: "价格与融资会直接改成本线，先按官方条款重算自己的单价，再谈要不要迁移。",
  action: "今天就能验证，成本可控，失败也只是浪费半小时。",
};

/**
 * 「为什么值得关注」按角度细分：同一模块里的多条新闻如果共用一句话，
 * 读者一眼就能看出是模板，反而降低可信度。角度从标题里判，判不出才退回模块句。
 */
const WHY_BY_ANGLE: Record<string, string> = {
  research: "偏方法与研究结论，值得看的是它给出了什么可复现的判据，而不是一句结论。",
  pricing: "价格直接改成本线，先按官方条款重算自己的单价，再谈要不要迁移。",
  policy: "规则变化影响的是可用范围，先确认它约束的是训练、发布还是调用。",
  release: "发布类消息，先分清官方给的是基准还是演示——演示通常跑不出同样的数。",
  incident: "事故类消息，先看影响面与官方是否给出根因，避免被转述带偏。",
};

function angleOf(item: RawItem): string | null {
  // 只看标题：放在摘要里判会把 "paperclip" 认成论文，把 "cash flow" 认成定价
  const text = item.title.toLowerCase();
  if (/\bhow we\b|\bresearch\b|\bpaper\b|\bstudy\b|benchmark|detect|misalign|evaluat/.test(text))
    return "research";
  if (/pricing|\bprice|\bcost|billing|per token|free tier/.test(text)) return "pricing";
  if (/policy|regulation|\bban\b|\blaw\b|compliance|terms of service/.test(text)) return "policy";
  if (/outage|incident|breach|leak|vulnerab|exploit/.test(text)) return "incident";
  if (/release|launch|weights|available|announc|introduc|update/.test(text)) return "release";
  return null;
}

/** 标题里判不出角度时，按类别给一句：比模块通用句更贴，也不至于每条雷同 */
const WHY_BY_CATEGORY: Record<string, string> = {
  model_release: "能力边界可能变了，先看官方有没有给出可复现的基准，而不只是看演示。",
  product_launch: "产品形态变了，先弄清它替代的是工作流里的哪一步。",
  ai_coding: "写代码或写文档的入口又变了一步，先看它对你现有流程是替代还是叠加。",
  ai_agent: "自动化边界前移，重点看权限隔离，以及失败之后能不能回滚。",
  open_source: "可以直接下载来跑，先看许可证和最近提交，Star 数不说明维护状态。",
  business: "钱在换方向，但截图和转述要等官方条款确认，别先改自己的报价。",
};

/** 页面上的中文类别名（与站点 CATEGORY_LABEL 同口径，写死在脚本里以免跨包依赖） */
const CATEGORY_ZH: Record<string, string> = {
  model_release: "模型发布",
  product_launch: "产品发布",
  open_source: "开源项目",
  ai_agent: "智能体",
  ai_coding: "AI 编程",
  business: "商业化",
  other: "其他",
};

function beijingTime(iso: string | null): string {
  if (!iso) return "时间未知";
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: dailyConfig.timezone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(new Date(iso)).replace(/\//g, "-");
}

function sourceTypeOf(item: RawItem): DigestSource["type"] {
  if (item.source === "github") return "repo";
  if (item.source === "hackernews") return "community";
  return item.firstHand ? "official" : "media";
}

function sourceOf(item: RawItem): DigestSource {
  const type = sourceTypeOf(item);
  let label: string;
  if (item.source === "github") {
    label = `GitHub · ${item.sourceItemId}`;
  } else if (item.source === "hackernews") {
    label = `Hacker News · ${item.signals.points ?? 0} 分`;
  } else {
    const feed = typeof item.raw.feed === "string" ? item.raw.feed : "";
    label = FEED_LABEL[feed] ?? feed ?? "RSS";
  }
  return { type, label, url: item.url, verified: item.firstHand };
}

/** 截断到词边界，避免出现 "and r" 这种半截单词 */
function excerpt(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** 从正文提炼导语：优先在句末截断，避免半截句子 */
function leadFromBody(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  const space = cut.lastIndexOf(" ");
  const at = sentence > max * 0.5 ? sentence + 1 : space > max * 0.6 ? space : max;
  return `${clean.slice(0, at).replace(/[。.；;!！\s]+$/, "").trim()}…`;
}

function compact(n: number): string {
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`;
  if (n >= 1_000) return Math.round(n).toLocaleString("en-US");
  return String(n);
}

function domainOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** 事实摘要：优先用抓到的正文导语，兜底搬运 raw 里存在的数字 */
function summarize(item: RawItem, ev: Scored["ev"], content?: string | null): string {
  const parts: string[] = [];
  const extra = ev.items.length - 1;

  if (item.source === "github") {
    const description =
      typeof item.raw.description === "string"
        ? item.raw.description.replace(/\s+/g, " ").replace(/[。.；;!！\s]+$/, "").trim()
        : "";
    const language = typeof item.raw.language === "string" ? item.raw.language : "";
    const license = typeof item.raw.license === "string" ? item.raw.license : "";
    const createdAt = typeof item.raw.createdAt === "string" ? item.raw.createdAt.slice(0, 10) : null;
    const stars = item.signals.stars ?? 0;
    const perDay = item.signals.starPerDay ?? 0;
    const delta = item.signals.starDelta ?? 0;

    parts.push(
      `仓库 ${item.sourceItemId}${description ? `：${excerpt(description, 90)}` : ""}。` +
        `当前 ${compact(stars)} Star，${createdAt ? `创建于 ${createdAt}，` : ""}` +
        `平均每日新增约 ${compact(perDay)} Star`,
    );
    if (delta > 0) parts.push(`本次采样较上次 +${delta}`);
    const meta = [language, license ? `许可证 ${license}` : ""].filter(Boolean).join(" · ");
    if (meta) parts.push(meta);
  } else if (item.source === "hackernews") {
    // 分数与评论数已经显示在条目顶部，正文不再重复
    parts.push(`外链指向 ${domainOf(item.url)} 的原文，讨论发生在 Hacker News 评论区`);
  } else {
    const feed = typeof item.raw.feed === "string" ? item.raw.feed : "";
    const published = beijingTime(item.publishedAt);
    const summary = typeof item.raw.summary === "string" ? item.raw.summary : "";
    if (content) {
      // 抓到正文就用原文导语，信息密度高于 feed 摘要残片
      parts.push(`${FEED_LABEL[feed] ?? feed ?? "RSS"} ${published} 原文：${leadFromBody(content, 140)}`);
    } else if (summary) {
      parts.push(
        `${FEED_LABEL[feed] ?? feed ?? "RSS"} ${published} 的原文摘要：${excerpt(summary, 120)}`,
      );
    } else {
      parts.push(`${FEED_LABEL[feed] ?? feed ?? "RSS"} 于 ${published} 发布`);
    }
  }

  if (extra > 0) parts.push(`另有 ${extra} 条相关链接同时出现`);
  return parts.join("；").replace(/；$/, "") + "。";
}

/**
 * 每条只写两句话：summary = 发生了什么，why = 所以呢。
 * 只发已核验的条目，所以不再产出「还缺什么」；证据状态也不再挂在页面上
 * —— 全部都有一手出处，逐条标「已核验」等于给每行都盖同一个章。
 */
function toDigestItem(s: Scored, moduleKey: ModuleKey, content?: string | null): DigestItem {
  const primary = s.ev.items[0];
  const angle = angleOf(primary);
  const reason =
    (angle && WHY_BY_ANGLE[angle]) || WHY_BY_CATEGORY[s.category] || MODULE_WHY[moduleKey];
  return {
    id: s.ev.id,
    title: primary.title,
    summary: summarize(primary, s.ev, content),
    why: reason,
    category: s.category,
    evidence: s.evidence,
    score: s.score,
    heat: s.heat,
    firstSeenAt: primary.firstSeenAt,
    sources: s.ev.items.map(sourceOf),
    signals: {
      ...(primary.signals.points !== undefined ? { points: primary.signals.points } : {}),
      ...(primary.signals.comments !== undefined ? { comments: primary.signals.comments } : {}),
      ...(primary.signals.stars !== undefined ? { stars: primary.signals.stars } : {}),
      ...(primary.signals.starDelta !== undefined ? { starDelta: primary.signals.starDelta } : {}),
      ...(primary.signals.starPerDay !== undefined ? { starPerDay: primary.signals.starPerDay } : {}),
    },
    ...(content ? { content: content.slice(0, 2000) } : {}),
  };
}

/** 取第一句，用于总结里的一句话要点 */
function firstSentence(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const m = clean.match(/^[^。！？]*[。！？]/);
  const first = (m ? m[0] : clean).replace(/[。！？]$/, "").trim();
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/**
 * HN 条目的摘要是「外链指向 X 的原文，讨论发生在 Hacker News 评论区」——
 * 一句结构说明，放进总结等于什么都没说。这类条目只当补充，不当要点。
 */
function substantive(item: DigestItem): boolean {
  return !item.summary.startsWith("外链指向");
}

/**
 * 一期总结：页面第一屏就是这三两句话。
 *
 * 只做归纳，不引入新材料：条数、类别分布、模块构成都直接来自本期条目，
 * 换成生成模型反而容易在总结里补出原文没有的判断。
 */
function composeBrief(modules: Array<{ key: ModuleKey; items: DigestItem[] }>): DailySummary {
  const all = modules.flatMap((m) => m.items);
  const countOf = (key: ModuleKey): number =>
    modules.find((m) => m.key === key)?.items.length ?? 0;
  const zh = (key: string) => CATEGORY_ZH[key] ?? "其他";

  const tally = new Map<string, number>();
  for (const item of all) tally.set(item.category, (tally.get(item.category) ?? 0) + 1);
  const topCats = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, n]) => `${zh(key)} ${n} 条`);

  // 第一句要指出「今天最值得看的一件事」，只报数量等于没说重点
  const first = countOf("headline") > 0
    ? modules.find((m) => m.key === "headline")?.items[0]
    : all[0];
  const opener = first
    ? `今天最值得先看的是 ${first.sources[0]?.label ?? "一条官方消息"}的 ${zh(first.category)}消息`
    : "";

  const tools = countOf("tools");
  const money = countOf("money");
  const action = countOf("action");
  const parts: string[] = [];
  if (topCats.length > 0) parts.push(`${topCats.join("、")}，是变动最集中的方向`);
  if (tools > 0) parts.push(`${tools} 个能直接上手的项目`);
  if (money > 0) parts.push(`${money} 条成本或定价变化`);
  if (action > 0) parts.push(`${action} 个当天就能验证的动作`);

  const lead =
    (opener ? `${opener}。` : "") +
    `整期 ${all.length} 条：${parts.join("；")}。每条都有一手出处，点开链接就能核对。`;

  const order: ModuleKey[] = ["headline", "tools", "money", "action"];
  const points = order
    .flatMap((key) => modules.find((m) => m.key === key)?.items ?? [])
    .filter(substantive)
    .slice(0, 3)
    .map((item) => {
      const where = item.sources[0]?.label
        ? `${zh(item.category)} · ${item.sources[0].label}`
        : zh(item.category);
      return `${where}：${firstSentence(item.why)}`;
    });

  return { lead, points };
}

export function composeDigest(input: {
  date: string;
  raw: RawDigest;
  totalEvents: number;
  allocation: Allocation;
  generatedAt?: string;
  /** 事件 id → 抓到的正文（可缺省，缺省时摘要退回 feed 残片） */
  bodies?: Map<string, BodyResult>;
}): Digest {
  const modules = input.allocation.modules.map((m) => ({
    key: m.key,
    items: m.items.map((s) => {
      const body = input.bodies?.get(s.ev.id);
      const content = body?.status === "ok" && body.text ? body.text : null;
      return toDigestItem(s, m.key, content);
    }),
  }));

  const published = modules.reduce((n, m) => n + m.items.length, 0);
  const verified = modules.reduce(
    (n, m) => n + m.items.filter((i) => i.evidence === "verified").length,
    0,
  );

  return {
    date: input.date,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stats: {
      candidates: input.raw.items.length,
      merged: input.totalEvents,
      verified,
      published,
    },
    brief: composeBrief(modules),
    modules,
    sourceHealth: input.raw.sources,
  };
}