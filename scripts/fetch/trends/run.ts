import "../config"; // 副作用导入：加载 .env.local
import type { AITrend, TrendSeries, TrendSourceRef } from "@horizons/shared";
import { hasLLM } from "../sources/llm";
import { RateLimitError, sleep } from "./http";
import {
  COMPARE_LIMIT,
  fetchInterest,
  fetchInterestBatch,
} from "./sources/google-trends";
import {
  collectEvidence,
  discoverFromAitools,
  discoverFromGithub,
  discoverFromProductHunt,
  discoverFromSeeds,
  discoverFromTrendingRss,
  isUsableKeyword,
  matchKeyword,
  type TrendCandidate,
} from "./discovery";
import { computeTrendParts, deriveConfidence, deriveStatus, rescore } from "./score";
import { enrichKeyword } from "./enrich";
import {
  buildTrend,
  indexByKey,
  loadDataset,
  planBatch,
  primeSlugs,
  saveDataset,
  upsert,
} from "./store";

/**
 * 趋势词采集主线（全免费来源）：
 *   Trending RSS / 工具库 / 种子 / GitHub 新仓库 → 候选
 *   → Google Trends 兴趣曲线（1 词 1 请求）→ HN + GitHub 证据
 *   → DeepSeek 单次富化 → 落库 content/trends.json
 *
 * 用法：
 *   pnpm trends:collect --limit 80            # 本次验证 80 个词
 *   pnpm trends:collect --dry                 # 只看排队结果，不联网不花钱
 *   pnpm trends:collect --rescore             # 不联网，按最新口径重算全库分数
 *   pnpm trends:collect --with-ph --limit 40  # 启用 Product Hunt 发现
 */

interface Args {
  limit: number;
  newRatio: number;
  refreshAfter: number;
  geo: string;
  dry: boolean;
  rescore: boolean;
  withPh: boolean;
  /** 跳过「相关查询」请求，每词少一次观看量，429 时更稳 */
  noRelated: boolean;
}

function parseArgs(): Args {
  const arg = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const num = (name: string, fallback: number): number => {
    const v = Number(arg(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    limit: num("--limit", Number(process.env.TRENDS_DAILY_BUDGET ?? 80)),
    newRatio: Math.min(1, Math.max(0, Number(arg("--new-ratio") ?? 0.4))),
    refreshAfter: num("--refresh-after", Number(process.env.TRENDS_REFRESH_DAYS ?? 3)),
    geo: arg("--geo") ?? process.env.TRENDS_GEO ?? "US",
    dry: process.argv.includes("--dry"),
    rescore: process.argv.includes("--rescore"),
    withPh: process.argv.includes("--with-ph"),
    noRelated: process.argv.includes("--no-related"),
  };
}

/** 请求间隔可由 TRENDS_DELAY_MIN / TRENDS_DELAY_MAX 调整，默认 3–7 秒 */
function randomDelay(
  min = Number(process.env.TRENDS_DELAY_MIN ?? 3000),
  max = Number(process.env.TRENDS_DELAY_MAX ?? 7000),
): number {
  return Math.floor(min + Math.random() * Math.max(0, max - min));
}

function dedupeCandidates(list: TrendCandidate[]): TrendCandidate[] {
  const map = new Map<string, TrendCandidate>();
  for (const c of list) {
    const prev = map.get(c.normalizedKey);
    if (!prev) {
      map.set(c.normalizedKey, c);
      continue;
    }
    const sources = [...prev.sources];
    for (const s of c.sources) {
      if (!sources.some((x) => x.url === s.url)) sources.push(s);
    }
    map.set(c.normalizedKey, {
      ...prev,
      weight: Math.max(prev.weight, c.weight),
      sources: sources.slice(0, 4),
    });
  }
  return [...map.values()];
}

function mergeSources(existing: AITrend | undefined, next: TrendSourceRef[]): TrendSourceRef[] {
  const out: TrendSourceRef[] = [];
  const seen = new Set<string>();
  for (const s of [...next, ...(existing?.sources ?? [])]) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, 8);
}

async function main(): Promise<void> {
  const args = parseArgs();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dataset = loadDataset();
  primeSlugs(dataset.keywords);

  if (args.rescore) {
    const keywords = dataset.keywords.map((t) => rescore(t, today));
    if (!args.dry) saveDataset({ ...dataset, keywords, updatedAt: now.toISOString() });
    console.log(`[rescore] 重算 ${keywords.length} 个词${args.dry ? "（dry-run 未写入）" : ""}`);
    return;
  }

  console.log(`[trends] 词库现有 ${dataset.keywords.length} 个，本次预算 ${args.limit} 个（geo=${args.geo}）`);

  const discovered: TrendCandidate[] = [
    ...(await discoverFromTrendingRss(
      (process.env.TRENDS_RSS_GEOS ?? "US,GB,IN,CA,AU").split(",").map((s) => s.trim()).filter(Boolean),
    )),
    ...discoverFromAitools(),
    ...discoverFromSeeds(),
    ...(await discoverFromGithub(Number(process.env.TRENDS_GITHUB_DAYS ?? 14), 40)),
  ];
  if (args.withPh) discovered.push(...(await discoverFromProductHunt()));

  const existingIndex = indexByKey(dataset.keywords);
  const filtered = dedupeCandidates(discovered).filter((c) => {
    // 已在库的词继续维护，不再重复做准入判定
    if (existingIndex.has(c.normalizedKey)) return true;
    // 工具库 / 种子 / PH 本身已限定 AI 范围，只做可用性校验；
    // RSS 与 GitHub 名字来源混杂，必须命中 AI 关键词，否则 2000 词里一半是噪声
    if (c.origin === "aitools" || c.origin === "seed" || c.origin === "ph") {
      return isUsableKeyword(c.keyword) && c.keyword.length >= 4;
    }
    return matchKeyword(c.keyword);
  });
  console.log(`[trends] 候选 ${discovered.length} 个，去重过滤后 ${filtered.length} 个`);

  const batch = planBatch({
    candidates: filtered,
    existing: dataset.keywords,
    budget: args.limit,
    refreshAfterDays: args.refreshAfter,
    newRatio: args.newRatio,
    today,
  });

  if (batch.length === 0) {
    console.log("[trends] 没有需要采集的词（都还新鲜），结束");
    return;
  }
  console.log(
    `[trends] 本轮排队 ${batch.length} 个：新增 ${batch.filter((b) => b.origin !== "refresh").length}，刷新 ${batch.filter((b) => b.origin === "refresh").length}`,
  );

  if (args.dry) {
    for (const item of batch) console.log(`  - ${item.keyword} [${item.origin}]`);
    console.log("[trends] dry-run，不联网、不调用 LLM、不写入");
    return;
  }

  if (!hasLLM()) {
    console.error("[trends] 未配置 DEEPSEEK_API_KEY，富化无法进行；可先用 --dry 查看排队结果");
    process.exit(1);
  }

  let keywords = [...dataset.keywords];
  let ok = 0;
  let failed = 0;
  let done = 0;
  const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  /** 拿到曲线后的完整流程：证据 → 评分 → LLM 富化 → 入库 */
  const processTrend = async (
    item: (typeof batch)[number],
    series: TrendSeries,
    relatedQueries: string[],
  ): Promise<void> => {
    {
      const evidence = await collectEvidence(item.keyword);
      const googleRef: TrendSourceRef = {
        label: `Google Trends · Explore（90 天，${args.geo}）`,
        url: `https://trends.google.com/trends/explore?date=today%203-m&geo=${args.geo}&q=${encodeURIComponent(item.keyword)}`,
        site: "trends.google.com",
        kind: "google_trends",
      };
      const evidenceRefs: TrendSourceRef[] = [
        ...evidence.hn.map<TrendSourceRef>((h) => ({
          label: h.title,
          url: h.url,
          site: "news.ycombinator.com",
          kind: "community",
          ...(h.publishedAt ? { publishedAt: h.publishedAt } : {}),
        })),
        ...evidence.repos.map<TrendSourceRef>((r) => ({
          label: r.title,
          url: r.url,
          site: "github.com",
          kind: "repo",
          ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
        })),
      ];

      const sources = mergeSources(item.existing, [googleRef, ...item.seedSources, ...evidenceRefs]);
      const firstSeenAt = item.existing?.firstSeenAt ?? today;
      const trendParts = computeTrendParts(series, firstSeenAt, today, sources);
      const status = deriveStatus(series);
      const confidence = deriveConfidence(series, sources);

      const enrich = await enrichKeyword({
        keyword: item.keyword,
        series,
        relatedQueries,
        evidence,
        sources,
      });

      const trend = buildTrend(
        {
          keyword: item.keyword,
          series,
          trendParts,
          oppParts: enrich.oppParts,
          status,
          confidence,
          category: enrich.category,
          normalizedName: enrich.normalizedName,
          why: enrich.why,
          intentSummary: enrich.intentSummary,
          sources,
          evidence: enrich.evidence,
          intents: enrich.intents,
          relatedQueries: enrich.relatedQueries,
          competitors: enrich.competitors,
          opportunities: enrich.opportunities,
          actions: enrich.actions,
          region: args.geo,
          now,
        },
        item.existing,
      );

      keywords = upsert(keywords, trend);
      ok++;
      done++;
      console.log(
        `[${done}] ${item.keyword} → ${status} / ${confidence} / T${trendParts.growth}·P${trendParts.persistence} / 共 ${keywords.length} 个词`,
      );

      if (ok % 10 === 0) {
        saveDataset({
          ...dataset,
          keywords,
          updatedAt: new Date().toISOString(),
          mode: "live",
          region: args.geo,
        });
        console.log(`[trends] 进度落盘：${keywords.length} 个词`);
      }
    }
  };

  // ---------- 采集调度：批量对比 + 软熔断 ----------
  // 429 不再一触即停：单词退回队尾重试，只有「最近 10 分钟限流率 > 60%」才收工。
  const WINDOW_MS = 10 * 60_000;
  const MAX_RETRY = 2;
  const events: { t: number; limited: boolean }[] = [];
  let backoffLevel = 0;

  const note = (limited: boolean): void => {
    const nowMs = Date.now();
    events.push({ t: nowMs, limited });
    while (events.length > 0 && nowMs - events[0].t > WINDOW_MS) events.shift();
    if (!limited) backoffLevel = 0;
  };

  const overloaded = (): boolean => {
    const limited = events.filter((e) => e.limited).length;
    return events.length >= 12 && limited / events.length > 0.6;
  };

  const queue = [...batch];
  const attempts = new Map<string, number>();

  /** 记一次重试；超过上限则放弃该词 */
  const requeueOrDrop = (item: (typeof batch)[number]): void => {
    const attempt = (attempts.get(item.keyword) ?? 0) + 1;
    attempts.set(item.keyword, attempt);
    if (attempt <= MAX_RETRY) queue.push(item);
    else {
      failed++;
      console.warn(`${item.keyword} → 放弃（限流重试 ${attempt} 次）`);
    }
  };

  while (queue.length > 0) {
    if (overloaded()) {
      console.warn("[trends] 最近 10 分钟限流率 > 60%，提前收工，已采集结果保留");
      break;
    }

    // 一批 = 锚点 + 4 个词，只花 2 次请求
    const chunk = queue.splice(0, COMPARE_LIMIT - 1);
    try {
      const { series, weak, missing } = await fetchInterestBatch(
        chunk.map((c) => c.keyword),
        args.geo,
      );
      note(false);

      for (const item of chunk) {
        const hit = series.get(item.keyword);
        if (hit) {
          try {
            await processTrend(item, hit, []);
          } catch (e) {
            failed++;
            console.warn(`${item.keyword} → 富化失败：${msgOf(e)}`);
          }
          continue;
        }

        // 值域太窄（批内峰值 < 10），量化误差大：单词重取一份高精度曲线
        if (weak.includes(item.keyword)) {
          try {
            const single = await fetchInterest(item.keyword, args.geo, !args.noRelated);
            note(false);
            await processTrend(item, single.series, single.relatedQueries);
          } catch (e) {
            if (e instanceof RateLimitError) {
              note(true);
              requeueOrDrop(item);
            } else {
              failed++;
              console.warn(`${item.keyword} → 跳过：${msgOf(e)}`);
            }
          }
          continue;
        }

        failed++;
        console.warn(
          `${item.keyword} → 跳过：${missing.includes(item.keyword) ? "搜索量不足" : "无数据"}`,
        );
      }

      await sleep(randomDelay());
    } catch (e) {
      if (e instanceof RateLimitError) {
        note(true);
        for (const item of chunk) requeueOrDrop(item);
        const wait = Math.min(60_000, 8000 * 2 ** backoffLevel);
        backoffLevel++;
        console.warn(
          `[trends] 批量 429（${chunk.length} 词回队列），退避 ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      } else {
        failed += chunk.length;
        note(false);
        console.warn(`批量请求失败（${chunk.length} 词）：${msgOf(e)}`);
        await sleep(randomDelay());
      }
    }
  }

  saveDataset({
    ...dataset,
    keywords,
    updatedAt: new Date().toISOString(),
    mode: "live",
    region: args.geo,
  });
  console.log(`[trends] 完成：成功 ${ok}，失败 ${failed}，词库 ${keywords.length} 个 → content/trends.json`);
}

main().catch((e) => {
  console.error("[trends] 运行失败：", e);
  process.exit(1);
});