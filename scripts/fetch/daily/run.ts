import { dailyConfig, githubToken, todayInTimezone } from "./config";
import { collectGitHub } from "./sources/github";
import { collectHackerNews } from "./sources/hackernews";
import { collectRss } from "./sources/rss";
import { normalizeScores, windowStartIso } from "./normalize";
import {
  loadSeenIndex,
  loadSourceHealth,
  loadStarState,
  pruneSeenIndex,
  recordSourceHealth,
  recordStarSample,
  saveRawDigest,
  saveSeenIndex,
  saveSourceHealth,
  saveStarState,
} from "./store";
import type { RawDigest, RawItem, SourceReport } from "./types";

/**
 * 每日情报采集入口（D1–D3：只跑通「采集 + 归一化 + 内容去重 + 落盘」）。
 *
 * 用法：
 *   pnpm fetch:daily                 # 全量采集，写 content/digest/raw/<今天>.json
 *   pnpm fetch:daily --dry           # 只打印计划，不联网
 *   pnpm fetch:daily --only=hn,rss   # 只跑指定源（hn / github / rss）
 *   pnpm fetch:daily --limit=100     # 限制最终保留条数
 */

interface Args {
  dry: boolean;
  only: Set<string>;
  limit: number;
  date: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${name}=`));
    return hit ? hit.slice(name.length + 1) : undefined;
  };
  const onlyRaw = value("--only");
  return {
    dry: argv.includes("--dry"),
    only: new Set(
      (onlyRaw ?? "hn,github,rss")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    limit: Number(value("--limit") ?? dailyConfig.maxCandidates),
    date: value("--date") ?? todayInTimezone(),
  };
}

function ms(t0: number): number {
  return Date.now() - t0;
}

function report(line: SourceReport): SourceReport {
  const flag = line.ok ? "ok " : "FAIL";
  const tail = line.error ? ` | ${line.error}` : line.note ? ` | ${line.note}` : "";
  console.log(
    `  [${flag}] ${line.source.padEnd(11)} ${String(line.items).padStart(3)} 条  ${String(line.ms).padStart(5)}ms${tail}`,
  );
  return line;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const startedAt = new Date();
  const since = windowStartIso(dailyConfig.lookbackHours);

  console.log(`\n每日情报 · 采集  date=${args.date}  窗口=${dailyConfig.lookbackHours}h（${since}）`);
  if (githubToken()) console.log("  GitHub 使用 PAT");
  else console.log("  GitHub 匿名模式（搜索 10 次/分钟，会比较慢）");

  if (args.dry) {
    console.log("\n[dry] 计划执行的请求：");
    if (args.only.has("hn")) {
      console.log(`  HN 首页 1 次 + 关键词 ${dailyConfig.hackernews.queries.length} 次`);
    }
    if (args.only.has("github")) {
      console.log(`  GitHub Search ${dailyConfig.github.queries.length} 次：${dailyConfig.github.queries.join(", ")}`);
    }
    if (args.only.has("rss")) {
      console.log(`  RSS ${dailyConfig.rss.length} 个：${dailyConfig.rss.map((r) => r.name).join(", ")}`);
    }
    console.log("\n[dry] 未联网，未写文件。");
    return;
  }

  const sources: SourceReport[] = [];
  const collected: RawItem[] = [];
  let candidates = 0;
  let duplicates = 0;

  const byId = new Set<string>();
  const byUrl = new Set<string>();

  const ingest = (items: RawItem[]): number => {
    let dup = 0;
    for (const item of items) {
      candidates++;
      if (byId.has(item.id) || byUrl.has(item.url)) {
        dup++;
        duplicates++;
        continue;
      }
      byId.add(item.id);
      byUrl.add(item.url);
      collected.push(item);
    }
    return dup;
  };

  /** 单个源失败不能中断整轮采集，但要如实记进报告 */
  const guard = async (
    source: string,
    fn: () => Promise<{ items: RawItem[]; note: string }>,
  ): Promise<void> => {
    const t0 = Date.now();
    try {
      const res = await fn();
      const tMs = ms(t0);
      const dup = ingest(res.items);
      sources.push(
        report({
          source,
          ok: true,
          items: res.items.length,
          duplicates: dup,
          ms: tMs,
          error: null,
          note: res.note,
        }),
      );
    } catch (e) {
      report({
        source,
        ok: false,
        items: 0,
        duplicates: 0,
        ms: ms(t0),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  };

  console.log("");
  if (args.only.has("hn")) await guard("hackernews", collectHackerNews);
  if (args.only.has("github")) {
    await guard("github", async () => {
      const res = await collectGitHub();
      const state = loadStarState();
      const at = new Date().toISOString();
      // 用采样历史算 Star 增量：只有一次采样时 delta 为 0，不能宣称「正在升温」
      for (const item of res.items) {
        const stars = res.stars[item.sourceItemId] ?? 0;
        item.signals.starDelta = recordStarSample(state, item.sourceItemId, stars, at);
      }
      saveStarState(state);
      return res;
    });
  }
  if (args.only.has("rss")) await guard("rss", collectRss);

  // 先按源归一化（0–100），再排序：HN 分数与 Star 数量纲不同，不能直接比大小
  const ranks = normalizeScores(collected);
  for (const item of collected) item.signals.rank = ranks.get(item.id) ?? 0;
  collected.sort(
    (a, b) =>
      (b.signals.rank ?? 0) - (a.signals.rank ?? 0) ||
      (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  const kept = collected.slice(0, args.limit);

  // 跨天标记：见过就记 firstSeenAt 并标记 repeat，旧闻不能当新事件
  const seenIndex = loadSeenIndex();
  const nowIso = new Date().toISOString();
  let repeatCount = 0;
  for (const item of kept) {
    const hit = seenIndex[item.url];
    if (hit) {
      item.firstSeenAt = hit.firstSeenAt;
      item.repeat = hit.date !== args.date;
      if (item.repeat) repeatCount++;
    } else {
      item.firstSeenAt = nowIso;
      seenIndex[item.url] = { firstSeenAt: nowIso, date: args.date };
    }
  }
  saveSeenIndex(pruneSeenIndex(seenIndex));

  // 源健康闭环：用当次采集报告更新跨天「连续失败」计数，连续失败 ≥3 次的源喊出来
  const health = recordSourceHealth(sources, loadSourceHealth(), nowIso);
  saveSourceHealth(health);
  const deadSources = Object.entries(health)
    .filter(([, h]) => h.consecutiveFailures >= 3)
    .map(([name]) => name);
  if (deadSources.length > 0) {
    console.warn(`\n⚠ ${deadSources.length} 个源已连续失败 ≥3 次，建议下架或修复：${deadSources.join("、")}`);
  }

  const okSources = sources.filter((s) => s.ok).length;
  const digest: RawDigest = {
    date: args.date,
    fetchedAt: startedAt.toISOString(),
    windowHours: dailyConfig.lookbackHours,
    stats: {
      sources: sources.length,
      okSources,
      candidates,
      unique: kept.length,
      duplicates,
    },
    sources,
    items: kept,
  };
  const file = saveRawDigest(digest);

  const byCategory = new Map<string, number>();
  for (const item of kept) byCategory.set(item.category ?? "other", (byCategory.get(item.category ?? "other") ?? 0) + 1);

  console.log(
    `\n合计：候选 ${candidates} → 去重后 ${collected.length} → 落盘 ${kept.length} 条（重复 ${duplicates}）`,
  );
  console.log(
    `分类：${[...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ")}`,
  );
  console.log(`旧闻（之前出现过）：${repeatCount} 条`);
  console.log(`写入：${file}`);
  console.log(`耗时：${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s\n`);

  if (okSources === 0) {
    console.error("所有数据源都失败，检查网络或额度。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});