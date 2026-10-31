# Horizons

用可追溯的信号，追踪值得关注的 AI 工具。热度、定价、趋势、收录时间，一目了然。

## 功能

- **榜单列表页** `/tools`：搜索 + 多维分组筛选（类别/定价/上线时间）+ 9 列高密度表格 + 分页 + 付费墙横幅。
- **首页** `/`：多榜单分区（热度榜/新星榜/分类榜）+ 评价墙 + FAQ + 订阅 CTA。
- **工具详情页** `/tools/[domain]`：简介、热度、趋势、定价、技术栈、联系方式、相似产品、收录信息。

## 技术栈

- Next.js 16（App Router）+ React 19 + TypeScript
- Tailwind CSS v4（深色主题）
- 数据存储：`content/aitools.json`（静态预生成，无运行时数据库）

## 本地开发

```bash
pnpm install
pnpm dev        # 开发态（热更新，apps/site），不适合当“本地部署”看
pnpm dev:web    # 旧的 Next 站（apps/web，仅回滚备胎，3000 端口）
pnpm local      # 本地部署：全量构建最新代码 → http://localhost:4321（固定流程）
pnpm local:stop # 停掉本地服务
```

## 数据采集

榜单数据通过官方 API 与人工整理获取，低频合规抓取：

```bash
pnpm fetch        # 从 GitHub / Product Hunt 发现新工具
pnpm enrich       # 增强详情字段：技术栈 / 联系方式 / 定价
```

环境变量见 `.env.example`（仅本地/CI 抓取脚本需要，生产渲染不依赖）。

## 部署

见 `docs/2-AI工具榜单页面方案.md` 与项目部署方案。生产环境数据已固化，无需运行时 API。
