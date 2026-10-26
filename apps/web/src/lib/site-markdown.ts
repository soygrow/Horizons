import type { AITool } from "@horizons/shared";
import { formatCount } from "./format";

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
  if (m?.organicVisits !== undefined) L.push(`- 自然搜索流量: ${m.organicVisits}`);
  if (tool.searchTraffic?.paid !== undefined) L.push(`- 付费搜索流量: ${tool.searchTraffic.paid}`);
  if (m?.domainWeight !== undefined) L.push(`- 域名权重 DR: ${m.domainWeight}`);
  if (m?.registeredAt) L.push(`- 注册时间: ${m.registeredAt}`);
  if (ai?.confidence) L.push(`- AI 置信度: ${ai.confidence}%`);
  if (tool.dataSnapshot?.period)
    L.push(
      `- 数据快照: ${tool.dataSnapshot.period}（最后同步 ${tool.dataSnapshot.syncedAt ?? "—"}）`,
    );
  L.push("");

  if (tool.trend?.length) {
    L.push(`## 流量趋势（近 ${tool.trend.length} 个月）`);
    L.push("");
    L.push("| 月份 | 总访问量 | 自然搜索 |");
    L.push("| --- | --- | --- |");
    for (const p of tool.trend)
      L.push(`| ${p.date} | ${p.total} | ${p.organic} |`);
    L.push("");
  }

  if (tool.channelShares && Object.keys(tool.channelShares).length) {
    L.push("## 流量结构");
    L.push("");
    for (const [key, label] of CHANNEL_LABELS) {
      const v = tool.channelShares[key as keyof typeof tool.channelShares];
      if (v !== undefined) L.push(`- ${label}: ${v}%`);
    }
    L.push("");
  }

  if (tool.geoDistribution?.length) {
    L.push("## 主要国家");
    L.push("");
    for (const g of tool.geoDistribution) L.push(`- ${g.country}: ${g.share}%`);
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
    L.push("| 关键词 | 搜索量 | CPC | 流量 |");
    L.push("| --- | --- | --- | --- |");
    for (const k of tool.keywords)
      L.push(
        `| ${k.term} | ${k.volume ? formatCount(k.volume) : "—"} | ${k.cpc ? `$${k.cpc}` : "—"} | ${k.traffic ?? "—"} |`,
      );
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

  if (ai) {
    L.push("## AI 分析");
    L.push("");
    if (ai.intro) {
      L.push("### 核心痛点与价值主张");
      L.push("");
      L.push(ai.intro);
      if (ai.before) L.push(ai.before);
      if (ai.now) L.push(ai.now);
      if (ai.comparison) L.push(ai.comparison);
      if (ai.hooks?.length)
        for (const h of ai.hooks) L.push(`- ${h.title}：${h.desc}`);
      L.push("");
    }
    if (ai.audiences?.length) {
      L.push("### 目标客群");
      L.push("");
      for (const a2 of ai.audiences) L.push(`- ${a2}`);
      if (ai.willingness)
        L.push(
          `客群付费意愿：${ai.willingness.level}。${ai.willingness.reason ?? ""}`,
        );
      L.push("");
    }
    if (ai.growthDriver) {
      L.push("### 增长驱动");
      L.push("");
      L.push(ai.growthDriver);
      L.push("");
    }
    if (ai.acquisition) {
      L.push("### 获客打法");
      L.push("");
      L.push(ai.acquisition);
      if (ai.trafficQuality) L.push(ai.trafficQuality);
      L.push("");
    }
    if (ai.moat) {
      L.push(`### 竞争壁垒${ai.moatBadge ? `（${ai.moatBadge}）` : ""}`);
      L.push("");
      L.push(ai.moat);
      L.push("");
    }
    if (ai.monetization) {
      L.push(`### 收费模式${ai.monetizationBadge ? `（${ai.monetizationBadge}）` : ""}`);
      L.push("");
      L.push(ai.monetization);
      L.push("");
    }
    if (ai.analyzedAt) L.push(`> 分析时间：${ai.analyzedAt}`);
  }

  return L.join("\n");
}
