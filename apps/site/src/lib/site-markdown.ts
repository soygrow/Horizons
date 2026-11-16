import type { AITool } from "@horizons/shared";
import { formatCount } from "./format";
// 别名避免与本文件里的局部变量 countryLabel（国名文本）撞名
import { channelSharesPct, countryLabel as regionName, pendingTrendFlags, toPercent } from "./data";

function fmtDuration(sec?: number | null): string {
  if (sec === null || sec === undefined) return "0s";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m${s}s` : `${m}m`;
}

const CHANNEL_LABELS: [string, string][] = [
  ["direct", "直接访问"],
  ["organicSearch", "自然搜索"],
  ["referral", "外链引荐"],
  ["displayAds", "展示广告"],
  ["organicSocial", "自然社交"],
  ["email", "邮件"],
  ["affiliates", "联盟推广"],
  ["paidSearch", "付费搜索"],
  ["aiAssistants", "AI 助手"],
  ["paidSocial", "付费社交"],
];

/** 生成「复制数据」用的站点数据 markdown（对齐哥伦布格式） */
export function buildSiteMarkdown(tool: AITool): string {
  const L: string[] = [];
  const ai = tool.aiInsight;
  const m = tool.metrics;

  L.push(`# ${tool.domain}（${tool.domain}）站点数据`);
  L.push("");
  L.push(`- 简介: ${tool.longDescription ?? tool.description}`);
  if (tool.featureTags?.length) L.push(`- 站点类型: ${tool.featureTags.join("、")}`);
  if (tool.categoryTags?.length)
    L.push(`- 主分类及二级分类: ${[tool.categoryTags[0], ...tool.categoryTags.slice(1)].join("、")}`);
  L.push("");

  L.push("## 核心指标");
  L.push("");
  if (m?.monthlyVisits !== undefined) L.push(`- 月访问量: ${m.monthlyVisits}`);
  if (m?.momGrowth !== undefined) L.push(`- 环比增长: ${m.momGrowth}%`);
  if (m?.organicVisits !== undefined) L.push(`- 自然搜索量: ${m.organicVisits}`);
  if (m?.organicShare !== undefined) L.push(`- 自然搜索占比: ${m.organicShare}%`);
  const countryLabel = m?.countryName ?? m?.country;
  if (countryLabel) L.push(`- 所属国家: ${countryLabel}`);
  // 域名权重（DR）来自已下线的 DataForSEO，存量值会一直冻结在旧快照上，不再对外输出
  if (m?.registeredAt)
    L.push(
      `- 域名注册: ${m.registeredAt}${m.registeredAtSuspect ? "（注册局迁移日，非真实注册时间）" : ""}`,
    );
  if (ai?.confidence) L.push(`- AI 置信度: ${ai.confidence}%`);
  if (tool.dataSnapshot?.period)
    L.push(
      `- 数据快照: ${tool.dataSnapshot.period}（最后同步 ${tool.dataSnapshot.syncedAt ?? "—"}）`,
    );
  L.push("");

  if (tool.trend?.length) {
    // 补 0 的月份不进表：写一行「0」会被当成「当月零访问」，
    // 那是趋势图特意规避的假信号，导出文本也不该重新制造一遍
    const flags = pendingTrendFlags(tool.trend);
    const rows = tool.trend.filter((_, i) => !flags[i]);
    const pending = flags.filter(Boolean).length;
    if (rows.length) {
      L.push(`## 流量趋势（近 ${tool.trend.length} 个月，其中 ${pending} 个月待累积）`);
      L.push("");
      L.push("| 月份 | 总访问量 | 自然搜索 |");
      L.push("| --- | --- | --- |");
      for (const p of rows) L.push(`| ${p.date} | ${p.total} | ${p.organic} |`);
      L.push("");
    }
  }

  if (tool.channelShares && Object.keys(tool.channelShares).length) {
    L.push("## 渠道结构");
    L.push("");
    // 原始占比是 0~1 小数，直接拼 % 会输出「0.42%」
    const shares = channelSharesPct(tool);
    for (const [key, label] of CHANNEL_LABELS) {
      const pct = shares[key];
      if (pct !== undefined) L.push(`- ${label}: ${pct}%`);
    }
    L.push("");
  }

  if (tool.geoDistribution?.length) {
    L.push("## 主要国家");
    L.push("");
    for (const g of tool.geoDistribution) {
      L.push(`- ${regionName(g.country) ?? g.country}: ${toPercent(g.share) ?? 0}%`);
    }
    L.push("");
  }

  const e = tool.engagement;
  if (e) {
    L.push("## 互动指标");
    L.push("");
    if (e.bounceRate !== undefined) L.push(`- 跳出率: ${e.bounceRate}%`);
    if (e.pagesPerVisit !== undefined) L.push(`- 页均访问: ${e.pagesPerVisit}`);
    L.push(`- 停留时长: ${fmtDuration(e.durationSec)}`);
    L.push("");
  }

  if (tool.ranks) {
    L.push("## 排名");
    L.push("");
    if (tool.ranks.global) L.push(`- 全球排名: 第 ${tool.ranks.global.toLocaleString("en-US")} 名`);
    if (tool.ranks.country) L.push(`- 国内排名: 第 ${tool.ranks.country.toLocaleString("en-US")} 名`);
    L.push("");
  }

  const seo = tool.seoStanding;
  if (seo?.samples?.length) {
    L.push("## 搜索排名（采样）");
    L.push("");
    L.push("| 关键词 | 排名 | 搜索量 |");
    L.push("| --- | --- | --- |");
    for (const s of seo.samples)
      L.push(
        `| ${s.term} | ${s.position ? `#${s.position}` : "未进前 20"} | ${s.volume ? formatCount(s.volume) : "—"} |`,
      );
    L.push("");
    // 采样词有限，必须写清「基于 N 个采样词」，否则会被当成全站排名统计
    L.push(
      `- 前 10 名: ${seo.top10 ?? 0} 个 / 前 20 名: ${seo.top20 ?? 0} 个（基于 ${seo.samples.length} 个采样词）`,
    );
    L.push("");
  }

  const aiv = tool.aiTraffic;
  if (aiv && aiv.share !== undefined) {
    L.push("## AI 引荐");
    L.push("");
    L.push(`- 占比: ${aiv.share}%`);
    if (aiv.visits !== undefined) L.push(`- 推算访问量: ${formatCount(aiv.visits)}`);
    const providers: [string, number | undefined][] = [
      ["ChatGPT", aiv.chatgpt],
      ["Claude", aiv.claude],
      ["Gemini", aiv.gemini],
      ["Perplexity", aiv.perplexity],
    ];
    for (const [name, v] of providers) if (v !== undefined) L.push(`- ${name}: ${v}%`);
    L.push("");
  }

  const b = tool.backlinks;
  if (b) {
    L.push("## 外链");
    L.push("");
    if (b.total !== undefined)
      L.push(`- 外链总数: ${b.total}（${b.totalDofollowShare ?? 0}% dofollow）`);
    if (b.refDomains !== undefined)
      L.push(`- 引荐域名: ${b.refDomains}（${b.refDofollowShare ?? 0}% dofollow）`);
    L.push("");
  }

  if (tool.keywords?.length) {
    L.push("## 头部关键词");
    L.push("");
    // 不再输出 CPC / 关键词流量：vortex 两个字段恒为空，一列「—」等于噪声
    L.push("| 关键词 | 搜索量 |");
    L.push("| --- | --- |");
    for (const k of tool.keywords)
      L.push(`| ${k.term} | ${k.volume ? formatCount(k.volume) : "—"} |`);
    L.push("");
  }

  const a = tool.siteAudit;
  if (a) {
    L.push("## 站点拆解");
    L.push("");
    L.push("### 技术与商业化");
    L.push("");
    if (a.techStack?.length) L.push(`- 技术栈: ${a.techStack.join("、")}`);
    if (a.analytics?.length) L.push(`- 分析工具: ${a.analytics.join("、")}`);
    if (a.pricingClues?.length) L.push(`- 定价线索: ${a.pricingClues.join("、")}`);
    L.push("");
    L.push("### 页面内容与 SEO");
    L.push("");
    if (a.wordCount !== undefined) L.push(`- 正文字数: ${a.wordCount}`);
    if (a.pageLang) L.push(`- 页面语言: ${a.pageLang}`);
    if (a.internalLinks !== undefined) L.push(`- 内链数: ${a.internalLinks}`);
    if (a.outboundLinks !== undefined) L.push(`- 出站链接数: ${a.outboundLinks}`);
    if (a.images !== undefined) L.push(`- 图片数: ${a.images}`);
    if (a.imagesMissingAlt !== undefined) L.push(`- 缺 alt 图片: ${a.imagesMissingAlt}`);
    if (a.structuredData?.length) L.push(`- 结构化数据: ${a.structuredData.join("、")}`);
    if (a.outboundDomains?.length) L.push(`- 出站域名: ${a.outboundDomains.join("、")}`);
    L.push("");
  }

  const ps = tool.pageStructure;
  if (ps) {
    L.push("### 页面结构");
    L.push("");
    if (ps.title) L.push(`- 页面标题: ${ps.title}`);
    if (ps.metaDescription) L.push(`- Meta 描述: ${ps.metaDescription}`);
    if (ps.canonical) L.push(`- Canonical: ${ps.canonical}`);
    const heads: [string, string[] | undefined][] = [
      ["H1", ps.h1],
      ["H2", ps.h2],
      ["H3", ps.h3],
    ];
    for (const [name, items] of heads) {
      if (items?.length) {
        L.push(`- ${name}（${items.length} 条）:`);
        for (const it of items) L.push(`  - ${it}`);
      }
    }
    if (ps.internalLinks?.length) {
      L.push(`### 内链明细（共 ${ps.internalLinks.length} 条）`);
      L.push("");
      L.push("| 锚文本 | URL |");
      L.push("| --- | --- |");
      for (const it of ps.internalLinks) L.push(`| ${it.text} | ${it.url} |`);
      L.push("");
    }
    if (ps.outboundLinks?.length) {
      L.push(`### 出站链接明细（共 ${ps.outboundLinks.length} 条）`);
      L.push("");
      L.push("| 锚文本 | URL |");
      L.push("| --- | --- |");
      for (const it of ps.outboundLinks) L.push(`| ${it.text} | ${it.url} |`);
      L.push("");
    }
  }

  if (tool.tagGroups?.length) {
    L.push("## 标签");
    L.push("");
    for (const g of tool.tagGroups) L.push(`- ${g.label}: ${g.values.join("、")}`);
    L.push("");
  }

  /*
   * AI 判断（performanceInsight）与 AI 分析（aiInsight）分工输出，同一主题只写一次。
   *
   * 以前这里只输出 aiInsight，页面上渲染的却是 performanceInsight，
   * 两份文案各写一遍「增长 / 获客 / 壁垒 / 变现」，复制出去的内容和页面看到的还对不上。
   * 现在：判断结论（四要素 + 六条结论）走 performanceInsight，
   * aiInsight 只留它独有的叙事部分（痛点三段、钩子、客群、付费意愿）。
   */
  const pi = tool.performanceInsight;
  if (pi) {
    L.push("## AI 判断");
    L.push("");
    const ov = pi.overview ?? {};
    const four: [string, string | undefined][] = [
      ["是什么", ov.what],
      ["解决什么痛点", ov.pain],
      ["能干什么", ov.can],
      ["特点", ov.trait],
    ];
    for (const [k, v] of four) if (v) L.push(`- ${k}: ${v}`);
    L.push("");

    const blocks: [string, string | undefined][] = [
      ["流量真相", pi.trafficTruth],
      ["增长势能", pi.growthEdge],
      ["护城河", pi.moat],
      ["切入点", pi.wedge],
      ["商业模式", pi.model],
      ["新玩家切入点", pi.newPlayerEntry],
    ];
    for (const [k, v] of blocks) {
      if (!v) continue;
      L.push(`### ${k}`);
      L.push("");
      L.push(v);
      L.push("");
    }
    if (pi.entryTag) L.push(`> 结论：${pi.entryTag}`);
    L.push("");
  }

  if (ai) {
    L.push("## AI 分析（叙事）");
    L.push("");
    if (ai.question) {
      L.push(ai.question);
      L.push("");
    }
    if (ai.intro) L.push(ai.intro);
    for (const seg of [ai.before, ai.now, ai.comparison]) if (seg) L.push(seg);
    if (ai.intro || ai.before || ai.now || ai.comparison) L.push("");
    if (ai.hooks?.length) {
      L.push("### 卖点钩子");
      L.push("");
      for (const h of ai.hooks) L.push(`- ${h.title}：${h.desc}`);
      L.push("");
    }
    if (ai.audiences?.length) {
      L.push("### 目标客群");
      L.push("");
      for (const a2 of ai.audiences) L.push(`- ${a2}`);
      if (ai.willingness)
        L.push(`客群付费意愿：${ai.willingness.level}。${ai.willingness.reason ?? ""}`);
      L.push("");
    }
    // growthDriver / acquisition / moat / monetization 已由 performanceInsight 输出，此处不再重复
    if (ai.analyzedAt) L.push(`> 分析时间：${ai.analyzedAt}`);
  }

  return L.join("\n");
}
