import "../config"; // 副作用导入：加载 .env.local
import fs from "node:fs";
import path from "node:path";
import type { AITrend, TrendSeries, TrendSourceRef, ValueVerdict } from "@horizons/shared";
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
  discoverFromRelatedQueries,
  discoverFromSeeds,
  discoverFromTrendingRss,
  isUsableKeyword,
  matchKeyword,
  normalizeKey,
  type TrendCandidate,
} from "./discovery";
import { computeTrendParts, deriveConfidence, deriveStatus, rescore } from "./score";
import {
  auditDue,
  auditPolicy,
  cachedVerdict,
  ensurePolicy,
  judgeKeywords,
  pruneVerdicts,
  shouldAccept,
} from "./policy";
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

/**
 * 跳过表：Google Trends 里确实没有量的词，记下来，一段时间内不再试探。
 *
 * 不记录的话每轮都会重新烧配额在这些词上——上一轮 300 个预算里 200 个是空序列，
 * 真正的新词只跑了几十个。字节级原因见 emptyRetry 的注释。
 */
const SKIP_FILE = path.resolve(process.cwd(), "content/trends-skipped.json");
const SKIP_TTL_DAYS = 14;

/** 参照词：必然有数据，用来区分「候选没量」和「我们被限流」 */
const SENTINEL_KEYWORD = "chatgpt";

interface SkipRecord {
  reason: string;
  at: string;
}

function loadSkips(): Map<string, SkipRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(SKIP_FILE, "utf-8")) as Record<string, SkipRecord>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveSkips(skips: Map<string, SkipRecord>): void {
  const now = Date.now();
  const fresh: Record<string, SkipRecord> = {};
  for (const [k, v] of skips) {
    const at = Date.parse(v.at);
    if (Number.isFinite(at) && now - at < SKIP_TTL_DAYS * 86_400_000) fresh[k] = v;
  }
  fs.mkdirSync(path.dirname(SKIP_FILE), { recursive: true });
  fs.writeFileSync(SKIP_FILE, JSON.stringify(fresh, null, 2));
}

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
  /** 只跑「准入原则审计」：用历史判定样本重写榜单收录标准 */
  policyAudit: boolean;
  /** 耐心模式：被限流就长睡等解封，适合无人值守慢慢扩量 */
  patient: boolean;
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
    policyAudit: process.argv.includes("--policy-audit"),
    patient: process.argv.includes("--patient"),
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

/** 同义词合并用的停用词：「ai」几乎每个词都有，去掉它才能分清语义 */
const STOPWORDS = new Set(["the", "and", "for", "with", "to", "in", "of", "a", "an", "ai", "app"]);

/**
 * 近似重复合并。
 * 「ai youtube download」「youtube video download ai」「download youtube video ai」
 * 在 Trends 里是同一条曲线，全收进来等于在榜上刷屏。
 * 用 token 集合的 Jaccard 相似度判断，保留 weight 高的那个。
 */
function dedupeNearDuplicates(list: TrendCandidate[], threshold = 0.66): TrendCandidate[] {
  const tokens = (keyword: string): Set<string> => {
    const parts = keyword
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t));
    return new Set(parts);
  };

  const kept: Array<{ set: Set<string>; item: TrendCandidate }> = [];
  for (const c of [...list].sort((a, b) => b.weight - a.weight)) {
    const set = tokens(c.keyword);
    const dup = kept.some((k) => {
      let inter = 0;
      for (const t of set) if (k.set.has(t)) inter++;
      const union = set.size + k.set.size - inter;
      return union > 0 && inter / union >= threshold;
    });
    if (!dup) kept.push({ set, item: c });
  }
  return kept.map((k) => k.item);
}

/**
 * 子集合并：「mcp」⊂「mcp server」⊂「github mcp server」，三条曲线几乎重合。
 *
 * Jaccard 相似度管不住这种包含关系（{mcp} 与 {mcp,server} 只有 0.5），
 * 结果就是同一个话题在榜上刷屏。这里直接按集合包含判断，只留一个。
 * 已在库的词优先保留，避免把有外链的老页面挤掉。
 */
function dedupeSubsets(list: TrendCandidate[], preferKeys: Set<string>): TrendCandidate[] {
  const tokens = (keyword: string): Set<string> => {
    const parts = keyword
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t));
    return new Set(parts);
  };
  const ordered = [...list].sort(
    (a, b) =>
      Number(preferKeys.has(b.normalizedKey)) - Number(preferKeys.has(a.normalizedKey)) ||
      b.weight - a.weight,
  );
  const kept: Array<{ set: Set<string>; item: TrendCandidate }> = [];
  for (const c of ordered) {
    const set = tokens(c.keyword);
    if (set.size === 0) {
      kept.push({ set, item: c });
      continue;
    }
    const dup = kept.some((k) => {
      if (k.set.size === 0) return false;
      return [...set].every((t) => k.set.has(t)) || [...k.set].every((t) => set.has(t));
    });
    if (!dup) kept.push({ set, item: c });
  }
  return kept.map((k) => k.item);
}

/** 组成「需求」的实词之外的填充词：ai、best、tool、generator 这类单看不能定位需求 */
const GENERIC_TOKENS = new Set([
  "the", "and", "for", "with", "to", "in", "of", "a", "an", "how", "what", "is", "my", "your", "on", "at",
  "ai", "best", "free", "top", "new", "app", "apps", "tool", "tools", "platform", "platforms", "software",
  "online", "service", "services", "generator", "generators", "builder", "builders", "maker", "makers",
  "website", "websites", "system", "systems", "solution", "solutions", "assistant", "assistants", "vs",
]);

/** 去掉复数后缀，"claude skills" 与 "claude skill" 才是同一个族 */
function stem(token: string): string {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

function coreTokens(keyword: string): Set<string> {
  const parts = keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t))
    .map(stem);
  return new Set(parts);
}

/** 只改说法、不改需求的修饰词：claude skills install 与 claude skills 是同一件事 */
const VARIANT_TOKENS = new Set([
  "install", "installing", "marketplace", "example", "examples", "directory", "awesome",
  "github", "gitlab", "download", "list", "guide", "tutorial", "tutorials", "tips",
  "template", "templates", "usage", "docs", "documentation",
  // 「ai customer support」与「ai customer support chatbot」是同一需求换了个载体说法
  "chatbot", "chatbots", "assistant", "assistants", "bot", "bots",
]);

/**
 * 只合并「说法不同的同一需求」，不合并「同一主题下的不同工程需求」。
 *
 * related queries 会给出 claude skills / install / marketplace / example / directory 一串，
 * 这些是同一件事的不同说法，全收进来就是刷屏。但 claude code hooks / permissions /
 * subagents 是三个不同的技术需求，硬按主题砍成 3 个，反而扔掉榜上最值钱的部分。
 * 判断方法：短的实词集合被长的完全包含，且多出来的只是变体词，才算重复。
 */
function dedupeVariants(list: TrendCandidate[], preferKeys: Set<string>): TrendCandidate[] {
  const ordered = [...list].sort(
    (a, b) =>
      Number(preferKeys.has(b.normalizedKey)) - Number(preferKeys.has(a.normalizedKey)) ||
      b.weight - a.weight,
  );
  const kept: Array<{ core: Set<string>; keyword: string }> = [];
  const out: TrendCandidate[] = [];
  for (const c of ordered) {
    const core = coreTokens(c.keyword);
    const dup =
      core.size > 0 &&
      kept.some(({ core: other }) => {
        if (other.size === 0) return false;
        const [small, big] = core.size <= other.size ? [core, other] : [other, core];
        if (![...small].every((t) => big.has(t))) return false;
        return [...big].filter((t) => !small.has(t)).every((t) => VARIANT_TOKENS.has(t));
      });
    if (dup) continue;
    kept.push({ core, keyword: c.keyword });
    out.push(c);
  }
  return out;
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

  if (args.policyAudit) {
    const base = ensurePolicy(dataset.policy);
    const samples = Object.entries(base.verdicts ?? {}).map(([keyword, verdict]) => ({
      keyword,
      verdict,
    }));
    const next = await auditPolicy(base, samples);
    if (!args.dry) saveDataset({ ...dataset, policy: next, updatedAt: now.toISOString() });
    console.log(
      `[policy] 准入原则 v${base.version} → v${next.version}（样本 ${samples.length} 个）${args.dry ? "，dry-run 未写入" : ""}`,
    );
    next.accept.forEach((a) => console.log(`  收 · ${a}`));
    next.reject.forEach((r) => console.log(`  拒 · ${r}`));
    next.notes.slice(0, 3).forEach((n) => console.log(`  记 · ${n}`));
    return;
  }

  console.log(`[trends] 词库现有 ${dataset.keywords.length} 个，本次预算 ${args.limit} 个（geo=${args.geo}）`);

  const discovered: TrendCandidate[] = [
    ...(await discoverFromTrendingRss(
      (process.env.TRENDS_RSS_GEOS ?? "US,GB,IN,CA,AU").split(",").map((s) => s.trim()).filter(Boolean),
    )),
    ...discoverFromAitools(),
    ...discoverFromSeeds(),
    ...discoverFromRelatedQueries(),
    ...(await discoverFromGithub(Number(process.env.TRENDS_GITHUB_DAYS ?? 14), 40)),
  ];
  if (args.withPh) discovered.push(...(await discoverFromProductHunt()));

  const existingIndex = indexByKey(dataset.keywords);
  const existingKeys = new Set(existingIndex.keys());
  const skips = loadSkips();
  const skipCutoff = Date.now() - SKIP_TTL_DAYS * 86_400_000;
  let skippedByCache = 0;
  const deduped = dedupeSubsets(dedupeNearDuplicates(dedupeCandidates(discovered)), existingKeys);
  const filtered = dedupeVariants(deduped, existingKeys).filter((c) => {
    // 已在库的词继续维护，不再重复做准入判定
    if (existingIndex.has(c.normalizedKey)) return true;
    // 近两周确认为无量的词不再占配额
    const skip = skips.get(c.normalizedKey);
    if (skip && Date.parse(skip.at) > skipCutoff) {
      skippedByCache++;
      return false;
    }
    // 工具库 / 种子 / PH 本身已限定 AI 范围，只做可用性校验；
    // RSS 与 GitHub 名字来源混杂，必须命中 AI 关键词，否则 2000 词里一半是噪声
    if (c.origin === "aitools" || c.origin === "seed" || c.origin === "ph") {
      return isUsableKeyword(c.keyword) && c.keyword.length >= 4;
    }
    return matchKeyword(c.keyword);
  });
  console.log(
    `[trends] 候选 ${discovered.length} 个，去重过滤后 ${filtered.length} 个` +
      (skippedByCache > 0 ? `（跳过表挡掉 ${skippedByCache} 个已知无量词）` : ""),
  );

  // ---- 价值准入：先用便宜的 LLM 判「有没有创业切口」，再花宝贵的 Trends 配额 ----
  // 读者是创业者，收进来的词必须能回答「明天能拿它做什么」。
  let policy = ensurePolicy(dataset.policy);
  const gate = new Map<string, ValueVerdict>();
  const judgedNow: Array<{ keyword: string; verdict: ValueVerdict }> = [];
  const toJudge: string[] = [];

  for (const c of filtered) {
    if (existingIndex.has(c.normalizedKey)) continue; // 库内词免判
    const hit = cachedVerdict(policy, c.normalizedKey);
    if (hit) gate.set(c.normalizedKey, hit);
    else toJudge.push(c.keyword);
  }

  if (toJudge.length > 0 && !args.dry) {
    if (!hasLLM()) {
      console.warn("[policy] 未配置 LLM，本轮跳过价值准入（只按规则过滤）");
    } else {
      try {
        const judged = await judgeKeywords(toJudge, policy);
        for (const [k, v] of judged) {
          gate.set(k, v);
          judgedNow.push({ keyword: k, verdict: v });
        }
        console.log(`[policy] 价值判定 ${judged.size}/${toJudge.length} 个词`);
      } catch (e) {
        console.warn(
          `[policy] 价值判定失败，本轮退回规则过滤：${e instanceof Error ? e.message : e}`,
        );
      }
    }
    policy = pruneVerdicts({
      ...policy,
      verdicts: { ...policy.verdicts, ...Object.fromEntries([...gate]) },
    });
  }

  let valueRejected = 0;
  // 预算有限时先跑短词：4–5 个 token 的长尾在美国区近 90 天基本无量，
  // 上一轮 66% 的预算耗在它们身上，换回来的全是空序列。
  // 库内词排最前（它们要刷新数据），新词按词长升序。
  const ordered = [...filtered].sort((a, b) => {
    const aOld = existingIndex.has(a.normalizedKey) ? 0 : 1;
    const bOld = existingIndex.has(b.normalizedKey) ? 0 : 1;
    if (aOld !== bOld) return aOld - bOld;
    return a.keyword.split(/\s+/).length - b.keyword.split(/\s+/).length;
  });

  const passed: TrendCandidate[] = [];
  for (const c of ordered) {
    if (existingIndex.has(c.normalizedKey)) {
      passed.push(c);
      continue;
    }
    const v = gate.get(c.normalizedKey);
    if (!v) {
      // 没有判定（LLM 不可用）：交给规则层，避免整轮卡死
      passed.push(c);
      continue;
    }
    if (shouldAccept(v)) passed.push(c);
    else valueRejected++;
  }
  if (valueRejected > 0) {
    console.log(`[policy] 价值准入拒掉 ${valueRejected} 个：没有可落地的创业切口`);
  }

  const batch = planBatch({
    candidates: passed,
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

      const verdict = gate.get(normalizeKey(item.keyword));
      const enrich = await enrichKeyword({
        keyword: item.keyword,
        series,
        relatedQueries,
        evidence,
        sources,
        ...(verdict
          ? {
              editor: {
                audience: verdict.audience,
                ideaAngle: verdict.ideaAngle,
                reason: verdict.reason,
              },
            }
          : {}),
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
          editorNote: enrich.editorNote,
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
          policy,
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
  /** 耐心模式：被限流就长睡等解封，而不是收工 */
  const PATIENT_ROUNDS = 10;
  const PATIENT_BASE_WAIT = 4 * 60_000;
  const PATIENT_MAX_WAIT = 20 * 60_000;
  let patientRounds = 0;
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
    return events.length >= 6 && limited / events.length > 0.6;
  };

  const queue = [...batch];
  const attempts = new Map<string, number>();
  /** 空序列只重试一次：Google 限流时会返回空 timeline 而不是 429，重试一次能救回来一半 */
  const emptyRetried = new Set<string>();

  /**
   * 限流时 Google 返回空 timeline 而非 429，于是「这个词没量」和「我们被限流了」
   * 看起来一模一样。拿一个必然有数据的参照词对照：连它也是空的，就是限流，
   * 此时绝不能写跳过表——那会让一批本来有量的词被误伤 14 天。
   */
  let healthAt = 0;
  let healthOk = true;
  const throttled = async (): Promise<boolean> => {
    if (Date.now() - healthAt < 60_000) return !healthOk;
    try {
      const probe = await fetchInterest(SENTINEL_KEYWORD, args.geo, false);
      healthOk = (probe.series?.values.length ?? 0) > 0;
    } catch {
      healthOk = false;
    }
    healthAt = Date.now();
    return !healthOk;
  };

  const recordSkip = (keyword: string, reason: string): void => {
    skips.set(normalizeKey(keyword), { reason: reason.slice(0, 80), at: new Date().toISOString() });
  };

  /** 记一次重试；超过上限则放弃该词 */
  const requeueOrDrop = (item: (typeof batch)[number]): void => {
    const attempt = (attempts.get(item.keyword) ?? 0) + 1;
    attempts.set(item.keyword, attempt);
    if (args.patient || attempt <= MAX_RETRY) queue.push(item);
    else {
      failed++;
      console.warn(`${item.keyword} → 放弃（限流重试 ${attempt} 次）`);
    }
  };

  while (queue.length > 0) {
    if (overloaded()) {
      if (!args.patient) {
        console.warn("[trends] 最近 10 分钟限流率 > 60%，提前收工，已采集结果保留");
        break;
      }
      patientRounds++;
      if (patientRounds > PATIENT_ROUNDS) {
        console.warn(
          `[trends] 已休眠 ${patientRounds - 1} 轮仍被限流，收工：本次成功 ${ok} 个，词库 ${keywords.length} 个`,
        );
        break;
      }
      const wait = Math.min(PATIENT_MAX_WAIT, PATIENT_BASE_WAIT * patientRounds);
      console.log(
        `[trends] 限流中（第 ${patientRounds}/${PATIENT_ROUNDS} 轮），休眠 ${Math.round(wait / 60_000)} 分钟后继续，队列剩 ${queue.length} 个词`,
      );
      await sleep(wait);
      events.length = 0;
      attempts.clear();
      backoffLevel = 0;
      continue;
    }

    // 一批 = 4 个同类词互比，只花 2 次请求
    const chunk = queue.splice(0, COMPARE_LIMIT);
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

        // 值域太窄（批内峰值 < 10）或被组内大词压成 0：单词重取一份高精度曲线
        if (weak.includes(item.keyword) || missing.includes(item.keyword)) {
          try {
            const single = await fetchInterest(item.keyword, args.geo, !args.noRelated);
            note(false);
            await processTrend(item, single.series, single.relatedQueries);
          } catch (e) {
            if (e instanceof RateLimitError) {
              note(true);
              requeueOrDrop(item);
            } else if (/^空序列/.test(msgOf(e)) && !emptyRetried.has(item.keyword)) {
              // 空序列一半是限流期的软拒绝而不是真的没量：
              // 实测 ai excel plugin 批量空、单独请求峰值 100。隔几秒再单独问一次
              emptyRetried.add(item.keyword);
              await sleep(3000);
              try {
                const again = await fetchInterest(item.keyword, args.geo, !args.noRelated);
                note(false);
                await processTrend(item, again.series, again.relatedQueries);
              } catch (e2) {
                if (e2 instanceof RateLimitError || (await throttled())) {
                  note(true);
                  requeueOrDrop(item);
                } else {
                  failed++;
                  recordSkip(item.keyword, msgOf(e2));
                  console.warn(`${item.keyword} → 跳过：${msgOf(e2)}`);
                }
              }
            } else if (await throttled()) {
              // 参照词也没数据 → 我们在被限流，这个词既不判死也不写跳过表
              note(true);
              requeueOrDrop(item);
            } else {
              failed++;
              recordSkip(item.keyword, msgOf(e));
              console.warn(`${item.keyword} → 跳过：${msgOf(e)}`);
            }
          }
          continue;
        }

        if (await throttled()) {
          note(true);
          requeueOrDrop(item);
        } else {
          failed++;
          recordSkip(item.keyword, missing.includes(item.keyword) ? "搜索量不足" : "无数据");
          console.warn(
            `${item.keyword} → 跳过：${missing.includes(item.keyword) ? "搜索量不足" : "无数据"}`,
          );
        }
      }

      await sleep(randomDelay());
    } catch (e) {
      if (e instanceof RateLimitError) {
        note(true);
        for (const item of chunk) requeueOrDrop(item);
        // 60 秒封顶会在限流期反复撞击，反而拖长封禁；指数退到 10 分钟，
        // 连续 429 就一直等到配额恢复
        const wait = Math.min(10 * 60_000, 8000 * 2 ** backoffLevel);
        backoffLevel++;
        console.warn(
          `[trends] 批量 429（${chunk.length} 词回队列），退避 ${Math.round(wait / 1000)}s`,
        );
        await sleep(wait);
      } else {
        const msg = msgOf(e);
        note(false);
        // 网络抖动（代理瞬断、TLS 被切断）不是这些词本身的问题，
        // 整批算失败等于白跑一轮：上一轮 260 个词就是这么丢的
        if (/socket|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|aborted|TLS/i.test(msg)) {
          console.warn(`[trends] 批量网络抖动（${chunk.length} 词回队列）：${msg.slice(0, 70)}`);
          for (const item of chunk) requeueOrDrop(item);
        } else if (/^空序列/.test(msg)) {
          // 先问参照词：它也是空的说明是软限流，这 5 个词一个都不能判死
          if (await throttled()) {
            note(true);
            console.warn(`[trends] 参照词同样为空 → 软限流，${chunk.length} 词回队列`);
            for (const item of chunk) requeueOrDrop(item);
            await sleep(60_000);
            continue;
          }
          // 参照词有数据却整组为空：这 5 个词确实没量，直接记跳过表。
          // 逐个重取能把速度拖慢三倍（5 词 × 约 8 秒），而回捞率极低
          for (const item of chunk) {
            failed++;
            recordSkip(item.keyword, "整组空序列（参照词正常）");
          }
          console.warn(`[trends] 整组空序列（${chunk.length} 词）判为无量`);
        } else {
          failed += chunk.length;
          console.warn(`批量请求失败（${chunk.length} 词）：${msg}`);
        }
        await sleep(randomDelay());
      }
    }
  }

  // 原则自审：距上次修订超过间隔，就用本轮判定样本把误杀/漏放修回条目
  if (judgedNow.length > 0 && auditDue(policy)) {
    try {
      const next = await auditPolicy(policy, judgedNow);
      if (next.version !== policy.version) {
        policy = next;
        console.log(`[policy] 准入原则已迭代到 v${policy.version}`);
        next.notes.slice(0, 1).forEach((n) => console.log(`  记 · ${n}`));
      }
    } catch {
      // 审计失败不影响本轮采集结果
    }
  }

  saveDataset({
    ...dataset,
    keywords,
    policy,
    updatedAt: new Date().toISOString(),
    mode: "live",
    region: args.geo,
  });
  saveSkips(skips);
  console.log(
    `[trends] 完成：成功 ${ok}，失败 ${failed}，词库 ${keywords.length} 个，跳过表 ${skips.size} 条 → content/trends.json`,
  );
}

main().catch((e) => {
  console.error("[trends] 运行失败：", e);
  process.exit(1);
});