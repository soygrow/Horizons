# AI 工具榜单页面方案（含详情页）

**文档版本：** V3.0（功能对齐版）
**文档定位：** 模仿 columbus.tools，**功能与哥伦布完全一致**，UI 保留自有风格（深色 + 蓝紫品牌色）。
**关键决策：** ① 全站深色主题（自有风格，不照抄竞品浅色列表页）；② 功能全量对齐：导航、搜索、多维筛选、高密度表格行、分页、付费墙、多榜单首页、评价墙、FAQ、订阅 CTA、详情页；③ 数据来源合规、免费优先，付费 API 后置；④ Product Hunt 凭据已配置并验证可用（2026-10-16）。
**文档存放：** 本项目所有文档统一保存在 `docs/` 目录。

---

# 一、竞品功能全景（基于 2026-10-16 截图分析）

哥伦布网站由以下功能模块构成：

## 1.1 全局导航栏

- 左侧 logo「哥伦布」；中间 7-8 个频道入口：AI工具榜、AI好公司、AI行业报告、AI出海周刊、AI编程热榜、Changelog、Support、更多（下拉）。
- 右侧：搜索入口 / 用户区。
- **当前项目差距：完全缺失。**

## 1.2 榜单列表页（竞品截图 1，浅色）

- H1「AI 工具站榜单」+ **搜索框**（按名称/关键词实时过滤）。
- **多维分组筛选**：约 4 组 pill 行（热门标签 / 工具类别 / 上线时间 / 定价模式），每组一行，选中态高亮。
- 列表 meta 行：「显示 100 项，共 N 页」+ **分页**。
- **高密度表格行**，每行 9 列：

| 列 | 内容 | 备注 |
|----|------|------|
| 1 | 排名 | 数字 |
| 2 | favicon 图标 | 方形圆角 |
| 3 | 名称 + 域名 + 外链图标 | 名称可点进详情 |
| 4 | 一句话描述 | 灰色小字 |
| 5 | 迷你趋势折线图（sparkline） | 历史 heat 快照 |
| 6 | 规模标签（用户量级/全球排名） | 竞品用 SimilarWeb；我们用真实可追溯指标替代 |
| 7 | 定价标签 | 免费 / 免费增值 / 付费 |
| 8 | 热度分（绿色大数字）+ 环比涨幅 % | 涨幅来自快照 diff |
| 9 | 收录日期 | 明示时效 |

- **底部付费墙横幅**（深蓝色）：「解锁全部 3470 个站点」+ CTA 按钮。

## 1.3 首页（竞品截图 2，深色长页）

- 深色 Hero + **多个榜单分区**：同一份数据按不同维度切成多个榜单（如：热度最高、增长最快、新星榜、各分类榜），每区一个表格 + 「查看全部」。
- 底部大 CTA 区块 + 多列 footer。

## 1.4 评价墙 + FAQ + 订阅 CTA（竞品截图 3，深色）

- 「来自真实用户的评价」：**三列瀑布流评价卡**（推文截图、聊天记录截图）。
- 「关于数据来源、订阅与收录标准」：**FAQ 手风琴**（约 6 题，默认折叠）。
- 大字 CTA：「你的下一片大陆，已经在路上」+ 双按钮（查看今日榜单 / 免费每周订阅）。
- 三列 footer + 版权。

## 1.5 工具详情页（V2.0 已拆解，保持）

头部（名称+官网按钮+分类标签+截图）→ 概览统计行 → 简介+标签+定价卡 → 流量区（后置）→ 技术栈 → 价格历史（后置）→ 相似产品 → 关键词（后置）→ 联系方式 → 收录信息。

---

# 二、当前项目状态盘点

**已有：**

- 榜单页 `/`：单组分类 pill 筛选 + 热度/时间排序，**浅色卡片风**（与目标深色表格风不符）。
- 详情页 `/tools/[domain]`：骨架完整（概览/简介/标签/定价/技术栈/相似/收录/联系），SSG。
- 组件：`AIToolRow`、`ToolIcon`（favicon）、`CategoryBadge`、`VerifiedBadge`。
- 数据模型 `AITool`（V2 schema）+ `content/aitools.json`（已积累若干真实工具）。
- 抓取脚本：GitHub（可用）+ Product Hunt（**已验证 token 可用**）。

**已验证的 PH API 事实（2026-10-16）：**

1. Developer Token 直接 `Bearer` 调 GraphQL 成功，无需 OAuth 流程。
2. **坑**：`posts.website` 返回的是 `producthunt.com/r/xxx` 跳转链接，**必须跟随重定向解析真实域名**，否则会把 producthunt.com 当成工具域名（当前 `productHunt.ts` 有此 bug，阶段二修复）。
3. 凭据已写入 `.env.local`（git 已忽略）：`PH_TOKEN` / `PH_API_KEY` / `PH_API_SECRET`。

**差距清单（功能维度）：**

| 功能 | 哥伦布 | 当前 | 阶段 |
|------|--------|------|------|
| 全局导航 | 8 频道 | 无 | P1 |
| 搜索 | 有 | 无 | P1 |
| 多维分组筛选 | 4 组 | 1 组 | P1 |
| 高密度表格行 | 9 列 | 卡片 5 列 | P1 |
| 分页 | 有 | 无 | P1 |
| 付费墙横幅 | 有 | 无（方案有位） | P1 |
| 深色多榜单首页 | 有 | 无（浅色单列表） | P1 |
| 评价墙 | 有 | 无 | P2 |
| FAQ 手风琴 | 有 | 无 | P2 |
| 订阅 CTA | 有 | 无 | P2（邮箱订阅后置） |
| 详情页免费字段 | 有 | 骨架已有 | P1 完善 |
| 趋势 sparkline + 涨幅 | 有 | 无 | P3（需快照积累） |
| 真实流量/来源/地区/关键词 | 有（SimilarWeb） | 无 | P4（付费） |

---

# 三、UI 风格决策（自有风格）

**全站统一深色主题**（与竞品首页/评价页一致；竞品列表页是浅色，我们不照抄）：

- 画布：近黑 `#0b0d12`；表面：`#12151c`；边框：`#1f2430`。
- 品牌色保留现有蓝紫 `#5b5bd6`，强调/上涨用 `#34d399`（emerald），不使用竞品的青绿渐变。
- 文字：主 `#e5e7eb` / 次 `#9ca3af` / 弱 `#6b7280`。
- 榜单行：表格风、行高紧凑、hover 高亮整行；详情页保持深色（V2 决策维持）。
- 中文化：界面文案用简体中文（自有风格 + 目标用户），域名/英文产品名保留原文。

改造 `globals.css` token + `layout.tsx`，所有组件按新 token 重写样式。

---

# 四、数据模型（V3 扩展）

在 V2 `AITool` 基础上新增字段：

```ts
export type PricingModel = "free" | "freemium" | "paid";

export interface AITool {
  // ...V2 全部字段保留...

  // V3 新增
  pricingModel?: PricingModel;      // 定价模式（筛选维度）
  launchedAt?: string;              // 上线时间（PH createdAt / GitHub created_at）
  topicSlugs?: string[];            // PH topics / GH topics，用于「热门标签」筛选
  heatHistory?: { date: string; score: number }[]; // heat 快照，画 sparkline + 算涨幅
  phUrl?: string;                   // PH 产品页链接（sourceUrl 保留）
}
```

**热度分与涨幅：**

- `heatScore` 公式不变：`normalize(ph_upvotes)*0.5 + normalize(github_stars)*0.3 + recency*0.2`。
- 每次抓取/定时任务追加 `heatHistory` 快照；涨幅 = 最近两次快照 diff（无快照时不显示）。
- **诚实呈现**：热度列标注「热度」，规模列用 PH 票数 / GH stars 等真实指标，不冒充访问量。

---

# 五、数据获取方案（更新）

## 5.1 Product Hunt（✅ 凭据就绪，⚠️ 域名解析阻塞）

- Developer Token 调 GraphQL 已验证可用，`order: VOTES` 拉热门 + `order: NEWEST` 拉新帖，`topicSlugs` 过滤 AI 类。
- 拉取字段：`createdAt`（launchedAt）、`topics`（topicSlugs）、`votesCount`（热度）。
- **实测阻塞（2026-10-16）**：PH 的 `website` / `productLinks` / `url` 全部返回 `producthunt.com/r/xxx` 跳转链接，且该跳转与 PH 产品页在服务端均被 Cloudflare 拦截（403）——**纯服务端无法解析真实域名**，当前 PH 条目会因域名解析失败被丢弃（贡献 0 条）。
- **两条出路（P3 择一实施）**：
  1. OAuth 授权码流程（用已配置的 `PH_API_KEY/SECRET`）换取带 scope 的 access token，PH 对 OAuth token 返回真实 `website`（待验证）。
  2. Playwright 无头浏览器带 JS 打开 `/r/` 链接拿真实 URL。
- `resolveRedirect` 已具备，真实域名可解析后无需改动即自动生效。
- 凭据管理：本地 `.env.local`；CI/部署环境用 secrets 注入，不进 git。

## 5.2 GitHub（✅ 已就绪）

- 增加输出：`launchedAt`（repo created_at）、`topics`。

## 5.3 其余来源（维持 V2 结论）

- 技术栈：自建规则检测（响应头 + HTML 特征）。
- 描述：meta description → AI 摘要 → 人工。
- 分类/标签：PH/GH topics → 映射到 `AIToolCategory` + 标签词表。
- 流量/来源/地区/关键词/截图/价格历史：付费或自建，后置（P4）。

## 5.4 合规红线（维持 V2）

仅官方 API + 人工整理；favicon 用公开服务；描述 AI 摘要并标注；低频防封（每次 2 条、串行、延迟、退避）；技术栈只探测首页。

---

# 六、页面与路由规划

| 路由 | 页面 | 内容 |
|------|------|------|
| `/` | 首页（深色） | Hero + 多榜单分区（热度榜/新星榜/分类榜，各取 Top N）+ 评价墙 + FAQ + 订阅 CTA |
| `/tools` | 榜单列表页（深色） | 搜索 + 4 组筛选（类别/定价/标签/上线时间）+ 表格行 + 分页 + 付费墙横幅 |
| `/tools/[domain]` | 详情页 | V2 布局，深色主题 |
| 全局 | 导航栏 | logo + AI工具榜（先只此频道可用，其余频道灰置「即将上线」）+ 订阅按钮 |
| 全局 | 页脚 | 三列（产品/公司/支持）+ 免责声明 |

**组件清单（新增/改造）：**

- `NavBar`、`SiteFooter`（新增全局）
- `ToolTable` + `ToolRow`（重构 `AIToolRow` → 紧凑表格行 9 列，含 `Sparkline`、涨幅箭头、定价标签）
- `SearchInput`（客户端过滤）
- `FilterGroup`（分组 pill，通用化，支持多组互斥选择）
- `Pagination`（URL query 驱动，SSR 友好）
- `PaywallBanner`（付费墙横幅，文案占位）
- `BoardSection`（首页榜单分区）
- `TestimonialWall`（评价瀑布流，数据 `content/testimonials.json` 人工整理）
- `FaqAccordion`（内容 `content/faq.json`）
- `SubscribeCta`（订阅收集，后端后置，先表单占位）
- 详情页组件沿用并深色化。

**渲染策略：** 列表页改为 SSR + `searchParams`（搜索/筛选/分页可分享链接）；首页 SSG；详情页 SSG 保留。

---

# 七、开发阶段（V3 重排）

| 阶段 | 任务 | 验收 | 状态 |
|------|------|------|------|
| P1a | 深色主题 token + 导航栏 + 页脚 | 全站深色统一，导航可用 | 已完成 |
| P1b | 榜单列表页重构：搜索 + 分组筛选 + 表格行 + 分页 + 付费墙横幅 | `/tools` 功能与哥伦布列表页对齐（数据用现有 json） | 已完成 |
| P1c | 首页多榜单分区 + 订阅 CTA 占位 | `/` 呈现多榜单 + CTA | 已完成 |
| P2 | 评价墙 + FAQ（人工整理内容入库） | 两大模块上线 | 已完成 |
| P3 | 数据管线增强：PH 重定向修复、topics/launchedAt 落库、分类映射、heat 快照 + sparkline + 涨幅 | 抓取数据带标签与趋势，榜单行显示涨跌 | 部分完成（PH 域名解析待无头浏览器） |
| P4 | 详情页增强：技术栈检测、联系方式提取、定价抓取 | 免费字段填充率 > 80% | 已完成（tech 7/8、contact 7/8、pricing 4/8） |
| P5 | 付费字段（SimilarWeb 流量/来源/地区、关键词、截图、价格历史）+ 邮箱订阅后端 | 商业化后实施 | 未开始 |

**执行顺序说明：** P3 提前于 V2 的「阶段二」之后无冲突——P1b/P1c 先用现有数据把 UI 对齐，P3 让数据质量追上 UI。每阶段结束跑 `pnpm build` + `pnpm lint` 验证。

---

# 八、与既有文档关系

- 本文档取代 V2.0 的「开发阶段」与「UI 决策」章节；字段拆解（V2 三章）、数据来源平台清单（V2 六章）、合规红线（V2 十章）继续有效。
- Product Hunt 凭据已配置：`.env.local`（本地），生产环境用部署平台 secrets。
