import { tools, githubRepos, githubUpdatedAt, getBoards, getGithubTop } from "@/lib/data";
import { SearchInput } from "@/components/SearchInput";
import { BoardSection } from "@/components/BoardSection";
import { GithubBoard } from "@/components/GithubBoard";
import { TestimonialWall } from "@/components/TestimonialWall";
import { FaqAccordion } from "@/components/FaqAccordion";

/** 2026-10-29T02:21:27.449Z → 2026-10-29 */
function fmtDate(iso: string): string {
  return iso ? iso.slice(0, 10) : "";
}

export default function Home() {
  const boards = getBoards();
  const ghTop = getGithubTop(8);
  const ghDate = fmtDate(githubUpdatedAt);

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
            两个榜：AI 工具榜看真实产品形态，GitHub 榜看开源项目能做成什么生意。
            每个条目都标注指标来源与数据日期。
          </p>
          <div className="mt-8 flex justify-center">
            <SearchInput defaultValue="" />
          </div>
          <p className="mt-6 text-sm text-ink-muted">
            已收录 {tools.length} 个 AI 工具 · {githubRepos.length} 个开源项目
            {ghDate ? ` · 榜单数据更新于 ${ghDate}` : ""}
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* GitHub 榜 */}
        <GithubBoard items={ghTop} total={githubRepos.length} />

        {/* AI 工具榜分区 */}
        <BoardSection
          title="热度榜"
          subtitle={`按热度分排序的前 ${boards.hot.length} 个工具`}
          items={boards.hot}
          viewAllHref="/tools"
        />
        <BoardSection
          title="新星榜"
          subtitle={`近期新收录的前 ${boards.newest.length} 个工具`}
          items={boards.newest}
          viewAllHref="/tools?sort=recent"
        />

        {boards.byCategory.map((b) => (
          <BoardSection
            key={b.category}
            title={b.category}
            subtitle={`该分类共 ${b.total} 个工具，按热度取前 ${b.items.length} 个`}
            items={b.items}
            viewAllHref={`/tools?cat=${encodeURIComponent(b.category)}`}
          />
        ))}
      </div>

      {/* 评价墙 */}
      <TestimonialWall />

      {/* FAQ */}
      <FaqAccordion />
    </div>
  );
}