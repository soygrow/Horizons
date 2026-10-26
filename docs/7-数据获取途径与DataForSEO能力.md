# 数据获取途径与 DataForSEO 能力分析

**文档版本：** V1.0
**状态：** 分析完成，待逐项实施
**依据：** DataForSEO 官方文档（2026-10 联网核实）

---

## 一、缺失数据的获取途径（当前"待接入"的字段）

| 缺失数据 | DataForSEO | 结论 | 其他途径 |
|---------|:---:|------|---------|
| 月访问量（总） | ❌ | DFS 只有「搜索流量 etv」，无全渠道总访问 | SimilarWeb（商业化后）/ Semrush / Ahrefs |
| 渠道占比（10 项） | ❌ | DFS 无渠道拆解 | SimilarWeb 独有 |
| 国家分布（全渠道） | ⚠️ | DFS 仅「搜索流量口径」国家分布 | SimilarWeb |
| 跳出率 / 停留时长 / 页均访问 | ❌ | DFS 无互动指标 | SimilarWeb 独有 |
| 国内排名 | ❌ | DFS 无站点排名 | SimilarWeb |
| 域名权重 DR | ⚠️ | DFS 有 `rank`（0~1000 权重），非 Ahrefs DR | Ahrefs |
| 外链明细 | ✅ | Backlinks API 完整提供 | — |

> **结论**：全渠道流量分析（访问量/渠道/互动指标）是 SimilarWeb 的护城河，DataForSEO 定位是 SEO/搜索数据，二者互补不替代。当前策略正确：**DFS 诚实呈现搜索口径 + 全渠道字段「待接入」，商业化后接 SimilarWeb**。

## 二、DataForSEO 可获取的完整能力（可新增利用）

已核实 DataForSEO v3 的 API 家族，可新增利用的端点：

| 端点 | 能提供 | 用途 | 价值 |
|------|--------|------|------|
| `dataforseo_labs/google/competitors_domain` | **真实竞品域名** | 替代 LLM 猜竞品 | 高（竞品更准） |
| `dataforseo_labs/google/domain_intersection` | **与目标站竞争相同关键词的域名** | 同上 | 高 |
| `dataforseo_labs/google/related_keywords` | 相关关键词 | 灵感点子的素材 | 中 |
| `dataforseo_labs/google/keyword_ideas` | 关键词建议 | 同上 | 中 |
| `dataforseo_labs/google/keywords_for_site` | 网站全部关键词 | 丰富关键词表 | 中 |
| `domain_analytics/technologies` | **技术栈（官方检测）** | 比自建指纹更准 | 中（已有自建，可补充） |
| `backlinks/anchors` | 锚文本分布 | 外链质量分析 | 中 |
| `backlinks/backlinks` | 外链明细（来源/DR/锚文本） | 补充外链明细表 | 中 |
| `on_page/lighthouse` | 页面性能 + SEO 评分 | 新增「页面健康度」 | 中 |
| `google_trends/explore` | 关键词趋势 | 赛道热度趋势 | 中 |
| `reddit/search`（Social Media） | 社媒/Reddit 声量 | 口碑信号 | 低 |
| `app_data`（App Data） | App 信息/评分/评论 | 有 App 的产品 | 低 |

**优先新增 3 项**（成本低、价值高）：
1. `competitors_domain` / `domain_intersection` → 真实竞品（当前 LLM 猜，可被替代）
2. `related_keywords` → 灵感点子的素材来源
3. `on_page/lighthouse` → 页面健康度（创业者关心"这个站技术底子如何"）

**可优化 1 项**：`domain_analytics/whois/overview` 一个端点同时返回 whois + 流量 etv + `backlinks_info`（referring_domains/dofollow/backlinks），可替代当前分散的 whois + backlinks summary 两次调用，省一次请求费用。

## 三、图标数据建议

| 图标 | 建议方案 | 成本 |
|------|---------|------|
| favicon（工具图标） | Google s2：`https://www.google.com/s2/favicons?domain={domain}&sz=64`，官网 `<link rel=icon>` 兜底 | 免费 |
| 国家国旗 | emoji（🇺🇸🇮🇳）或 flagcdn.com SVG | 免费 |
| 渠道图标（直接/搜索/社媒等） | lucide 或自绘 SVG | 免费 |
| 技术栈 / 品牌图标 | Simple Icons（1800+ 品牌 SVG，CDN 直连） | 免费 |

> 当前 ToolIcon 组件已用 Google s2 favicon；国家分布空（DFS 无数据）时无国旗需求；技术栈可用 Simple Icons 增强识别度（可选）。

## 四、页面架构重构：从「站点分析报告」到「创业作战手册」（已实施）

彻底摆脱哥伦布「数据维度分类 + 左数据右 AI 解读侧栏」的骨架，改为**创业决策链**架构：

| 哥伦布（数据维度） | 我们（决策链） |
|------------------|---------------|
| 概览 / 流量 / 搜索与外链 / 变现与产品 / 观察与竞品 | 值不值得做 / 这门生意 / 生意成色 / 怎么复制 / 你能做什么 / 风险与口径 |
| 数据罗列 + 分析师口吻 AI 解读 | 数据作为证据，服务「创业决策」 |

新架构（6 段决策链）：

```
Hero（是什么）
01 值不值得做 —— 机会评分大卡（结论前置，创业者第一眼）
02 这门生意 —— 痛点/客群/付费意愿 + 变现蓝图（怎么赚钱）
03 生意成色 —— 指标/趋势/渠道/国家/外链/关键词/技术底子（数据证据）
04 怎么复制 —— 增长复盘（抄/别踩）+ 启动蓝图（成本/周期）
05 你能做什么 —— 竞品格局 + 灵感点子（变体）
06 风险与口径 —— 数据疑点 + 来源口径（诚实）
```

本质区别（超越哥伦布的关键）：
1. **结论前置**：机会评分放最前，而非数据罗列
2. **去掉哥伦布标志性的「左数据 + 右 AI 解读侧栏」**
3. **哥伦布「AI 解读」被拆解重构**：收费模式→变现蓝图、增长驱动→增长复盘、竞争壁垒→机会评分维度
4. **标题创业者化**：「值不值得做 / 这门生意 / 生意成色 / 怎么复制 / 你能做什么」
