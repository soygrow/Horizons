import type { GitHubInsight } from "@horizons/shared";

/**
 * 人工精编的「中文创业情报」（样板质量）。
 * 用于重点打磨的项目，质量优先于 LLM/启发式生成；被 enrich-github-insight.ts 优先采用。
 */
export const CURATED_INSIGHTS: Record<string, GitHubInsight> = {
  "harry0703/MoneyPrinterTurbo": {
    taglineZh: "输入一个主题，几分钟生成一条可发布的短视频",
    whatZh:
      "MoneyPrinterTurbo 是一条开源的 AI 短视频生产线：给一个主题或关键词，它会用大模型写脚本、自动匹配无版权素材、合成多语言配音与字幕、配上背景音乐，再用 ffmpeg 拼成 9:16 / 16:9 的高清短视频。支持批量生成，本地即可运行，也可接任意 OpenAI 兼容模型与 TTS。",
    capabilities: ["主题一键成片", "AI 脚本与素材匹配", "多语言配音", "自动字幕与背景音乐", "批量生成", "本地可部署"],
    buildIdeas: [
      {
        title: "跨境短视频代运营",
        audience: "做 TikTok / YouTube Shorts 的中小卖家与 MCN",
        product: "按月为客户批量产出本地化短视频，含选题、成片、字幕与发布排期。",
        monetization: "按条 ￥15-40，或月套餐 ￥999 起；量大走分成。",
        effort: "1-2 人 / 3 周",
        stackHint: "MoneyPrinterTurbo + 任务队列 + 行业素材库",
      },
      {
        title: "本地商家短视频",
        audience: "餐饮 / 美业 / 门店老板",
        product: "上传门店照片与卖点，自动生成探店 / 促销短视频，挂团购链接。",
        monetization: "￥299/月订阅，或 ￥99/月/门店。",
        effort: "1 人 / 2 周",
        stackHint: "模板化脚本 + 门店素材库 + 定位文案",
      },
      {
        title: "知识口播号矩阵",
        audience: "做副业的知识博主 / 个人 IP",
        product: "把长文或公众号一键拆成多条口播短视频，统一形象与音色。",
        monetization: "工具订阅 ￥49/月 + 代运营分成。",
        effort: "1 人 / 2-3 周",
        stackHint: "文案拆条 + 固定音色 TTS + 标题封面模板",
      },
      {
        title: "电商商品视频",
        audience: "淘宝 / 拼多多 / 独立站卖家",
        product: "输入商品链接，抓图与卖点，生成 15 秒商品展示视频。",
        monetization: "按条 ￥5-15，或接口调用计费。",
        effort: "2 人 / 4 周",
        stackHint: "商品信息抓取 + 模板渲染 + 批量导出",
      },
    ],
    buildSteps: [
      {
        step: "跑通本地生成",
        detail: "克隆仓库，配置大模型与语音合成的 Key，先生成 10 条样片，摸清成片质量与单条耗时。",
        phase: "验证",
        output: "10 条可发布样片 + 单条耗时基线",
        duration: "2-3 天",
      },
      {
        step: "锁定一个细分场景",
        detail: "从上面 4 个方向选 1 个（建议先做跨境短视频代运营），明确交付物、定价与验收标准。",
        phase: "验证",
        output: "场景说明 + 报价单",
        duration: "1 天",
      },
      {
        step: "封装成生成后台",
        detail: "用任务队列包装成网页应用：用户填主题 / 上传素材 → 排队生成 → 在线预览与下载。",
        phase: "起步",
        output: "可对外使用的生成后台",
        duration: "1-2 周",
      },
      {
        step: "沉淀差异化资产",
        detail: "积累行业模板、可商用素材库、音色与字幕样式，形成别人复制不了的内容资产。",
        phase: "变现",
        output: "模板库 + 可商用素材包",
        duration: "持续",
      },
      {
        step: "先卖再做",
        detail: "在闲鱼 / 小红书 / 跨境社群接 10 单验证付费意愿，再决定是否做订阅与团队化。",
        phase: "增长",
        output: "首批 10 个付费客户",
        duration: "2-4 周",
      },
    ],
    effects: [
      { metric: "单条视频制作耗时", value: "3-8 分钟" },
      { metric: "单条成本（LLM + 素材 + 算力）", value: "约 ￥0.5-2" },
      { metric: "单条对外报价", value: "￥15-40" },
      { metric: "毛利率", value: "70%+" },
      { metric: "日产能（1 台机器）", value: "100+ 条" },
    ],
    moat: "模板库 + 行业素材 + 稳定出片质量；真正壁垒在内容资产与客户渠道，而不在模型本身。",
    risks: [
      "平台对 AI 批量内容的限流与原创审核趋严，需做差异化与人工把关。",
      "素材版权与肖像权风险，务必使用可商用素材与授权音色。",
      "同质化严重，纯低价会陷入价格战，必须绑定行业与交付。",
      "依赖第三方 LLM / TTS，成本与稳定性受制于人。",
    ],
    techNotes: "Python + ffmpeg；可接任意 OpenAI 兼容大模型与 Edge / Azure 语音合成；建议加任务队列（Celery / Redis）与对象存储。",
    difficulty: "中",
    timeToMvp: "2-3 周",
    costToMvp: "￥200-800/月（LLM + TTS + 存储）",
    competitors: ["剪映 / CapCut 的 AI 成片", "Opus Clip", "开源的 ShortGPT"],
    differentiators: ["只做 1 个垂直行业，模板更懂行", "按结果交付（可发布成片）而非卖工具", "本地化配音与小语种"],
  },
};