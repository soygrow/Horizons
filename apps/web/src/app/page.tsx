import { tools, getBoards } from "@/lib/data";
import { SearchInput } from "@/components/SearchInput";
import { BoardSection } from "@/components/BoardSection";
import { TestimonialWall } from "@/components/TestimonialWall";
import { FaqAccordion } from "@/components/FaqAccordion";
import { SubscribeCta } from "@/components/SubscribeCta";

export default function Home() {
  const boards = getBoards();

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(91,91,214,0.18),transparent)]" />
        <div className="relative mx-auto max-w-6xl px-4 py-20 text-center sm:px-6 sm:py-28">
          <h1 className="mx-auto max-w-3xl text-4xl font-bold tracking-tight text-ink sm:text-5xl">
            发现正在崛起的 AI 工具
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-ink-secondary">
            用可追溯的真实信号——热度、定价、趋势与收录时间——追踪值得关注的
            AI 产品，而不是靠猜。
          </p>
          <div className="mt-8 flex justify-center">
            <SearchInput defaultValue="" />
          </div>
          <p className="mt-6 text-sm text-ink-muted">
            已追踪 {tools.length} 个工具 · 数据来自公开官方接口与人工整理
          </p>
        </div>
      </section>

      {/* 多榜单分区 */}
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <BoardSection
          title="热度榜"
          subtitle="按热度分排序的精选工具"
          items={boards.hot}
          viewAllHref="/tools"
        />
        <BoardSection
          title="新星榜"
          subtitle="近期新收录的工具"
          items={boards.newest}
          viewAllHref="/tools?sort=recent"
        />

        {boards.byCategory.map((b) => (
          <BoardSection
            key={b.category}
            title={b.category}
            subtitle="该分类下热度最高的工具"
            items={b.items}
            viewAllHref={`/tools?cat=${encodeURIComponent(b.category)}`}
          />
        ))}
      </div>

      {/* 评价墙 */}
      <TestimonialWall />

      {/* FAQ */}
      <FaqAccordion />

      {/* 订阅 CTA */}
      <SubscribeCta />
    </div>
  );
}
