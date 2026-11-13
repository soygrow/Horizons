/**
 * 生成「数据字段健康度」快照：content/dist/* → apps/site/public/data/field-health.json
 *
 * 放构建期算的原因：机会榜详情、每日洞察都不在 public/data 下，
 * 只有构建时才能一次读全；面板要的只是「每页每字段覆盖率 + 来源 + 风险」。
 *
 * 字段口径（source / risk）是人工维护的，改采集链路时请同步这里；
 * 面板会显示快照时间，便于发现口径过期。
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outFile = resolve(root, "apps/site/public/data/field-health.json");

const has = (v) =>
  v !== null && v !== undefined && v !== "" &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

const readJson = (rel) => {
  const p = resolve(root, rel);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
};
const mtimeOf = (rel) => {
  const p = resolve(root, rel);
  return existsSync(p) ? statSync(p).mtime.toISOString() : null;
};

/* 类型：o=官方接口 e=第三方 d=站内派生 l=模型生成 m=人工维护 */
const FIELDS = {
  home: {
    name: "首页", route: "/", kind: "doc", file: "content/dist/home.json",
    note: "精选区字段与各榜同源，这里只统计首页独有的聚合字段。",
    groups: [
      ["站点统计条", [
        ["stats.tools", "工具总数", "d", "artifacts.ts 构建期统计", "只算主榜（tier=core），观察区不计入"],
        ["stats.repos", "仓库总数", "d", "artifacts.ts 构建期统计", "含低分条目"],
        ["stats.trends", "趋势词总数", "d", "artifacts.ts 构建期统计", "含采样不足、未参与排名的词"],
        ["stats.githubUpdatedAt", "GitHub 数据时间", "o", "GitHub API 采集时间戳", "是采集时间，不是仓库提交时间"],
      ]],
      ["精选区", [
        ["toolsHot", "热门工具", "d", "tools 榜按热度规则取前 N", "热度是站内规则分；不足条数时区会变短"],
        ["toolsNewest", "最新收录", "e", "PH 上线时间（fetch-launch-date）", "上线时间可能是推断值"],
        ["byCategory", "分类速览", "d", "按 tools.cats 聚合", "单站可能命中多个分类"],
        ["githubTop", "GitHub 前列", "d", "github 榜综合得分排序", "含主观权重，不代表真实热度"],
      ]],
    ],
  },
  tools: {
    name: "AI 工具榜", route: "/tools", file: "content/dist/tools/index.json",
    groups: [
      ["列表卡片", [
        ["rank", "名次", "d", "构建期按综合热度固化", "规则变化会让名次整体跳动"],
        ["name", "产品名", "o", "ProductHunt GraphQL", "改名需重新采集才更新"],
        ["desc", "一句话简介", "l", "PH tagline + LLM 中文改写", "模型改写可能偏离原意"],
        ["cats", "分类", "o", "PH topics 映射表", "映射表人工维护，新话题易落到「其他」"],
        ["visits", "月访问量", "e", "SimilarWeb（apply-traffic）", "小站取不到，缺失时展示「—」", 1],
        ["mom", "月环比", "d", "两期访问量相除", "首次采集为 null", 1],
        ["grank", "全球排名", "e", "SimilarWeb 全球排名", "小站取不到，缺失时展示「—」", 1],
        ["scale", "规模标签", "o", "GitHub Stars / PH Upvotes", "两者都没有时为空", 1],
        ["heat", "热度分", "d", "站内热度规则", "不是真实访问量，0–100 压缩后分差失真"],
        ["spark", "热度走势", "d", "历史热度快照", "不足两个点不出图", 1],
      ]],
      ["详情页 / 筛选", [
        ["url", "官网地址", "o", "PH 站点链接", "可能跳到 PH 页而非官网"],
        ["organic", "自然搜索占比", "e", "SimilarWeb 渠道构成", "取不到时详情页隐藏该行", 1],
        ["launchedAt", "上线时间", "e", "PH / 域名注册 / WHOIS", "推断值时详情页带 * 号"],
        ["pricing", "收费模式", "l", "落地页文案推断", "易把免费增值误判成付费，覆盖率天然低", 1],
        ["verified", "验证状态", "d", "站点可访问性检查", "只代表抓取时能打开"],
        ["tier", "主榜 / 观察区", "d", "按证据完整度分档", "观察区不占名次"],
      ]],
    ],
  },
  github: {
    name: "GitHub 榜", route: "/github", file: "content/dist/github/index.json",
    groups: [
      ["列表卡片", [
        ["rank", "名次", "d", "构建期按综合得分固化", "规则变化会让名次整体跳动"],
        ["fullName", "仓库全名", "o", "GitHub REST API", "仓库改名后旧链接 404"],
        ["intro", "中文一句话", "l", "LLM 读 README 生成", "生成式概括，可能偏差"],
        ["avatar", "所属头像", "o", "GitHub avatars", "组织改名/删头像时 404", 1],
        ["cats", "分类", "d", "关键词 + 话题规则", "一个仓库可能落进多个分类"],
        ["lang", "语言", "o", "GitHub languages", "文档型仓库没有主语言", 1],
        ["stars", "Stars", "o", "GitHub API", "采集时点快照，与实时有差距"],
        ["forks", "Forks", "o", "GitHub API", "同上"],
        ["g30", "30 天增长", "d", "两次 Star 快照相减", "整表为空说明快照任务没跑成"],
        ["spark", "Star 走势", "d", "历史快照序列", "采样点不足不出图", 1],
      ]],
      ["评分区", [
        ["score", "综合得分", "d", "github-ranking-rules 加权", "含「加工空间」等主观权重"],
        ["grade", "等级", "d", "得分区间映射 S/A/B/C", "阈值人工设定，跨版本会重排"],
        ["dv", "加工空间", "d", "README / 功能完整度推断", "主观判定：越像成品分越低", 1],
        ["diff", "复刻难度", "d", "代码规模 + 依赖推断", "粗粒度三档，不等同真实工时"],
      ]],
      ["许可与时间", [
        ["license", "许可证", "o", "GitHub license API", "没放 LICENSE 文件时为空", 1],
        ["permissive", "是否宽松许可", "d", "许可证白名单判定", "自定义许可证会被判成非宽松"],
        ["pushedDaysAgo", "最近提交", "o", "GitHub pushed_at", "只代表有推送，不代表实质更新", 1],
        ["updatedAt", "仓库更新时间", "o", "GitHub updated_at", "Star 也会刷新该时间", 1],
        ["createdAt", "创建时间", "o", "GitHub created_at", "转移仓库保留旧时间", 1],
      ]],
    ],
  },
  trends: {
    name: "AI 趋势词榜", route: "/trends", file: "content/dist/trends/index.json",
    groups: [
      ["行主体", [
        ["keyword", "关键词", "e", "Google Trends 发现 + 站内候选", "来自联想与挖掘，不代表真实搜索量"],
        ["catLabel", "分类", "d", "关键词规则分类", "新词易落到兜底分类"],
        ["statusLabel", "阶段", "d", "score.ts 按斜率与采样数判定", "采样不足会降级为「新词观察」"],
        ["confidence", "置信度", "d", "采样点数 + 波动幅度", "内部口径，不是统计显著性"],
        ["why", "判定理由", "l", "规则结论 + LLM 措辞", "文字是解释，结论以数值为准"],
        ["growth", "增长率", "e", "Google Trends 兴趣值对比", "基准期短或词太冷会算出离谱倍率", 1],
      ]],
      ["评分", [
        ["tv", "趋势分", "d", "热度 + 斜率 + 持续性加权", "站内规则分，跨词可比性有限"],
        ["op", "机会分", "d", "与机会榜交叉匹配", "靠关键词包含关系，可能误命中"],
        ["overall", "综合得分", "d", "0.6 × 趋势 + 0.4 × 机会", "权重人为设定"],
        ["rank", "名次", "d", "综合得分排序", "采样不足的词 rank=0"],
        ["seenDays", "采样天数", "d", "历史采样记录", "少于 14 点不参与评分", 1],
        ["scored", "是否已评分", "d", "采样点 ≥ 14 判定", "为 false 时显示「数据不足」"],
      ]],
      ["图表与关联", [
        ["spark", "兴趣走势", "e", "Google Trends 时间序列", "低量词被抽样，曲线会跳变", 1],
        ["oppTypes", "关联机会类型", "d", "机会榜类型映射", "空数组表示未匹配，不是没机会", 1],
      ]],
    ],
  },
  models: {
    name: "AI 模型榜", route: "/models", file: "content/dist/models/index.json",
    groups: [
      ["行主体", [
        ["name", "模型名", "o", "models.dev / OpenRouter 目录", "同名不同版本靠规则合并，可能合错"],
        ["provider", "厂商", "o", "同目录", "白标转售会归到原厂"],
        ["modality", "模态", "d", "输入输出能力映射", "多模态只标主模态"],
        ["open", "是否开源", "o", "目录 license 字段", "「开放权重」与「开源」口径不同"],
        ["license", "许可证", "o", "模型卡 / 官方文档", "闭源模型可能没写许可证", 1],
        ["tags", "标签", "d", "规则打标", "标签体系人工维护", 1],
      ]],
      ["规格", [
        ["context", "上下文窗口", "o", "官方文档 / 目录", "厂商常按档位调整，有滞后"],
        ["maxOutput", "最大输出", "o", "官方文档", "不少模型不公开", 1],
        ["params", "参数量", "o", "模型卡", "闭源基本不公开，缺失是常态", 1],
        ["knowledgeCutoff", "知识截止", "o", "官方文档", "口径不统一（月/季度），缺失常见", 1],
        ["releasedAt", "发布时间", "o", "官方公告 / 目录", "预览版与正式版时间不同", 1],
      ]],
      ["价格", [
        ["priceIn", "输入价", "o", "官方定价，折算 USD/1M tokens", "区域价、阶梯价、缓存价不同"],
        ["priceOut", "输出价", "o", "同官方定价", "同上"],
        ["priceCached", "缓存价", "o", "官方缓存定价", "只有部分厂商提供", 1],
        ["freeTier", "免费额度", "o", "官方文档", "额度政策变动频繁，容易过期", 1],
      ]],
      ["评分", [
        ["capability", "能力分", "d", "按模型家族校准的估算", "不是官方基准分，跨家族慎比"],
        ["value", "性价比分", "d", "能力/价格，样本内归一", "样本变化会让历史分数失效"],
        ["score", "综合得分", "d", "0.9 × 能力 + 0.1 × 性价比", "权重人为设定"],
        ["grade", "等级", "d", "得分区间映射", "阈值人工设定"],
      ]],
    ],
  },
  opportunity: {
    name: "机会榜", route: "/opportunity", file: "content/dist/opportunity/detail/*.json",
    note: "按详情页条目统计，每批 5 条，百分比颗粒度为 20%。",
    load() {
      const dir = resolve(root, "content/dist/opportunity/detail");
      const rows = existsSync(dir)
        ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")))
        : [];
      return { rows, doc: {}, updatedAt: mtimeOf("content/dist/opportunity/index.json") };
    },
    groups: [
      ["批次与标题", [
        ["batch", "批次号", "m", "人工策划 + 周批次", "批次口径按周，跨周不代表可比"],
        ["title", "机会标题", "l", "交叉结论 + 人工定稿", "标题是概括，可能盖过细节"],
        ["oneLiner", "一句话说明", "l", "模型组织 + 人工校对", "生成式表述"],
        ["audience", "目标人群", "m", "人工判定", "主观估计"],
      ]],
      ["评分", [
        ["scores.demand", "需求分", "d", "四榜信号归一", "样本来自站内数据，非市场调研"],
        ["scores.gap", "空缺分", "d", "同类产品密度", "密度统计依赖分类准确度"],
        ["scores.feasible", "可行分", "d", "实现路径复杂度", "主观估算"],
        ["scores.timing", "时机分", "d", "趋势斜率", "依赖趋势榜口径"],
        ["scores.monetize", "变现分", "d", "付费意愿推断", "无真实付费数据支撑"],
        ["grade", "综合等级", "d", "加权后分档", "阈值人工设定"],
      ]],
      ["执行与证据", [
        ["solo.budget", "启动预算", "m", "人工估算", "按 API 现价推算，价格会变"],
        ["solo.weeks", "预计周期", "m", "人工估算", "不含维护与获客"],
        ["money", "收入模型", "m", "人工策划", "属假设，不是承诺"],
        ["evidence", "证据链", "d", "四榜条目引用", "引用会随榜单独条目失效而变旧"],
        ["risks", "风险项", "m", "人工整理", "清单式，不保证穷尽"],
      ]],
    ],
  },
  daily: {
    name: "每日情报", route: "/daily", file: "content/digest/*.json",
    note: "统计最新一期；条目覆盖率按四个模块的所有情报项合并计算。",
    load() {
      const dir = resolve(root, "content/digest");
      const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
      const latest = files.at(-1);
      const doc = latest ? JSON.parse(readFileSync(resolve(dir, latest), "utf8")) : {};
      const rows = (doc.modules ?? []).flatMap((m) => m.items ?? []);
      return { rows, doc, updatedAt: doc.generatedAt ?? mtimeOf(`content/digest/${latest ?? ""}`) };
    },
    groups: [
      ["出稿统计", [
        ["stats.candidates", "候选条数", "d", "多源抓取汇总", "含大量未采用条目", 0, "doc"],
        ["stats.merged", "去重后", "d", "同事件合并", "合并规则可能把不同事件并掉", 0, "doc"],
        ["stats.verified", "已验证条数", "d", "官方/仓库来源判定", "验证靠来源类型，不是事实核查", 0, "doc"],
        ["stats.published", "发布条数", "d", "编辑规则筛选", "不等于当日全部新闻量", 0, "doc"],
      ]],
      ["情报条目", [
        ["title", "标题", "l", "源标题 + 模型改写", "生成式，可能与原文有出入"],
        ["summary", "摘要", "l", "模型压缩原文", "长文压缩易丢限定条件"],
        ["why", "判断", "l", "模型基于证据生成", "属观点，不是事实"],
        ["evidence", "证据等级", "d", "来源类型（官方/仓库/社区/媒体）", "社区来源可能只是转述"],
        ["score", "评分", "d", "热度 + 相关性规则", "站内规则分"],
        ["heat", "热度", "d", "社区互动数归一", "跨平台互动不可直接比较"],
        ["sources", "来源列表", "o", "HN / GitHub / RSS", "单源失败会导致条目偏少"],
        ["missing", "缺失说明", "d", "证据不足时的提示", "有时为空，不代表证据充分", 1],
      ]],
      ["来源健康", [
        ["sourceHealth", "采集源状态", "d", "当次抓取的 ok/items/error", "单源失败不会阻断出稿，但会让模块偏少", 0, "doc"],
      ]],
    ],
  },
};

/* ------------------------------ 计算与输出 ------------------------------ */

const has2 = has;

function loadBlock(id, def) {
  if (def.load) return def.load();
  const rows = readJson(def.file) ?? [];
  return { rows: Array.isArray(rows) ? rows : [], doc: Array.isArray(rows) ? {} : rows, updatedAt: mtimeOf(def.file) };
}

function levelOf(filled, total, optional) {
  if (!total) return "bad";
  const pct = Math.round((filled / total) * 100);
  if (!filled) return optional ? "muted" : "bad";
  if (pct >= 90) return "ok";
  if (pct >= 60) return "warn";
  return optional ? "warn" : "bad";
}

const blocks = Object.entries(FIELDS).map(([id, def]) => {
  const { rows, doc, updatedAt } = loadBlock(id, def);
  const docFields = def.groups.flatMap(([, fs]) => fs).length;
  const groups = def.groups.map(([name, fs]) => ({
    name,
    fields: fs.map(([key, label, type, source, risk, optional, on]) => {
      const pool = on === "doc" || def.kind === "doc" ? [doc] : rows;
      const get = (obj) => key.split(".").reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
      let filled = 0;
      for (const row of pool) if (has2(get(row))) filled++;
      const total = pool.length;
      const coverage = total ? Math.round((filled / total) * 100) : 0;
      return {
        key, label, source, risk, type, optional: Boolean(optional),
        filled, total, coverage, level: levelOf(filled, total, optional),
      };
    }),
  }));
  return {
    id, name: def.name, route: def.route, file: def.file, note: def.note ?? null,
    items: rows.length, fieldCount: docFields, updatedAt: updatedAt ?? null, groups,
  };
});

const totalFields = blocks.reduce((n, b) => n + b.fieldCount, 0);
const totalGaps = blocks.reduce((n, b) => n + b.groups.reduce((m, g) => m + g.fields.filter((f) => f.level === "bad").length, 0), 0);

const out = {
  generatedAt: new Date().toISOString(),
  totals: { fields: totalFields, gaps: totalGaps, blocks: blocks.length },
  blocks,
};

writeFileSync(outFile, JSON.stringify(out));
console.log(
  `[field-health] ${blocks.length} 个页面块 · ${totalFields} 个字段 · ${totalGaps} 个缺口 → ${outFile.replace(root + "/", "")} (${(JSON.stringify(out).length / 1024).toFixed(1)}KB)`,
);