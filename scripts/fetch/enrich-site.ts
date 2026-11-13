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
  PerformanceInsight,
  TagGroup,
  TrafficDecrypt,
} from "@horizons/shared";
import "./config"; // 加载 .env.local
import { config, getProductHuntToken } from "./config";
import {
  fetchHome,
  auditSite,
  fetchRegistrationDate,
  detectPaymentSignals,
  estimateRevenueSignal,
} from "./sources/site-audit";
import { detectPricing } from "./sources/pricing";
import { extractContact } from "./sources/contact";
import { chatJSON, hasLLM } from "./sources/llm";
import { collectSite } from "../field-collect/collect";
import { applyFields } from "./apply-fields";
import { readTrafficMonths } from "./collect-store";
import { readWorkspace, syncCandidates, type ItemStatus } from "../admin/board-items";

/**
 * 单站增强管线：为指定域名的工具补齐 V5/V6 详情页数据（自建爬虫 + field-collect + PH + LLM）。
 * 用法：pnpm tsx scripts/fetch/enrich-site.ts --domain picvo.ai [--dry]
 */

/** --staging：对后台待发布队列（D1 的 board_items）做富化，不碰线上数据 */
const USE_STAGING = process.argv.includes("--staging");
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

async function loadTools(): Promise<AITool[]> {
  if (USE_STAGING) {
    const { items } = await readWorkspace<AITool>("tools");
    return items;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as
      | AITool[]
      | { items?: AITool[] };
    return Array.isArray(raw) ? raw : (raw.items ?? []);
  } catch {
    return [];
  }
}

async function saveTools(tools: AITool[]): Promise<void> {
  if (!USE_STAGING) {
    fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
    return;
  }
  // 候选池在 D1：只回写当前这一条。整队列重灌会覆盖后台刚做的确认/拒绝
  const domain = parseDomain();
  const tool = tools.find((t) => t.domain === domain) as (AITool & { stage?: string }) | undefined;
  if (!tool) return;
  await syncCandidates("tools", [
    {
      itemKey: domain,
      name: tool.name,
      url: tool.url ?? `https://${domain}`,
      // stage 沿用库里的现值，富化只更新卡片内容
      status: (tool.stage ?? "candidate") as ItemStatus,
      card: tool,
    },
  ]);
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
- trafficDecrypt: {overview, sections:[{title,highlights[string×2],insight,takeaway}×3]}，这是「流量情况解密」报告，以「资深增长黑客与连续创业者」视角撰写，语言犀利、直戳本质，让读者有「原来如此」的顿悟感。
  overview 是「流量总览」一段话（定性这个盘的底子、命门与截胡窗口）；sections 固定 3 段，title 带 emoji 前缀与编号、保留小标题结构：
    📊 1. 流量趋势与结构（它是怎么活下来的？）／🌍 2. 地域分布（它在赚谁的钱？）／🔍 3. 搜索与排名（它的命门在哪？）。
  每段 highlights 给 2 个高光标签（如「点状爆发」「流量寄生」），insight 是数据洞察、takeaway 是创业启发，均须引用给定真实数据（趋势数值、channelShares 渠道占比、geo 国家份额、keywordCount 关键词量、seo.samples 实况排名、aiTraffic AI 引荐占比）。
  第 3 段必须基于 seo：samples 是实际抽样的关键词排名（position 为 null 表示未进前 20），top10/top20 是命中数，样本量少时用「采样」措辞，不要说成全站排名。rankDistribution 字段已下线，不要引用。
- observations: {practices[3~4],concerns[2~3],competitors[4~6 个域名]}
- moduleInsights: {performance:{analysis,soWhat},growth:{analysis,soWhat},keywords:{analysis,soWhat},competition:{analysis,soWhat}}
  其中 performance/growth/keywords/competition 分别对应「产品表现/增长趋势/关键词需求/竞争格局」四个数据模块；analysis 是客观解读（引用具体数字），soWhat 是一句「这对创业者意味着什么」的结论（30 字内）。
只输出 JSON。`;

const SYSTEM_OPPORTUNITY = `你是面向个人开发者创业者的创业顾问。基于给定数据，输出「这个赛道/产品值不值得入场」的行动建议。输出 JSON：
- opportunity: {score:0~100, verdict:"值得入场"|"谨慎"|"别碰", reason:一句话结论, dimensions:[{label,score:0~100,note}×5]}，5 个维度固定为「竞争度」「变现成熟度」「增长可复制性」「技术门槛」「启动成本」。要求：每个 note 必须引用给定数据里的具体数值（如流量、关键词数、外链数、注册时间、技术栈、收款信号），给出准确、可验证的判断，不要泛泛而谈。verdict 三档必须与 score 及 reason 自洽：值得入场（score≈70~100，需求真、竞争可打、变现可行）、谨慎（score≈40~69，正面竞争有风险但细分/垂直/差异化有机会）、别碰（score≈0~39，需求伪/赛道死/垄断或合规雷，连细分都不值得做）。
- monetizationBlueprint: {model,tiers[string],paymentDetected[string],pricingAdvice}
- growthPlaybook: {coldStart,channels[string],copyable[string 值得借鉴，用「借鉴/参考/沿用/复用」等表述，禁止出现「抄」字],avoid[string 是坑别踩]}
- buildBlueprint: {techStack[string],thirdParty[string 依赖的API/模型],mvpScope,devTime,monthlyCost}
- ideaSparks: [{title,angle,why,source}×6]，angle 从「换场景/换人群/换商业模式/换语区/换收费/换技术路线」中取，6 条的角度必须互不重复，每个给创业者一个可落地的变体点子。若该产品确实凑不出第 6 个真正有差异的方向，宁可只给 5 条，也绝不能为凑数而重复角度或写空话——质量优先于数量。source 是「灵感来源」，说明这个点子是基于哪个数据点或竞品特征得来的（如「源自它的多语言页面打法」）。
- performanceInsight: {overview:{what,pain,can,trait},wedge,model,moat,trafficTruth,growthEdge,newPlayerEntry,entryTag}
  · overview：顶部高光结论「产品画像四要素」，把产品讲清楚，不写反差口号、不写营销腔，各字段 20~50 字：
    - what「是什么」：一句话定义产品定位（做什么、给谁用、什么形态）；
    - pain「解决什么痛点」：目标人群苦于什么、它如何解决；
    - can「能干什么」：核心功能 / 能力清单（2~4 项）；
    - trait「特点」：差异化卖点或壁垒信号（如聚合多模型、免费额度、多语言）。
  · wedge：切入点（解决什么），产品形态帮谁解决什么；
  · model：商业模式与卖点（怎么赚钱），靠什么打动用户、怎么收钱；
  · moat：业务数据匹配度（护城河），结合自然搜索占比 / 直接访问占比 / 关键词采样排名 与 域名注册时间判断是真技术还是早期红利；不要引用域名权重（数据源已下线）。注意 registeredAt 是「域名首次注册」时间，老域名常被新产品收购（1999 年注册的域名可能对应 2024 年才上线的产品），不能直接当作产品年龄或团队资历，除非另有迹象支持；
  · trafficTruth：流量结构真相（用户从哪来），对比自然搜索与直接访问定性来源；
  · growthEdge：增长势能与软肋（生死局），结合访问量与增长率看爆发点与天花板；
  · newPlayerEntry：新玩家切入点（行动指南），方向必须与 opportunity.verdict 同档：
      - 值得入场 → 写怎么正面切入 / 照做 + 差异化优化点；
      - 谨慎 → 别正面照抄红海，写具体「切垂直细分 / 换人群 / 换语区」的截胡动作；
      - 别碰 → 写为什么别碰（需求伪、赛道死、垄断、合规雷等），不写切入建议、不鼓励入场。
  · entryTag：2~8 字结论标签，必须与 opportunity.verdict 同档、且与 newPlayerEntry 正文互相印证：
      - 值得入场 → 「值得入场」「值得入场·可照做」；
      - 谨慎 → 「谨慎·切细分」「可切细分」「避开正面·切细分」等，点明「细分可做、正面别碰」，禁止「强烈推荐」；
      - 别碰 → 「别碰」「不建议入场」，禁止出现「切细分」「推荐」等鼓励措辞。
  除 overview 外各字段 40~80 字，必须引用给定数据中的具体数值；全文禁止出现「抄」字。
只输出 JSON。`;

/* --------------------------------- 主流程 --------------------------------- */

/** 数据快照期数：按月采集，当前运行月份 - 1（如 10 月运行 → 快照为 2026-09 的数据） */
function lastPeriod(): string {
  const d = new Date();
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const domain = parseDomain();
  /** 只补免费字段：跳过付费采集（vortex/SERP）与 LLM，仅做页面抓取 + 体检 */
  const freeOnly = process.argv.includes("--free-only");
  const dry = process.argv.includes("--dry");
  /** 只补 AI 解读（aiInsight + 四模块 + 流量解密），跳过基础标签与创业洞察，省 token */
  const insightOnly = process.argv.includes("--insight-only");
  /** 只补创业洞察（performanceInsight / opportunity 等），跳过基础标签与解读 */
  const oppOnly = process.argv.includes("--opp-only");
  const analysisOnly =
    process.argv.includes("--analysis-only") || insightOnly || oppOnly;
  console.log(`[enrich-site] 目标：${domain}${dry ? "（dry-run）" : ""}`);

  const tools = await loadTools();
  const tool = tools.find((t) => t.domain === domain);
  if (!tool) {
    console.error(`[enrich-site] 未找到 ${domain}，请先收录该工具`);
    process.exit(1);
  }

  // 抓取相关变量（analysis-only 时保留 tool 中的最新值，供输入 LLM）
  let pageStructure = tool.pageStructure;
  let siteAudit = tool.siteAudit;
  let paymentDetected: string[] = [];
  let registeredAt = tool.metrics?.registeredAt;
  let homeHtml = "";
  let metrics = tool.metrics;
  let trend = tool.trend;
  // 候选池里的 card 没有 keywords 字段 → 这里是 undefined。
  // 后面「!keywords.some(...)」和遍历直接跪，DFS 未配置时每个站点都崩在这里。
  let keywords = tool.keywords ?? [];
  let geo = tool.geoDistribution;
  let backlinks = tool.backlinks;
  let competitors = tool.observations?.competitors ?? [];
  let searchTraffic = tool.searchTraffic;
  let keywordCount = tool.keywordCount;
  let phUpvotes = tool.phUpvotes;
  let phComments = tool.phComments;
  let pricingPlans = tool.pricing;
  /**
   * 本轮实际采到的快照月份（月度序列里最后一个有访问量的月）。
   * 不能拿「当前月 - 1」硬算：月初/月末跑会漂一个月，
   * 导致页面「数据快照」和 trafficMetrics 里的数是两个月份。
   */
  let collectedPeriod: string | undefined;

  if (!analysisOnly) {
  // 1) 自建爬虫：页面结构 + 技术栈 + 收款信号 + 定价线索 + RDAP 注册时间
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

  // 1.5) 截图不再单独启动浏览器：collectSite 内部用 Playwright 一次性拍好桌面 + 移动，
  //      这里复用它的产物，省一次 cold start（每站约 2~4 秒）。

  // 定价线索
  if (homeHtml) {
    try {
      const pricing = await detectPricing(tool.url, homeHtml);
      if (pricing?.length) {
        pricingPlans = pricing;
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

  // 2) 采集复用：field-collect 的 73 字段（vortex 已由准入付费，这里命中 collect_raw，$0）
  //
  // 与旧 DataForSEO 方案的区别：
  //   - DFS 给的是「搜索流量」口径，页面展示的是「总访问量」，两套数放一起必然对不上；
  //   - 同一个域名准入阶段已经买过 vortex 当月快照，再调 DFS 属于重复付费；
  //   - 渠道结构、国家分布、互动指标、AI 引荐这些 DFS 根本给不了。
  //
  // 免费模式跳过：collectSite 的免费步骤（爬虫）上面已经单独做过一遍了。
  if (!freeOnly) {
    try {
      const payload = await collectSite({
        url: tool.url,
        jobId: `enrich-${domain}-${Date.now()}`,
        persist: false,
      });
      const history = await readTrafficMonths(domain, { months: 6 });

      /*
       * 快照月份取「最后一个有访问量的月份」，不是序列末项。
       * vortex 会补一个当月但还没出数的空壳月份（visits 为 0 或缺失），
       * 直接取末项会让 monthlyVisits 是 10 月的值、snapshotMonth 却标成 11 月，
       * 后台与详情页的「数据快照」就跟采集结果对不上了。
       */
      const histField = payload.fields.find((f) => f.key === "monthly_visits_history");
      const lastMonth = Array.isArray(histField?.value)
        ? ([...histField.value] as { month?: string; visits?: number }[])
            .reverse()
            .find((m) => typeof m.visits === "number" && m.visits > 0)?.month
        : undefined;

      const applied = applyFields(tool, payload, {
        at: payload.collectedAt?.slice(0, 10),
        period: lastMonth,
        // 保留补 0 的月份：趋势图固定 6 格，滤掉就成了「有几个画几个」，
        // 新站会显得和老站一样完整。collected=false 让前端把空格画成待累积而不是掉到 0。
        history,
      });
      console.log(
        `[enrich-site] 字段映射：写入 ${applied.written.length} 项` +
          `${applied.skipped.length ? `｜保留原值 ${applied.skipped.join("/")}` : ""}` +
          `｜采集花费 ≈$${payload.cost?.total ?? 0}`,
      );

      // 两个视口分开判断：移动版拍失败时不能把已有的手机截图覆盖成空
      if (payload.screenshots.desktop) tool.screenshotDesktopUrl = payload.screenshots.desktop;
      if (payload.screenshots.mobile) tool.screenshotMobileUrl = payload.screenshots.mobile;
      if (payload.screenshots.desktop || payload.screenshots.mobile) {
        console.log("[enrich-site] 截图：复用 collectSite 产物");
      }

      /*
       * 关键词（含搜索量）一律以本轮采集为准。
       * 旧值是 DFS 时代的残留，不能因为它「有 volume」就挡住 vortex 刚写进来的结果 ——
       * 那样结尾的 `tool.keywords = keywords` 会把新关键词覆盖回旧数组。
       */
      if (tool.keywords?.length) {
        keywords = tool.keywords;
        keywordCount = tool.keywords.length;
      }

      /*
       * 这些局部变量在第 2) 步之前就取成了旧值，必须同步一次。
       * 否则结尾的 `tool.trend = trend` / `tool.geoDistribution = geo`
       * 会把 applyFields 刚写好的 6 个月趋势和地域分布覆盖回去 —— 明明采到了，页面还是空的。
       */
      trend = tool.trend;
      geo = tool.geoDistribution;
      backlinks = tool.backlinks;
      searchTraffic = tool.searchTraffic;
      keywordCount = tool.keywordCount ?? keywordCount;
      metrics = tool.metrics;
      collectedPeriod = lastMonth;
    } catch (e) {
      console.warn("[enrich-site] 采集复用失败：", e instanceof Error ? e.message : e);
    }
  } else {
    console.log("[enrich-site] 免费模式，跳过 Similarweb 采集复用");
  }

  // 3) Product Hunt 信号
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

  }

  // 3.5) 免费模式：只写回抓取与体检结果，跳过 DFS 与 LLM
  if (freeOnly) {
    tool.pageStructure = pageStructure;
    tool.siteAudit = siteAudit;
    if (siteAudit?.techStack?.length) tool.techStack = siteAudit.techStack;
    if (pricingPlans?.length) tool.pricing = pricingPlans;
    if (!tool.contact && homeHtml) {
      const c = extractContact(homeHtml, tool.url);
      if (c) tool.contact = c;
    }
    tool.collectedAt = new Date().toISOString();
    if (dry) {
      console.log(`[enrich-site] ${domain}：dry-run，免费字段未写入`);
    } else {
      await saveTools(tools);
      console.log(`[enrich-site] ${domain}：免费字段已写回`);
    }
    return;
  }

  // 4) LLM 生成（三次调用）
  if (!hasLLM()) {
    console.error("[enrich-site] 未配置 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  // 以最新 vortex 流量为准（analysis-only 时 legacy metrics 仍是旧值，必须覆盖）
  const tm = tool.trafficMetrics;
  const metricsForLLM = tm
    ?       {
        monthlyVisits: tm.monthlyVisits,
        organicVisits: tm.organicSearchVisits,
        organicShare:
          tm.monthlyVisits && tm.organicSearchVisits
            ? Math.round((tm.organicSearchVisits / tm.monthlyVisits) * 1000) / 10
            : undefined,
        directVisits: tm.directVisits,
        momGrowth: tm.monthlyVisitsGrowth,
        // 必须用本轮刚查到的（RDAP 优先）值：这里若读 tool.metrics 的旧值，
        // 后面 {...metrics, ...metricsForLLM} 会用 undefined 把新注册时间冲掉
        registeredAt: registeredAt ?? tool.metrics?.registeredAt,
        // 域名权重（DR）来自已下线的 DataForSEO，存量值是冻结的旧快照，
        // 不喂给模型也不写回，避免它继续出现在新文案里
      }
    : metrics;

  // 月收入信号估算：总访问量（vortex 优先，回退 DFS 搜索流量）× 付款转化率 × 客单价（定价线索中位数）
  const revenueEstimate = estimateRevenueSignal({
    monthlyVisits: tm?.monthlyVisits ?? metrics?.monthlyVisits,
    paymentDetected,
    pricingClues: siteAudit?.pricingClues,
    categories: tool.categories,
  });

  const inputData = {
    // 只喂「我们自己采集的真实数据」，不喂任何哥伦布种子字段
    officialTitle: pageStructure?.title,
    officialDescription: pageStructure?.metaDescription,
    metrics: metricsForLLM,
    trend: trend?.slice(-7),
    keywords: keywords?.slice(0, 10),
    keywordCount: keywords?.length ?? keywordCount,
    // DFS 的 rankDistribution 已下线，改用 vortex 采样出的 SERP 实况（含排名、采样数）
    seo: tool.seoStanding ?? null,
    aiTraffic: tool.aiTraffic ?? null,
    channelShares: tool.channelShares ?? null,
    geo,
    engagement: tool.engagement ?? null,
    ranks: tool.ranks ?? null,
    backlinks: backlinks
      ? { total: backlinks.total, refDomains: backlinks.refDomains, dofollow: backlinks.totalDofollowShare }
      : null,
    competitors,
    siteAudit,
    pageStructure: pageStructure
      ? { title: pageStructure.title, h1: pageStructure.h1, h2: pageStructure.h2, h3: pageStructure.h3 }
      : null,
    paymentDetected,
    monthlyRevenueSignal: revenueEstimate.monthlyRevenue,
    paymentConversionRate: revenueEstimate.rate,
    revenueAov: revenueEstimate.aov,
    phUpvotes,
    phComments,
  };

  if (!analysisOnly) {
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
  }

  // 调用 2：AI 解读 + 观察（完全替换，不保留旧值；--opp-only 时跳过）
  if (!oppOnly) {
    const insight = await chatJSON<{
      aiInsight?: AiInsight;
      observations?: Observations;
      moduleInsights?: ModuleInsight;
      trafficDecrypt?: TrafficDecrypt;
    }>(SYSTEM_INSIGHT, buildInput(tool, inputData), 6000);
    if (insight.aiInsight) {
      tool.aiInsight = {
        ...insight.aiInsight,
        analyzedAt: new Date().toISOString().slice(0, 7),
      };
    }
    if (insight.moduleInsights) tool.moduleInsights = insight.moduleInsights;
    if (insight.observations) tool.observations = insight.observations;
    if (insight.trafficDecrypt) tool.trafficDecrypt = insight.trafficDecrypt;
    await sleep(300);
    console.log("[enrich-site] LLM#2 解读完成");
  }

  // 调用 3：创业洞察（--insight-only 时跳过，只补解读）
  if (!insightOnly) {
    const opp = await chatJSON<{
      opportunity?: OpportunityScore;
      monetizationBlueprint?: MonetizationBlueprint;
      growthPlaybook?: GrowthPlaybook;
      buildBlueprint?: BuildBlueprint;
      ideaSparks?: IdeaSpark[];
      performanceInsight?: PerformanceInsight;
    }>(SYSTEM_OPPORTUNITY, buildInput(tool, inputData), 7000);
    if (opp.opportunity) tool.opportunity = opp.opportunity;
    if (opp.monetizationBlueprint) {
      tool.monetizationBlueprint = {
        ...opp.monetizationBlueprint,
        paymentDetected: opp.monetizationBlueprint.paymentDetected?.length
          ? opp.monetizationBlueprint.paymentDetected
          : paymentDetected,
        // 收入信号由我们自己的流量 × 转化率 × 客单价估算（真实可验证，不被 LLM 改写）
        monthlyRevenueSignal: revenueEstimate.monthlyRevenue,
        paymentConversionRate: revenueEstimate.rate,
        revenueAov: revenueEstimate.aov,
      };
    }
    if (opp.growthPlaybook) tool.growthPlaybook = opp.growthPlaybook;
    if (opp.buildBlueprint) tool.buildBlueprint = opp.buildBlueprint;
    if (opp.ideaSparks?.length) tool.ideaSparks = opp.ideaSparks;
    if (opp.performanceInsight?.overview?.what || opp.performanceInsight?.wedge) tool.performanceInsight = opp.performanceInsight;
    console.log("[enrich-site] LLM#3 创业洞察完成");
  }

  // 写回
  if (analysisOnly) {
    // 仅更新分析文本与快照，保留刚抓取的 vortex 流量字段（尤其 channelShares）
    tool.metrics = metricsForLLM;
    tool.dataSnapshot = {
      // 没跑采集时沿用已入库的快照月份，不要用「当前月 - 1」硬算覆盖它
      period: tool.trafficMetrics?.snapshotMonth ?? lastPeriod(),
      syncedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    };
    tool.collectedAt = new Date().toISOString();
    if (dry) {
      console.log("[enrich-site] dry-run，未写入");
    } else {
      await saveTools(tools);
      console.log(`[enrich-site] 已写入 ${domain}（仅分析文本）`);
    }
    return;
  }

  // 月访问量口径：vortex（总访问量）优先，DFS 只补两者都缺的字段。
  // 若直接写 metrics，会把「总访问量」覆盖成「搜索流量」，页面卡片口径就变了。
  tool.metrics = tm ? { ...metrics, ...metricsForLLM } : metrics;
  tool.trend = trend;
  tool.keywords = keywords;
  tool.geoDistribution = geo;
  tool.backlinks = backlinks;
  tool.searchTraffic = searchTraffic;
  tool.keywordCount = keywordCount;
  tool.pageStructure = pageStructure;
  tool.siteAudit = siteAudit;
  // 技术栈 / 定价 / 联系方式与 siteAudit 同源（同一次首页抓取），在这里一并写回，
  // 免得为了这三个字段再跑一遍 enrich.ts（重复抓首页 + 重复检测）
  if (siteAudit?.techStack?.length) tool.techStack = siteAudit.techStack;
  if (pricingPlans?.length) tool.pricing = pricingPlans;
  if (!tool.contact && homeHtml) {
    const c = extractContact(homeHtml, tool.url);
    if (c) tool.contact = c;
  }
  tool.phUpvotes = phUpvotes;
  tool.phComments = phComments;
  // 真实竞品优先于 LLM 猜的竞品
  if (competitors.length) {
    tool.observations = { ...(tool.observations ?? {}), competitors };
  }
  // 渠道占比只有 vortex 能给：已跑过 apify 的站要保留，否则先 apify 后 enrich 会把渠道清空
  if (!tool.trafficMetrics) tool.channelShares = undefined;
  tool.dataSnapshot = {
    /*
     * 与 trafficMetrics.snapshotMonth 用同一个月份：三个来源（dataSnapshot /
     * trafficMetrics / 准入阶段）只要有一个用「当前月 - 1」硬算，页面快照标签
     * 就会和实际数据差一个月。
     */
    period: collectedPeriod ?? tool.trafficMetrics?.snapshotMonth ?? lastPeriod(),
    syncedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
  };
  tool.collectedAt = new Date().toISOString();

  if (dry) {
    console.log("[enrich-site] dry-run，未写入");
  } else {
    await saveTools(tools);
    console.log(`[enrich-site] 已写入 ${domain}`);
  }
}

main().catch((e) => {
  console.error("[enrich-site] 失败：", e);
  process.exit(1);
});
