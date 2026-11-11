import "../fetch/config"; // 副作用导入：加载 .env.local
import type { AITrend } from "@horizons/shared";
import { hasEnoughTrendData } from "@horizons/shared";
import { collectEvidence } from "../fetch/trends/discovery";
import { enrichKeyword } from "../fetch/trends/enrich";
import { fetchRelatedQueriesOnly } from "../fetch/trends/sources/google-trends";
import {
  buildEnrichedTrend,
  loadStaging,
  saveStaging,
  syncStagingToD1,
} from "../fetch/trends/store";
import { arg, hasFlag, msgOf, parseSlugs } from "./cli";

/**
 * 阶段二：只给人工挑中的候选词补内容。
 *
 * 用法：
 *   pnpm trends:enrich                          # 所有未富化的词
 *   pnpm trends:enrich --slugs=a,b,c            # 只富化指定 slug（在榜词刷新也走这里）
 *   pnpm trends:enrich --slugs=a --force        # 未指定 slugs 时连已富化的也重刷
 *   pnpm trends:enrich --dry                    # 只打印不写盘、不联网、不调 LLM
 *
 * 省钱要点：
 * - 证据取自采集时暂存的 pendingEvidence，不重新联网；
 *   只有暂存缺失（老候选池）才补一次 HN/GitHub，这两处免费但慢。
 * - 相关查询在批量采集时拿不到（批量接口不返回 RELATED_QUERIES），
 *   只有真正被选中的词才补一次，每次 2 个请求。
 * - 数据点不足 14 的词直接跳过：趋势分本就不可信，富化纯属浪费。
 */

async function main(): Promise<void> {
  const dry = hasFlag("--dry");
  const force = hasFlag("--force");
  const jobId = arg("--job-id") ?? "-";
  const staging = loadStaging();

  if (staging.items.length === 0) {
    console.log("[enrich] 候选池为空，无需富化");
    return;
  }

  const wanted = parseSlugs();
  const picked = staging.items.filter((t) => {
    // 后台显式勾选的词一律执行：在榜词刷新内容时它没有 enrichStatus
    if (wanted.size > 0) return wanted.has(t.slug);
    // 否则只补未富化的；--force 才重刷已有内容的词
    return force || Boolean(t.enrichStatus);
  });

  const skipped: { keyword: string; reason: string }[] = [];
  const targets: AITrend[] = [];
  for (const t of picked) {
    if (!hasEnoughTrendData(t)) {
      skipped.push({ keyword: t.keyword, reason: `数据点 ${t.series?.values?.length ?? 0} < 14` });
      continue;
    }
    targets.push(t);
  }

  console.log(
    `[enrich] job=${jobId} 候选 ${staging.items.length} 个，待富化 ${targets.length} 个，跳过 ${skipped.length} 个${dry ? "（dry-run）" : ""}`,
  );
  for (const s of skipped) console.warn(`  · 跳过 ${s.keyword}：${s.reason}`);

  if (targets.length === 0) {
    console.log("[enrich] 没有需要富化的词");
    return;
  }

  const next = [...staging.items];
  const failed: { keyword: string; error: string }[] = [];
  let ok = 0;

  for (const [i, item] of targets.entries()) {
    const cached = staging.pendingEvidence?.[item.slug];
    process.stdout.write(`[${i + 1}/${targets.length}] ${item.keyword} … `);
    if (dry) {
      const hasEvidence = Boolean(cached);
      console.log(`跳过（dry-run，证据${hasEvidence ? "已暂存" : "需补拉"}）`);
      continue;
    }

    try {
      // 证据优先用采集时暂存的：那一轮已经付过联网时间，这里不再重拉
      const evidence = cached?.evidence ?? (await collectEvidence(item.keyword));

      // 相关查询补取：批量采集拿不到，只有人工挑中的词才值得多花 2 次请求
      let relatedQueries = cached?.relatedQueries ?? [];
      if (relatedQueries.length < 3) {
        const fresh = await fetchRelatedQueriesOnly(item.keyword, item.region);
        if (fresh.length > 0) relatedQueries = [...new Set([...relatedQueries, ...fresh])];
      }

      const enrich = await enrichKeyword({
        keyword: item.keyword,
        series: item.series,
        relatedQueries,
        evidence,
        sources: item.sources,
        ...(item.editorNote
          ? {
              editor: {
                audience: item.editorNote.audience,
                ideaAngle: item.editorNote.entryAngle,
                reason: item.editorNote.whyAccepted,
              },
            }
          : {}),
      });

      const trend = buildEnrichedTrend(
        {
          keyword: item.keyword,
          series: item.series,
          trendParts: item.trendParts,
          status: item.status,
          confidence: item.confidence,
          sources: item.sources,
          ...(item.editorNote ? { editorNote: item.editorNote } : {}),
          region: item.region,
          now: new Date(),
        },
        enrich,
        item,
      );

      const idx = next.findIndex((t) => t.slug === item.slug);
      if (idx >= 0) next[idx] = trend;
      else next.push(trend);
      // 富化成功后证据已无用（再刷时重拉一次即可），别让候选池无限膨胀
      if (staging.pendingEvidence) delete staging.pendingEvidence[item.slug];

      ok++;
      console.log(
        `ok（相关查询 ${relatedQueries.length} / 证据 ${enrich.evidence.length} / 机会 ${enrich.opportunities.length} / 行动 ${enrich.actions.length}）`,
      );
    } catch (e) {
      const msg = msgOf(e);
      failed.push({ keyword: item.keyword, error: msg });
      const idx = next.findIndex((t) => t.slug === item.slug);
      // 失败留痕：后台能看到「这个词点了富化但没成功」，可以重试
      if (idx >= 0) next[idx] = { ...item, enrichStatus: "failed" };
      console.log(`失败：${msg.slice(0, 100)}`);
    }
  }

  if (!dry) {
    const { pendingEvidence, ...rest } = staging;
    const nextStaging = saveStaging({
      ...rest,
      updatedAt: new Date().toISOString(),
      items: next,
      ...(pendingEvidence && Object.keys(pendingEvidence).length > 0
        ? { pendingEvidence }
        : {}),
    });
    await syncStagingToD1(nextStaging);
  }

  console.log(
    `[enrich] 完成：成功 ${ok}，失败 ${failed.length}，跳过 ${skipped.length}${dry ? "（dry-run 未写入）" : ""}`,
  );
  if (failed.length > 0) {
    for (const f of failed) console.warn(`  × ${f.keyword}：${f.error.slice(0, 120)}`);
    // 有失败时退出码非 0，workflow 会标红，但已成功的词已经落盘
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("[enrich] 运行失败：", e);
  process.exit(1);
});