import fs from "node:fs";
import path from "node:path";
import type {
  AITool,
  AiInsight,
  Observations,
  OpportunityScore,
  MonetizationBlueprint,
  GrowthPlaybook,
  BuildBlueprint,
  IdeaSpark,
  ModuleInsight,
  TagGroup,
} from "@horizons/shared";
import "./config"; // 加载 .env.local
import { config, getProductHuntToken } from "./config";
import {
  fetchHome,
  auditSite,
  fetchRegistrationDate,
  detectPaymentSignals,
} from "./sources/site-audit";
import { detectPricing } from "./sources/pricing";
import {
  hasDataForSEO,
  fetchKeywords,
  fetchGeoDistribution,
  fetchTrafficHistory,
  fetchBacklinksSummary,
  fetchCompetitors,
  fetchRelatedKeywords,
} from "./sources/dataforseo";
import { chatJSON, hasLLM } from "./sources/llm";

/**
 * 单站增强管线：为指定域名的工具补齐 V5/V6 详情页数据（自建爬虫 + DataForSEO + PH + LLM）。
 * 用法：pnpm tsx scripts/fetch/enrich-site.ts --domain picvo.ai [--dry]
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");
const CATEGORIES = [
  "AI Chat", "Image Gen", "Video", "Voice & Audio", "Writing", "Coding",
  "Automation", "Marketing", "Productivity", "Data & Analytics", "Other",
] as const;

const ANALYTICS_LABELS = new Set([
  "Google Analytics", "Google Tag Manager", "Amplitude", "Segment",
  "Hotjar", "Plausible", "Fathom", "Mixpanel", "PostHog", "Clarity", "Sentry",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseDomain(): string {
  const i = process.argv.indexOf("--domain");
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1].toLowerCase();
  return "picvo.ai";
}

function loadTools(): AITool[] {
  try {
    return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  } catch {
    return [];
  }
}

function saveTools(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

/** PH 单站搜索（best-effort，失败返回 null） */
async function searchPH(name: string): Promise<{
  votes: number;
  comments: number;
  createdAt?: string;
} | null> {
  const token = getProductHuntToken();
  if (!token) return null;
  const query = `
    query($search: String!) {
      posts(first: 10, search: $search) {
        edges { node { name votesCount commentsCount createdAt } }
      }
    }`;
  try {
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": config.userAgent,
      },
      body: JSON.stringify({ query, variables: { search: name } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { posts?: { edges?: Array<{ node: { name: string; votesCount: number; commentsCount: number; createdAt: string } }> } };
    };
    const nodes = data?.data?.posts?.edges?.map((e) => e.node) ?? [];
    const hit =
      nodes.find((n) => n.name.toLowerCase() === name.toLowerCase()) ??
      nodes.find((n) => n.name.toLowerCase().includes(name.toLowerCase().replace(/\s+/g, ""))) ??
      nodes[0];
    if (!hit) return null;
    return { votes: hit.votesCount, comments: hit.commentsCount, createdAt: hit.createdAt };
  } catch {
    return null;
  }
}

/** 组装给 LLM 的数据摘要 */
function buildInput(tool: AITool, extra: Record<string, unknown>): string {
  return JSON.stringify(
    {
      name: tool.name,
      domain: tool.domain,
      url: tool.url,
      ...extra,
    },
    null,
    2,
  );
}

/* ------------------------------- LLM prompts ------------------------------- */

const SYSTEM_BASIC = `你是 AI 工具目录的资深编辑，面向"想创业的个人开发者"写作。根据工具信息输出 JSON：
- descriptionZh: ≤40 字中文一句话描述（做什么、给谁用）；
- segmentLabel: 6~12 字细分赛道，如「AI 视频生成」；
- categories: 从 ${CATEGORIES.join("/")} 选 1~3 个（按贴合度排序）；
- featureTags: 3 个卖点标签（如「品牌驱动」「All In One」「多语言」）；
- categoryTags: 8~12 个品类词（如「视频制作」「AI 视频生成器」「文字转视频」）；
- tagGroups: 数组，元素 {label, values: string[]}，label 取「变现方式」「SEO 打法」「成熟度信号」「使用模型」「模型家族」等（有多少给多少，values 各 3~15 个）。
只输出 JSON。`;

const SYSTEM_INSIGHT = `你是面向个人开发者创业者的 AI 产品分析师。基于给定的真实采集数据（流量/关键词/技术栈/收款信号/页面结构），输出客观、可执行的解读。输出 JSON：
- aiInsight: {question,intro,before,now,comparison,audiences[3],hooks[{title,desc}×4],willingness{level:"低"|"中等"|"高",score:1|2|3,reason},growthDriver,acquisition,trafficQuality,moat,moatBadge,monetization,monetizationBadge}
  其中 before/now/comparison 是「以前/现在/相比之下」三段；growthDriver 讲增长驱动；acquisition 讲获客打法；moat 讲竞争壁垒（moatBadge 一个 2~6 字标签）；monetization 讲收费模式（monetizationBadge 如「证据明确」）。
- observations: {practices[3~4],concerns[2~3],competitors[4~6 个域名]}
- moduleInsights: {performance:{analysis,soWhat},growth:{analysis,soWhat},keywords:{analysis,soWhat},competition:{analysis,soWhat}}
  其中 performance/growth/keywords/competition 分别对应「产品表现/增长趋势/关键词需求/竞争格局」四个数据模块；analysis 是客观解读（引用具体数字），soWhat 是一句「这对创业者意味着什么」的结论（30 字内）。
只输出 JSON。`;

const SYSTEM_OPPORTUNITY = `你是面向个人开发者创业者的创业顾问。基于给定数据，输出「这个赛道/产品值不值得入场」的行动建议。输出 JSON：
- opportunity: {score:0~100, verdict:"值得入场"|"谨慎"|"别碰", reason:一句话结论, dimensions:[{label,score:0~100,note}×5]}，5 个维度固定为「竞争度」「变现成熟度」「增长可复制性」「技术门槛」「启动成本」。要求：每个 note 必须引用给定数据里的具体数值（如流量、关键词数、外链数、注册时间、技术栈、收款信号），给出准确、可验证的判断，不要泛泛而谈。
- monetizationBlueprint: {model,tiers[string],paymentDetected[string],pricingAdvice}
- growthPlaybook: {coldStart,channels[string],copyable[string 值得抄],avoid[string 是坑别踩]}
- buildBlueprint: {techStack[string],thirdParty[string 依赖的API/模型],mvpScope,devTime,monthlyCost}
- ideaSparks: [{title,angle,why,source}×3~5]，angle 取「换场景/换人群/换商业模式/换语区/换收费」，每个给创业者一个可落地的变体点子；source 是「灵感来源」，说明这个点子是基于哪个数据点或竞品特征得来的（如「源自它的多语言页面打法」）。
只输出 JSON。`;

/* --------------------------------- 主流程 --------------------------------- */

async function main(): Promise<void> {
  const domain = parseDomain();
  const dry = process.argv.includes("--dry");
  console.log(`[enrich-site] 目标：${domain}${dry ? "（dry-run）" : ""}`);

  const tools = loadTools();
  const tool = tools.find((t) => t.domain === domain);
  if (!tool) {
    console.error(`[enrich-site] 未找到 ${domain}，请先收录该工具`);
    process.exit(1);
  }

  // 1) 自建爬虫：页面结构 + 技术栈 + 收款信号 + 定价线索 + RDAP 注册时间
  let pageStructure = tool.pageStructure;
  let siteAudit = tool.siteAudit;
  let paymentDetected: string[] = [];
  let registeredAt = tool.metrics?.registeredAt;
  let homeHtml = "";
  try {
    const { html, headers, finalUrl } = await fetchHome(tool.url);
    homeHtml = html;
    const audit = auditSite(html, headers, finalUrl);
    pageStructure = audit.pageStructure;
    siteAudit = audit.siteAudit;
    paymentDetected = audit.paymentDetected;
    // 收款信号：首页 + 定价页联合检测（首页可能未嵌入支付 SDK）
    const morePayment = await detectPaymentSignals(tool.url, html);
    paymentDetected = [...new Set([...paymentDetected, ...morePayment])];
    // 注册时间：RDAP 优先（对 .ai 等 ccTLD 比 DFS whois 准）
    const rdapDate = await fetchRegistrationDate(domain);
    if (rdapDate) registeredAt = rdapDate;
    console.log(
      `[enrich-site] 爬虫：tech=${siteAudit.techStack?.join("/") || "—"}｜收款=${paymentDetected.join("/") || "—"}｜注册=${registeredAt ?? "—"}｜H1~H3=${pageStructure.h1?.length}/${pageStructure.h2?.length}/${pageStructure.h3?.length}`,
    );
  } catch (e) {
    console.warn("[enrich-site] 爬虫失败：", e instanceof Error ? e.message : e);
  }

  // 定价线索
  if (homeHtml) {
    try {
      const pricing = await detectPricing(tool.url, homeHtml);
      if (pricing?.length) {
        siteAudit = { ...(siteAudit ?? {}), pricingClues: pricing.map((p) => p.price) };
      }
    } catch {
      /* ignore */
    }
  }

  // 从 techStack 分离分析工具
  if (siteAudit?.techStack?.length) {
    const analytics = siteAudit.techStack.filter((t) => ANALYTICS_LABELS.has(t));
    const tech = siteAudit.techStack.filter((t) => !ANALYTICS_LABELS.has(t));
    siteAudit = { ...siteAudit, techStack: tech, analytics };
  }

  // 2) DataForSEO：流量（clickstream）/ 关键词 / 排名分布 / 外链 / 竞品 / 相关关键词
  // 注：DFS 只能提供「搜索流量」口径（clickstream_etv），总访问量/渠道占比无来源 → 不采集、不展示
  let metrics = tool.metrics;
  let trend = tool.trend;
  let keywords = tool.keywords;
  let geo = tool.geoDistribution;
  let backlinks = tool.backlinks;
  let competitors = tool.observations?.competitors ?? [];
  let relatedKeywords = tool.relatedKeywords ?? [];
  let searchTraffic = tool.searchTraffic;
  let keywordCount = tool.keywordCount;
  let rankDistribution = tool.rankDistribution ?? [];

  if (hasDataForSEO()) {
    try {
      const [kw, g, histResult, bk, comps] = await Promise.all([
        fetchKeywords(domain, 10),
        fetchGeoDistribution(domain),
        fetchTrafficHistory(domain),
        fetchBacklinksSummary(domain),
        fetchCompetitors(domain, 8),
      ]);
      const hist = histResult.history;
      // 月搜索流量 = 最新一个月的 clickstream_etv（比普通 etv 更接近真实）
      const last = hist[hist.length - 1];
      const organic = last?.organic ?? 0;
      const paid = last ? last.total - last.organic : 0;
      const total = last?.total ?? 0;
      searchTraffic = { organic, paid };

      const momGrowth = (() => {
        if (hist.length < 2) return undefined;
        const prev = hist[hist.length - 2].total;
        const lastTotal = hist[hist.length - 1].total;
        if (prev < 1 || lastTotal < 1) return undefined; // 流量过小，环比无意义
        if (prev <= 0) return undefined;
        return Math.round(((lastTotal - prev) / prev) * 1000) / 10;
      })();

      metrics = {
        monthlyVisits: total,
        organicVisits: organic,
        momGrowth,
        domainWeight: bk?.domainWeight,
        registeredAt, // 优先 RDAP
      };
      trend = hist;
      keywords = kw;
      geo = g;
      keywordCount = histResult.keywordCount;
      rankDistribution = histResult.rankDistribution;
      backlinks = bk && bk.total > 0
        ? {
            total: bk.total,
            totalDofollowShare: bk.totalDofollowShare,
            refDomains: bk.refDomains,
            refDofollowShare: bk.refDofollowShare,
          }
        : undefined;
      if (comps.length) competitors = comps;
      console.log(
        `[enrich-site] DFS：月搜索流量=${total}（自然 ${organic} / 付费 ${paid}）｜关键词 ${kw.length}｜排名词 ${keywordCount}｜国家 ${g.length}｜外链 ${bk?.total ?? "—"}｜竞品 ${comps.length}`,
      );
    } catch (e) {
      console.warn("[enrich-site] DataForSEO 失败：", e instanceof Error ? e.message : e);
    }

    // 相关关键词（基于品牌词 + 域名主体）
    try {
      const brand = domain.split(".")[0];
      const rkw = await fetchRelatedKeywords([brand, `${brand} ai`], 15);
      if (rkw.length) relatedKeywords = rkw;
      console.log(`[enrich-site] 相关关键词：${rkw.length} 个`);
    } catch {
      /* ignore */
    }
  } else {
    console.log("[enrich-site] 未配置 DataForSEO 凭据，跳过流量/关键词/外链/竞品");
  }

  // 3) Product Hunt 信号
  let phUpvotes = tool.phUpvotes;
  let phComments = tool.phComments;
  try {
    const ph = await searchPH(tool.name);
    if (ph) {
      phUpvotes = ph.votes;
      phComments = ph.comments;
      if (ph.createdAt) tool.launchedAt = ph.createdAt;
      console.log(`[enrich-site] PH：votes=${ph.votes} comments=${ph.comments}`);
    }
  } catch {
    /* ignore */
  }

  // 4) LLM 生成（三次调用）
  if (!hasLLM()) {
    console.error("[enrich-site] 未配置 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  const inputData = {
    // 只喂「我们自己采集的真实数据」，不喂任何哥伦布种子字段
    officialTitle: pageStructure?.title,
    officialDescription: pageStructure?.metaDescription,
    metrics,
    trend: trend?.slice(-7),
    keywords: keywords?.slice(0, 10),
    relatedKeywords: relatedKeywords?.slice(0, 15),
    keywordCount,
    rankDistribution,
    geo,
    backlinks: backlinks
      ? { total: backlinks.total, refDomains: backlinks.refDomains, dofollow: backlinks.totalDofollowShare }
      : null,
    competitors,
    siteAudit,
    pageStructure: pageStructure
      ? { title: pageStructure.title, h1: pageStructure.h1, h2: pageStructure.h2, h3: pageStructure.h3 }
      : null,
    paymentDetected,
    phUpvotes,
    phComments,
  };

  // 调用 1：基础标签
  const basic = await chatJSON<{
    descriptionZh?: string;
    segmentLabel?: string;
    categories?: string[];
    featureTags?: string[];
    categoryTags?: string[];
    tagGroups?: TagGroup[];
  }>(SYSTEM_BASIC, buildInput(tool, inputData));
  if (basic.descriptionZh) {
    tool.description = basic.descriptionZh;
    tool.descriptionSource = "ai";
  }
  if (basic.segmentLabel) tool.segmentLabel = basic.segmentLabel;
  if (basic.categories?.length) {
    tool.categories = basic.categories.filter((c): c is AITool["categories"][number] =>
      (CATEGORIES as readonly string[]).includes(c),
    );
  }
  tool.featureTags = basic.featureTags ?? [];
  tool.categoryTags = basic.categoryTags ?? [];
  tool.tagGroups = basic.tagGroups ?? [];
  await sleep(300);
  console.log(`[enrich-site] LLM#1 基础：${tool.description}`);

  // 调用 2：AI 解读 + 观察（完全替换，不保留旧值）
  const insight = await chatJSON<{
    aiInsight?: AiInsight;
    observations?: Observations;
    moduleInsights?: ModuleInsight;
  }>(SYSTEM_INSIGHT, buildInput(tool, inputData), 6000);
  if (insight.aiInsight) {
    tool.aiInsight = {
      ...insight.aiInsight,
      analyzedAt: new Date().toISOString().slice(0, 7),
    };
  }
  if (insight.moduleInsights) tool.moduleInsights = insight.moduleInsights;
  if (insight.observations) tool.observations = insight.observations;
  await sleep(300);
  console.log("[enrich-site] LLM#2 解读完成");

  // 调用 3：创业洞察
  const opp = await chatJSON<{
    opportunity?: OpportunityScore;
    monetizationBlueprint?: MonetizationBlueprint;
    growthPlaybook?: GrowthPlaybook;
    buildBlueprint?: BuildBlueprint;
    ideaSparks?: IdeaSpark[];
  }>(SYSTEM_OPPORTUNITY, buildInput(tool, inputData), 6000);
  if (opp.opportunity) tool.opportunity = opp.opportunity;
  if (opp.monetizationBlueprint) {
    tool.monetizationBlueprint = {
      ...opp.monetizationBlueprint,
      paymentDetected: opp.monetizationBlueprint.paymentDetected?.length
        ? opp.monetizationBlueprint.paymentDetected
        : paymentDetected,
    };
  }
  if (opp.growthPlaybook) tool.growthPlaybook = opp.growthPlaybook;
  if (opp.buildBlueprint) tool.buildBlueprint = opp.buildBlueprint;
  if (opp.ideaSparks?.length) tool.ideaSparks = opp.ideaSparks;
  console.log("[enrich-site] LLM#3 创业洞察完成");

  // 写回
  tool.metrics = metrics;
  tool.trend = trend;
  tool.keywords = keywords;
  tool.geoDistribution = geo;
  tool.backlinks = backlinks;
  tool.relatedKeywords = relatedKeywords;
  tool.searchTraffic = searchTraffic;
  tool.keywordCount = keywordCount;
  tool.rankDistribution = rankDistribution;
  tool.pageStructure = pageStructure;
  tool.siteAudit = siteAudit;
  tool.phUpvotes = phUpvotes;
  tool.phComments = phComments;
  // 真实竞品优先于 LLM 猜的竞品
  if (competitors.length) {
    tool.observations = { ...(tool.observations ?? {}), competitors };
  }
  // DFS 无法提供渠道占比（全渠道）：清空，不采集不展示
  tool.channelShares = undefined;
  tool.dataSnapshot = {
    period: new Date().toISOString().slice(0, 7),
    syncedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  tool.collectedAt = new Date().toISOString();

  if (dry) {
    console.log("[enrich-site] dry-run，未写入");
  } else {
    saveTools(tools);
    console.log(`[enrich-site] 已写入 ${domain}`);
  }
}

main().catch((e) => {
  console.error("[enrich-site] 失败：", e);
  process.exit(1);
});
