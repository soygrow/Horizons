/**
 * 后台「获取新工具」入口（由 .github/workflows/fetch-tools.yml 调用）。
 *
 * 结果**只写 D1 的 board_items**（候选池），不落任何仓库文件：
 * 后台读的就是它，审核通过后由 publish-tools.ts 合并进 content/aitools.json。
 *
 * 抓取源与本地一致，流量富化复用 backfill-traffic 的批次口径，
 * 因此后台点一次按钮 = 本地跑一次 pnpm fetch + backfill-traffic。
 *
 * 用法：
 *   pnpm tsx scripts/admin/fetch-staging.ts --count 60 --order newest --enrich
 *   pnpm tsx scripts/admin/fetch-staging.ts --count 20 --dry
 *   pnpm tsx scripts/admin/fetch-staging.ts --domains "picvo.ai,gamma.app" --enrich
 *
 * `--domains` 是「指定网站」模式：不跑 Product Hunt/HN/Futurepedia，
 * 直接把给定域名做成候选条目，后面的富化/判定/翻译/落库完全同一套逻辑。
 */
import fs from "node:fs";
import { getDomain } from "tldts";
import type { AITool } from "@horizons/shared";
import { config } from "../fetch/config"; // 顺带加载 .env.local
import { fetchProductHuntTools, closePHBrowser } from "../fetch/sources/productHunt";
import { fetchHackerNewsTools } from "../fetch/sources/hackerNews";
import { fetchFuturepediaTools } from "../fetch/sources/futurepedia";
import { loadExisting } from "../fetch/dedupe";
import { hasApify } from "../fetch/sources/apify";
import { fetchVortexMode, type SimilarwebItem } from "../field-collect/apify";
import {
  assertStore,
  currentPeriod,
  getRaw,
  saveRaw,
  saveTrafficMonths,
} from "../fetch/collect-store";
import {
  applyVortexAdmission,
  parseVortexBase,
  snapshotDateOf,
  type VortexSnapshot,
} from "../fetch/apply-vortex";
import { probeAll, fetchSiteMeta } from "./probe";
import { looksLikeAiProduct } from "../fetch/ai-relevance";
import { translateInPlace } from "../fetch/translate";
import { d1Configured } from "./d1-client";
import { listCandidates, syncCandidates, type ItemStatus } from "./board-items";
import {
  judge,
  visitsOf,
  MIN_VISITS_WATCH,
  WATCH_PH_UPVOTES,
  type StagingItem,
} from "./verdict";

/**
 * 单轮准入最多为多少个站购买 vortex base_data。
 *
 * 闸门位置：免费粗筛之后、付费调用之前。超出的**不丢弃**，只是留给下一轮
 * （它们的 card 已经落库，下一轮会重新进入候选池排队）。
 *
 * 为什么需要：Product Hunt 单日爆量时粗筛后可能剩上百个站，
 * 全买 vortex 就是 $0.2+/轮，且 Actions 45 分钟预算也跑不完。
 * 30 是按「单站串行 90s × 并发 3」估算的稳妥值。
 */
const MAX_VORTEX_BUY = 30;

/**
 * vortex 并发数。
 *
 * 单站一次独立 Actor run（$0.002），3 并发既能把 30 站压到 ~10 分钟，
 * 又不会因为同时开太多 run 撞 Apify 的账号并发上限。
 */
const VORTEX_CONCURRENCY = 3;

/** vortex base_data 参考单价，仅用于日志估算 */
const VORTEX_BASE_USD = 0.002;
/** 单次最多抓 200 个：再多 Actions 容易超时，且后台一次审核不过来 */
const MAX_COUNT = 200;
/**
 * 指定网站单次上限。
 * 每站要探活（最坏 12s 超时）+ 流量富化 + 翻译，50 个在 45 分钟的 job 预算内仍然安全。
 */
const MAX_MANUAL = 50;
/** 指定网站的元信息抓取并发：同一个域名的首页，一次 6 个足够，再高容易被 WAF 拦 */
const META_CONCURRENCY = 6;

/* ------------------------------- 参数解析 ------------------------------- */

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function arg(name: string): string | undefined {
  // 同时认 `--count 4` 和 `--count=4`：只认前者时，本地带等号会静默跑成默认值
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function intArg(name: string, fallback: number): number {
  const raw = Number(arg(name));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), MAX_COUNT);
}

/**
 * 解析「指定网站」列表。
 *
 * 后台一个输入框里粘贴的东西很杂：完整 URL、带 www、逗号/顿号/换行/空格分隔，
 * 这里统一归一成注册域（与 Product Hunt/HN/Futurepedia 三个源同一个 tldts 口径），
 * 免得不带协议、带路径的写法被当成不同域名重复入池。
 */
function parseDomains(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const piece of raw.split(/[\s,，、;；]+/)) {
    const s = piece.trim();
    if (!s) continue;
    let host: string;
    try {
      host = new URL(s.includes("://") ? s : `https://${s}`).hostname;
    } catch {
      continue;
    }
    const domain = (getDomain(host) || host).toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) continue;
    if (!out.includes(domain)) out.push(domain);
  }
  return out.slice(0, MAX_MANUAL);
}

/* ------------------------------- 落库辅助 ------------------------------- */

/** Actions 靠它判断要不要提交快照；本地跑没有这个文件，直接忽略 */
function setGithubOutput(pairs: Record<string, string | number>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

/** 候选池只有 D1 一处，写不进去就等于白跑，宁可失败也不要静默成功 */
function assertD1(): void {
  if (d1Configured()) return;
  throw new Error(
    "未配置 D1 通道（CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / D1_DATABASE_ID），候选池无处可写",
  );
}

/* ------------------------------- 站点存活探测 ------------------------------- */
/* probeAlive / probeAll 在 ./probe.ts，与 audit-existing.ts 共用同一份规则 */

/* ------------------------------- 准入采集 ------------------------------- */

/** 固定并发的 worker pool：n 个 worker 从同一个游标取下标，不预先分片 */
async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * 准入采集：一次调用拿到判定与后续展示所需的全部流量数据。
 *
 * 为什么是 vortex `base_data` 而不是批量 lergassy：
 *
 *   - 它是「月访问量 + 渠道 + 关键词 + AI 引荐 + 互动指标」的唯一来源，
 *     准入买过之后富化阶段只读 `collect_raw`，同一个域名全生命周期只付一次钱；
 *   - 月度序列可以顺带写进 `traffic_history`，趋势图按月累积、缺月补 0。
 *
 * 三阶段执行，且**只有买数据是并发的**：
 *
 *   1. 串行查库 —— 命中直接 0 成本，D1 单次查询很快；
 *   2. 并发买未命中的 —— vortex 单站 40~90s，3 并发把 30 站压到 ~10 分钟；
 *   3. 串行落库 —— d1-client 顺序执行的设计不变，避免并发写互相等锁。
 *
 * 返回 domain → 快照，供 `judge()` 读取可信度信号（dataCoverage / isSmall）。
 */
async function collectAdmission(items: AITool[]): Promise<Map<string, VortexSnapshot>> {
  const out = new Map<string, VortexSnapshot>();
  if (items.length === 0) return out;
  if (!hasApify()) {
    console.warn("[staging] 未配置 APIFY_TOKEN，跳过准入流量采集");
    return out;
  }
  // 表缺了就会每轮重复买 vortex，付钱前先挡掉
  await assertStore();

  // 闸门：超出的站不买，card 已落库，下一轮会重新排队
  const budget = items.slice(0, MAX_VORTEX_BUY);
  const deferred = items.length - budget.length;
  if (deferred > 0) {
    console.log(
      `[staging] 准入上限 ${MAX_VORTEX_BUY} 站/轮，${deferred} 个留待下一轮（不丢弃）`,
    );
  }

  const period = currentPeriod();

  /* ① 查库：本快照月份已经买过就直接用 */
  const pending: AITool[] = [];
  for (const tool of budget) {
    const hit = await getRaw<SimilarwebItem>(tool.domain, "vortex_base", period);
    if (hit?.ok && hit.payload) {
      const snap = parseVortexBase(hit.payload, hit.period || period);
      applyVortexAdmission(tool, snap);
      out.set(tool.domain.toLowerCase(), snap);
      continue;
    }
    pending.push(tool);
  }
  if (budget.length > pending.length) {
    console.log(
      `[staging] vortex 命中缓存 ${budget.length - pending.length} 个（$0 复用），待购买 ${pending.length} 个`,
    );
  }

  if (pending.length === 0) return out;

  /* ② 并发购买：外部调用并发，不碰 D1 */
  type Fetched = {
    tool: AITool;
    item: SimilarwebItem | null;
    snap: VortexSnapshot | null;
    error?: string;
  };
  const fetched = await runPool<AITool, Fetched>(pending, VORTEX_CONCURRENCY, async (tool) => {
    const r = await fetchVortexMode(tool.domain, "base_data");
    if (!r.item) return { tool, item: null, snap: null, error: r.error ?? "Actor 返回空数组" };
    const snap = parseVortexBase(r.item, period);
    if (snap.monthlyVisits === undefined) {
      return { tool, item: r.item, snap: null, error: "vortex 未返回月访问量" };
    }
    return { tool, item: r.item, snap };
  });

  /* ③ 串行落库 + 写回 AITool */
  let spent = 0;
  let ok = 0;
  for (const f of fetched) {
    const domain = f.tool.domain.toLowerCase();
    if (!f.snap || !f.item) {
      // 失败也记一行：后台能看出「这个站试过了、失败了」，账目记 0
      await saveRaw({
        domain,
        source: "vortex_base",
        period,
        ok: false,
        payload: null,
        error: f.error ?? "无数据",
        costUsd: 0,
        via: "admission",
      });
      // 注意：这个站仍会落进候选池，之后的采集会因「已见过」而跳过。
      // 要补数据得在后台点「重判」，或把它放进 --domains 手动重抓。
      console.warn(
        `[staging] vortex 无数据：${domain}（${f.error ?? "未知"}）—— 已进候选池，需手动重抓`,
      );
      continue;
    }

    await saveRaw({
      domain,
      source: "vortex_base",
      period,
      ok: true,
      payload: f.item,
      error: null,
      costUsd: VORTEX_BASE_USD,
      via: "admission",
    });
    // 一次写入返回的全部月份：vortex 每次给 3 个月，采两次就能填满 6 格趋势图
    await saveTrafficMonths(domain, f.snap.months, { snapshotDate: snapshotDateOf() });

    applyVortexAdmission(f.tool, f.snap);
    f.tool.collectedAt = new Date().toISOString();
    out.set(domain, f.snap);
    spent += VORTEX_BASE_USD;
    ok++;
  }

  console.log(
    `[staging] 准入采集完成 ${ok}/${pending.length} 个｜本次花费 ≈$${spent.toFixed(4)}` +
      `（命中缓存 ${budget.length - pending.length} 个未计费）`,
  );
  return out;
}

/* ------------------------------- 多源合并抓取 ------------------------------- */

/**
 * 多源合并，Product Hunt 是主源。
 *
 * PH 的产品质量明显高于另两个源（真实上线、有票数背书、AI 分类过滤生效），
 * 所以由它先吃满预算；HN 和 Futurepedia 只补 PH 剩下的缺口。
 *
 * PH 的 `/r/` 短链被 Cloudflare 挑战覆盖，域名靠「名字 + slug 推断 + 探活校验」，
 * 拿不准的直接丢弃（实测准确率 100%、覆盖约六成），所以不必担心主源会灌水。
 *
 * 三个源共用同一份 `existingNames` / `seen`，先到先得，天然去重。
 * 任一源抛错只降级不中断，避免一个源挂掉拖垮整轮采集。
 */
async function fetchAllSources(
  count: number,
  order: "VOTES" | "NEWEST",
  topic: string,
  existingNames: Set<string>,
  seen: Set<string>,
  days: number,
): Promise<AITool[]> {
  const out: AITool[] = [];

  // 主源：Product Hunt
  if (out.length < count) {
    try {
      const ph = await fetchProductHuntTools(
        count - out.length,
        order,
        topic,
        existingNames,
        seen,
        undefined,
        days,
      );
      out.push(...ph);
    } catch (e) {
      console.warn(`[staging] Product Hunt 抓取失败：${e instanceof Error ? e.message : e}`);
    } finally {
      await closePHBrowser();
    }
  }

  // 补位：HN 走公开 API、直接给真实域名，最稳
  if (out.length < count) {
    try {
      const hn = await fetchHackerNewsTools(count - out.length, existingNames, seen);
      out.push(...hn.items);
    } catch (e) {
      console.warn(`[staging] HN 抓取失败：${e instanceof Error ? e.message : e}`);
    }
  }

  // 补位：Futurepedia 一个请求就能拿完
  if (out.length < count) {
    try {
      const fp = await fetchFuturepediaTools(count - out.length, existingNames, seen);
      out.push(...fp.items);
    } catch (e) {
      console.warn(`[staging] Futurepedia 抓取失败：${e instanceof Error ? e.message : e}`);
    }
  }

  console.log(`[staging] 多源合并完成：${out.length}/${count}`);
  return out;
}

/* ----------------------------- 指定网站（人工名单） ----------------------------- */

/**
 * 从首页 title 里取产品名。
 * 常见写法是「Picvo — AI 修图」「Picvo | Home」「Picvo - AI photo editor」，
 * 第一段才是名字；整句当名字会让候选池里一列全是描述句。
 */
function nameFromTitle(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const first = title.split(/\s+[|·—–]\s+|\s+-\s+/)[0]?.trim() ?? "";
  const name = first || title.trim();
  if (name.length < 2 || name.length > 40) return undefined;
  return name;
}

/** 名字的最终兜底：域名主体（picvo.ai → Picvo）；至少短且唯一 */
function nameFromDomain(domain: string): string {
  const sld = domain.split(".")[0] ?? domain;
  return (
    sld
      .split(/[-_]/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || domain
  );
}

/**
 * 把人工指定的域名做成候选条目。
 *
 * 这三个源之外没有「名字 + 简介」可用，所以抓一次首页取 title/description；
 * 抓不到（SPA、纯 JS 渲染、被拦截）就退回域名主体，不至于让审核页出现空白名字。
 * heatScore 记 0：指定网站本来就没有 PH/HN 热度信号，编一个数只会污染排序。
 */
async function buildManualTools(domains: string[]): Promise<AITool[]> {
  const now = new Date().toISOString();
  const out: AITool[] = [];

  for (let i = 0; i < domains.length; i += META_CONCURRENCY) {
    const chunk = domains.slice(i, i + META_CONCURRENCY);
    const metas = await Promise.all(chunk.map((d) => fetchSiteMeta(`https://${d}`)));
    chunk.forEach((domain, idx) => {
      const meta = metas[idx];
      const name = nameFromTitle(meta?.title) ?? nameFromDomain(domain);
      const url = `https://${domain}`;
      out.push({
        id: `tool-manual-${domain.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`,
        name: name.slice(0, 80),
        domain,
        url,
        description: (meta?.description ?? "").slice(0, 160) || `${name} 官网`,
        descriptionSource: "source",
        categories: ["Other"],
        industry: "人工智能",
        heatScore: 0,
        phUpvotes: null,
        phComments: null,
        hnPoints: null,
        firstSeenAt: now,
        collectedAt: now,
        verified: "pending",
        sourceType: "manual",
        sourceUrl: url,
      });
    });
    console.log(`[staging] 站点信息 ${Math.min(i + META_CONCURRENCY, domains.length)}/${domains.length}`);
  }

  return out;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main(): Promise<void> {
  const dryRun = has("dry");
  const enrich = !has("no-enrich");
  const count = intArg("count", config.maxPerRun);
  const order = arg("order") === "newest" ? ("NEWEST" as const) : ("VOTES" as const);
  const topic = arg("topic") ?? config.productHunt.topicSlugs[0];
  /** PH 时间窗（天）。0 表示不限，一般没必要——见 fetchProductHuntTools 的注释 */
  const days = intArg("days", 30);
  /** 非空 = 指定网站模式，count/order/topic/days 全部忽略 */
  const manualDomains = parseDomains(arg("domains"));

  if (!dryRun) assertD1();

  const existing = loadExisting();
  // 候选池只从 D1 读：已拒绝的域名也算「见过」，否则后台点过拒绝的下次还会被抓回来
  const pool = await listCandidates<StagingItem>("tools");

  // 已发布 + 候选池（含已拒绝），两类都算「见过」，避免重复抓取占额度
  const seen = new Set<string>([
    ...existing.map((t) => t.domain),
    ...pool.map((d) => d.itemKey),
  ]);
  const existingNames = new Set([
    ...existing.map((t) => t.name.toLowerCase()),
    ...pool.map((d) => d.name.toLowerCase()),
  ]);

  if (manualDomains.length) {
    console.log(
      `[staging] 指定网站 ${manualDomains.length} 个｜来源 人工名单` +
        `｜富化 ${enrich ? "开" : "关"}${dryRun ? "｜dry-run" : ""}`,
    );
  } else {
    console.log(
      `[staging] 目标 ${count} 个｜来源 Product Hunt(主, ${order}/近${days}天/${topic}) + HN + Futurepedia` +
        `｜富化 ${enrich ? "开" : "关"}${dryRun ? "｜dry-run" : ""}`,
    );
  }

  let fresh: AITool[];
  if (manualDomains.length) {
    /*
     * 指定网站的取舍：
     *   - 已发布的跳过：它已经在线上榜单里，要刷新数据应该走「重判」，再入候选池等于制造重复条目；
     *   - 候选池里「已拒绝」的允许重抓：手动点名就是明确的重新评估意图，UPSERT 会把状态改回来；
     *   - 候选池里其他状态（待审核/已确认/已富化）跳过：那已经有人审过了，重抓会用简化的
     *     card 覆盖掉富化结果与审核进度。
     */
    const published = new Set(existing.map((t) => t.domain.toLowerCase()));
    const poolStatus = new Map(pool.map((p) => [p.itemKey.toLowerCase(), p.status]));
    const blocked: string[] = [];
    const todo: string[] = [];
    for (const d of manualDomains) {
      if (published.has(d)) {
        blocked.push(`${d}（已在线上榜单，刷新请用「重判」）`);
        continue;
      }
      const st = poolStatus.get(d);
      if (st && st !== "rejected") {
        blocked.push(`${d}（已在候选池，状态 ${st}）`);
        continue;
      }
      todo.push(d);
    }
    if (blocked.length) {
      console.log(`[staging] 跳过 ${blocked.length} 个：\n  - ${blocked.join("\n  - ")}`);
    }
    fresh = await buildManualTools(todo);
    console.log(`[staging] 指定网站 ${manualDomains.length} 个 → 待处理 ${fresh.length} 个`);
  } else {
    fresh = await fetchAllSources(count, order, topic, existingNames, seen, days);
    console.log(`[staging] 新增候选 ${fresh.length}/${count} 个（跳过原因见上方 [fetch] 日志）`);
  }

  if (fresh.length === 0) {
    console.log("[staging] 无新增，候选池未变动");
    console.log(JSON.stringify({ added: 0, enriched: 0, total: pool.length }));
    setGithubOutput({ added: 0, judged: 0, total: pool.length });
    return;
  }

  // A1 粗筛：HN 和 Futurepedia 也会混进非 AI 的东西（硬件、通用 SaaS）。
  // 先按名称+简介过滤，省掉这些条目的流量查询与探活开销。
  // 指定网站不筛：审核员点名要看的站，不该被关键词规则挡在门外；
  // 这类条目只有首页 title/description，英文关键词匹配本来就不如源站 tagline 可靠。
  const manual = manualDomains.length > 0;
  const relevant = manual ? fresh : fresh.filter((t) => looksLikeAiProduct(t));
  const relevantDomains = new Set(relevant.map((t) => t.domain));
  const offTopic = fresh.length - relevant.length;
  if (offTopic > 0) {
    console.log(`[staging] A1 粗筛剔除 ${offTopic} 个（名称/简介无 AI 相关词）`);
  }

  // 准入即采集：vortex base_data 是全链路唯一付费的流量来源。
  // 富化阶段直接读 collect_raw，同一个域名不会再买第二次。
  const snapshots = enrich
    ? await collectAdmission(relevant)
    : new Map<string, VortexSnapshot>();
  if (enrich) {
    console.log(`[staging] 流量判定字段就绪 ${snapshots.size}/${relevant.length}`);
  }

  // 第二阶段之前的「判定」：只靠 A1–A4 必需字段定 tier，
  // 不做 DFS 关键词/外链/AI 解读——那部分要等人工确认收录后再手动触发。
  // 探活短路：流量和 PH 票都不够的条目，A4 已经能判死，再发一次 GET 纯属浪费
  const needProbe = has("no-probe")
    ? []
    : relevant.filter((t) => {
        // 指定网站一律探活：它们没有 PH/HN 热度可依，判定只剩流量 + 站点是否活着，
        // 少探这一次会把「没法判断」写成「无流量无热度」。
        if (manual) return true;
        const v = visitsOf(t);
        if (v !== undefined) return v >= MIN_VISITS_WATCH;
        return (t.phUpvotes ?? 0) >= WATCH_PH_UPVOTES;
      });
  const skippedProbe = relevant.length - needProbe.length;
  if (skippedProbe > 0) {
    console.log(`[staging] 跳过探活 ${skippedProbe} 个（流量与 PH 票均不足，A4 已可判定）`);
  }
  const aliveMap: Map<string, boolean | null> = needProbe.length
    ? await probeAll(needProbe)
    : new Map<string, boolean | null>();
  console.log(`[staging] 存活探测 ${needProbe.length} 个`);
  const items: StagingItem[] = fresh.map((t) => {
    // 第 4 个参数带 Similarweb 可信度：样本不足的站即使数够主榜也进观察区。
    // 超出准入上限、本轮没采到的站没有快照，judge 走原有的 PH 票兜底逻辑。
    const verdict = judge(
      t,
      aliveMap.get(t.domain) ?? null,
      relevantDomains.has(t.domain),
      snapshots.get(t.domain.toLowerCase()),
    );
    return { ...t, verdict, stage: verdict.tier === "reject" ? "rejected" : "candidate" };
  });
  const tally = { core: 0, watch: 0, reject: 0 };
  for (const it of items) tally[it.verdict!.tier]++;
  console.log(
    `[staging] 判定结果：主榜 ${tally.core}｜观察区 ${tally.watch}｜不收录 ${tally.reject}`,
  );

  // 判定之后、落库之前翻译：判定只看流量与票数，跟语言无关；
  // 而 A1 粗筛（looksLikeAiProduct）是按英文关键词匹配的，翻译必须放在它后面，
  // 否则中文描述会把 AI 相关词抹掉，条目会被误判成非 AI 产品剔掉。
  const zh = await translateInPlace(items);
  console.log(
    `[staging] 中文描述：本次翻译 ${zh.translated} 条｜失败 ${zh.failed} 条｜已是中文 ${zh.skipped} 条`,
  );

  if (dryRun) {
    console.log("[staging] dry-run，以下为将写入的条目：");
    console.log(JSON.stringify(items, null, 2));
    return;
  }

  // 只写候选池（D1）。不做「读旧队列 → 合并 → 全量回写」：
  // 那是文件时代的产物，UPSERT 天然只影响本次涉及的域名，也避免覆盖后台刚改的状态。
  const saved = await syncCandidates(
    "tools",
    items.map((t) => ({
      itemKey: t.domain,
      name: t.name,
      url: t.url ?? null,
      cats: t.categories ?? null,
      status: (t.stage === "rejected" ? "rejected" : "candidate") as ItemStatus,
      judge: t.verdict,
      card: t,
    })),
  );

  // 没有文件兜底了：写不全就是后台缺数据，必须让这一步红掉
  if (saved !== items.length) {
    throw new Error(`候选池写入不完整：${saved}/${items.length}，已中止以免后台缺条目`);
  }

  const total = new Set([...pool.map((d) => d.itemKey), ...items.map((t) => t.domain)]).size;
  console.log(`[staging] 已写入 D1 候选池｜本次 ${saved} 条（新增 ${fresh.length}），队列 ${total} 条`);

  setGithubOutput({ added: fresh.length, judged: items.length, total });
  // 指定网站模式下「请求数」是名单条数，不是 --count（那里可能是默认 60，写进日志会误导）
  const requested = manual ? manualDomains.length : count;
  // Actions 日志里以单行 JSON 结尾，方便人工与脚本解析
  console.log(
    JSON.stringify({
      added: fresh.length,
      judged: items.length,
      core: tally.core,
      watch: tally.watch,
      reject: tally.reject,
      total,
      // 富化已拆到 enrich-staging，本脚本不再统计富化条数；
      // 键名保留是为了不打断已有日志解析（同上方无新增分支）。
      enriched: 0,
      requested,
      skipped: Math.max(0, requested - fresh.length),
    }),
  );
}

main().catch((e) => {
  console.error("[staging] 失败：", e);
  process.exit(1);
});