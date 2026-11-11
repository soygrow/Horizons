/**
 * 把趋势候选池合并进榜单，并输出位次变化。
 *
 * 与 publish-tools.ts 的分工一致：采集只写 staging，这一步才动榜单。
 * 排位口径来自 @horizons/shared 的 trends-rank，和后台预览用的是同一份算法。
 */
import type { AITrend, TrendRankChange } from "@horizons/shared";
import {
  MAX_BOARD_SIZE,
  diffTrendRanks,
  rowOverall,
  toRankRow,
  trimBoard,
} from "@horizons/shared";
import {
  loadDataset,
  loadStaging,
  saveDataset,
  saveStaging,
  syncStagingToD1,
} from "../fetch/trends/store";
import { clearCandidates } from "./board-items";
import { syncBoardToD1 } from "./board-sync";
import type { PublishRow } from "./publish-board";

/**
 * 快照只服务于刷新前的对比与回滚；发布后留在榜单里只会让 trends.json 无谓变大。
 */
function stripSnapshot(t: AITrend): AITrend {
  if (!t.previousSnapshot) return t;
  const next = { ...t };
  delete next.previousSnapshot;
  return next;
}

function arrow(c: TrendRankChange): string {
  if (c.from === null) return `新进 → 第 ${c.to} 名`;
  if (c.to === null) return `第 ${c.from} 名 → 出榜`;
  return `第 ${c.from} → ${c.to} 名  ${c.delta > 0 ? "↑" : "↓"}${Math.abs(c.delta)}`;
}

function print(label: string, list: TrendRankChange[], limit: number): void {
  if (list.length === 0) return;
  console.log(`\n【${label}】共 ${list.length} 个`);
  list.slice(0, limit).forEach((c) => console.log(`  ${arrow(c).padEnd(26)} ${c.keyword}`));
  if (list.length > limit) console.log(`  …其余 ${list.length - limit} 个见后台`);
}

/* ------------------------------ D1 同步 ------------------------------ */

/**
 * 卡片 = 趋势词去掉 series。
 * series 是逐日热度序列，几十到几百个点，属于详情页的曲线图数据，
 * 列表页只显示关键词与名次，不该为它付出带宽。
 */
function toCard(trend: AITrend): Record<string, unknown> {
  const card: Record<string, unknown> = { ...trend };
  delete card.series;
  delete card.previousSnapshot;
  return card;
}

/**
 * 构造名次表。两个口径必须与站点一致：
 * 1. 别名（variantOf）不占名次 —— 与 trends-rank 的 rankKeywords 同规则
 * 2. 名次按行序，不重新计算 —— kept 已经是 trimBoard 排好的顺序
 */
function toRows(next: readonly AITrend[]): PublishRow[] {
  const ordered = next.filter((t) => !t.variantOf);

  return ordered.map((trend, i) => {
    const rank = i + 1;
    return {
      key: trend.slug,
      rank,
      score: rowOverall(toRankRow(trend)),
      // 趋势榜不分层，全部进主榜
      tier: "core",
      name: trend.keyword,
      url: null,
      cats: trend.category ? [trend.category] : null,
      card: { rank, ...toCard(trend) },
      detail: trend,
    };
  });
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const board = loadDataset();
  const staging = loadStaging();
  const rejected = new Set(staging.rejected.map((k) => k.toLowerCase()));

  // 被拒的代表词要连别名一起下架：别名的 canonical 指向代表词，留下就是死链
  const rejectedSlugs = new Set(
    board.keywords.filter((t) => rejected.has(t.keyword.toLowerCase())).map((t) => t.slug),
  );
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of board.keywords) {
      if (t.variantOf && rejectedSlugs.has(t.variantOf) && !rejectedSlugs.has(t.slug)) {
        rejectedSlugs.add(t.slug);
        changed = true;
      }
    }
  }

  const removed = board.keywords.filter((t) => rejectedSlugs.has(t.slug));
  // 未富化的候选不能进榜：内容字段是占位，发上去就是空详情页
  const enriched = staging.items.filter(
    (t) => !rejected.has(t.keyword.toLowerCase()) && !t.enrichStatus,
  );
  const skipped = staging.items.filter(
    (t) => !rejected.has(t.keyword.toLowerCase()) && Boolean(t.enrichStatus),
  ).length;
  // 旧内容快照只在候选池里有意义，不进榜单文件
  const incoming = enriched.map(stripSnapshot);

  const merged: AITrend[] = board.keywords.filter((t) => !rejectedSlugs.has(t.slug));
  for (const t of incoming) {
    const key = t.keyword.toLowerCase();
    const idx = merged.findIndex((x) => x.keyword.toLowerCase() === key);
    if (idx >= 0) {
      const prev = merged[idx]!;
      merged[idx] = {
        ...t,
        // slug / firstSeenAt / variantOf 是人工维护的，不能被采集覆盖
        slug: prev.slug,
        firstSeenAt: prev.firstSeenAt,
        ...(prev.variantOf ? { variantOf: prev.variantOf } : {}),
      };
    } else {
      merged.push(t);
    }
  }

  // 先按排位规则压到上限，再算位次差异：否则预览说 1100 条、实际写进去 1000 条
  const { kept, dropped } = trimBoard(merged, toRankRow);
  const report = diffTrendRanks(board.keywords, kept);

  console.log(
    `[publish] 候选 ${incoming.length} 个${skipped ? `（跳过 ${skipped} 个未富化）` : ""}，下架 ${removed.length} 个，榜单 ${report.boardBefore} → ${report.boardAfter} 条`,
  );
  if (dropped.length) {
    const aliases = dropped.filter((t) => t.variantOf).length;
    console.log(
      `[publish] 超出上限 ${MAX_BOARD_SIZE}，淘汰尾部 ${dropped.length - aliases} 个代表词（连带 ${aliases} 个别名）`,
    );
  }
  console.log(
    `[publish] 位次显著变动 ${report.significant.length} 处，其余 ${report.shifted} 个词只是顺延`,
  );

  // 前 50 名的变化最要紧，单独先打
  print("前 50 名变动", report.top, 25);
  print("新进榜", report.entered, 30);
  print("名次上升", report.ups.filter((c) => c.significant), 15);
  print("名次下降", report.downs.filter((c) => c.significant), 15);
  print("出榜", report.exited, 15);

  if (dry) {
    console.log("\n[publish] dry-run，未写入");
  } else {
    saveDataset({ ...board, keywords: kept, updatedAt: new Date().toISOString() });
    /* 同步 D1：灰度期是冷备，失败不影响 JSON 发布 */
    await syncBoardToD1({
      board: "trends",
      rows: toRows(kept),
      actor: process.env.GITHUB_ACTOR ?? "manual",
    });
    // 候选池清空、拒绝名单保留：下次采集直接跳过被否的词
    const publishedAt = new Date().toISOString();
    const nextStaging = saveStaging({
      updatedAt: publishedAt,
      runAt: staging.runAt,
      items: [],
      rejected: staging.rejected,
      /* 基线换成发布后的榜：下次采集比对的「发布前名次」就是现在这份 */
      board: {
        updatedAt: publishedAt,
        rows: kept.filter((t) => !t.variantOf).map(toRankRow),
      },
      ...(staging.lastRun ? { lastRun: staging.lastRun } : {}),
      // 发布后 items 清空，变动摘要得留下来，否则后台回看不到「刚才动了谁」
      lastPublish: {
        at: new Date().toISOString(),
        incoming: incoming.length,
        removed: removed.length,
        boardBefore: report.boardBefore,
        boardAfter: report.boardAfter,
        entered: report.entered.length,
        exited: report.exited.length,
        significant: report.significant.length,
        shifted: report.shifted,
        trimmed: dropped.length,
        top: report.top.slice(0, 40).map((c) => ({
          keyword: c.keyword,
          slug: c.slug,
          from: c.from,
          to: c.to,
          delta: c.delta,
        })),
      },
    });
    // 库里同步成发布后的样子：候选清空，黑名单保留
    await clearCandidates("trends");
    await syncStagingToD1(nextStaging);
    console.log(`\n[publish] 已写入 content/trends.json（${kept.length} 个词，其中 ${kept.filter((t) => t.variantOf).length} 个别名）`);
  }

  // 最后一行给 workflow / 后台读取
  console.log(
    JSON.stringify({
      incoming: incoming.length,
      removed: removed.length,
      boardBefore: report.boardBefore,
      boardAfter: report.boardAfter,
      entered: report.entered.length,
      exited: report.exited.length,
      up: report.ups.length,
      down: report.downs.length,
      significant: report.significant.length,
      shifted: report.shifted,
      trimmed: dropped.length,
      top: report.top.slice(0, 30).map((c) => ({
        keyword: c.keyword,
        slug: c.slug,
        from: c.from,
        to: c.to,
        delta: c.delta,
      })),
      dry,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});