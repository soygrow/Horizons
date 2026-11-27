/**
 * 后台「工具榜」API：抓取任务、待发布审核、发布上线。
 *
 * Worker 跑不了 Playwright，也写不了仓库文件，所以这里只做三件事：
 *   1. 通过 GitHub API 触发 fetch-tools.yml / publish-tools.yml；
 *   2. 候选池与各类报告只读 D1（board_items / board_reports）；
 *   3. 把每次点击记到 D1 的 tool_jobs，便于回看结果。
 *
 * 后台只有一个人看，所以数据源必须是单一的：库里没有就是没有，
 * 不再回落仓库 JSON —— 两份数据一旦分叉，先改哪份、以谁为准都说不清。
 *
 * 鉴权与 CSRF 由 admin.ts 的 `admin.use("*")` 统一兜住。
 */
import { type TierInput, tierOf } from "@horizons/shared";
import { Hono, type Context } from "hono";
import type { Env } from "../env";
import {
  dispatchWorkflow,
  fetchRun,
  ghConfig,
  type GhConfig,
  latestRun,
  mapStatus,
  missingSecrets,
  type WorkflowRun,
} from "../lib/github";
import { readBoardStats, type BoardStats } from "../lib/board-stats";
import {
  deleteAllPublished,
  deletePublished,
  expireStaleEnriching,
  expireStalePublishing,
  hasWorkspace,
  listWorkspace,
  markEnriching,
  markPublishing,
  listEnrichingItems,
  PUBLISH_TIMEOUT_MS,
  releasePublishing,
  releaseStalePublishing,
  setItemsStatus,
  settleEnriching,
} from "../lib/board-items";
import { readReport } from "../lib/reports";

const tools = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const GH_API = "https://api.github.com";
const FETCH_WORKFLOW = "fetch-tools.yml";
const ENRICH_WORKFLOW = "enrich-tools.yml";
const PUBLISH_WORKFLOW = "publish-tools.yml";
const AUDIT_WORKFLOW = "audit-tools.yml";
/** 整站构建（预览页是构建期产物，重采只改 D1，不重建就看不到新数据） */
const DEPLOY_WORKFLOW = "deploy-site.yml";

const MAX_COUNT = 200;
const MAX_PAGE_SIZE = 100;
/** 指定网站单次上限，与 scripts/admin/fetch-staging.ts 的 MAX_MANUAL 保持一致 */
const MAX_MANUAL_DOMAINS = 50;
/**
 * 线上更新单批上限。
 *
 * Actions 单 job 60 分钟硬上限，实测重采一条 3~4 分钟（以前按 60~90 秒估，
 * 30 条永远跑不完：跑满 60 分钟只到第 17 条就被 kill）。
 * enrich-staging 现在默认并发 3 跑站内管线（见 ENRICH_CONCURRENCY），
 * 单批 15 条约 15~18 分钟，60 分钟窗口留足余量（30 条压线，一旦某个站卡到
 * 单站超时就会挤掉收尾时间）；后台按这个数把一次选择拆成多批串行排队。
 */
const MAX_REFRESH_DOMAINS = 15;

/**
 * 清洗后台「指定网站」输入。
 *
 * 只做轻量处理（去协议/www/路径、小写、去重），注册域归一交给 fetch-staging 的 tldts：
 * 这里一份、脚本一份会立刻分叉，而真正的判定在脚本那边。
 * 数组内再按分隔符拆一次，是为了兼容前端把整段文本当单个字符串传上来的情况。
 */
function normalizeDomainInput(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    for (const piece of item.split(/[\s,，、;；]+/)) {
      const s = piece
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/[/?#].*$/, "");
      if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(s)) continue;
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.slice(0, MAX_MANUAL_DOMAINS);
}

/* ------------------------------- 收录口径 ------------------------------- */
/**
 * 收录判定统一由 `@horizons/shared` 的 tool-tier 提供（见文件顶部 import）。
 *
 * 此前这里有一份漏掉 isBlockedDomain 的副本，导致被黑名单屏蔽的域名
 * 在后台显示为「已收录」，站点却不上榜。不要再在本地复制这段逻辑。
 */

/* GitHub 封装见 ../lib/github：与趋势榜后台共用一份 */

/**
 * 报告类数据（统计快照 / 字段体检 / 存量重判）只读 D1。
 *
 * 这些产物由脚本生成，脚本写文件时顺手 upsert 进 board_reports。
 * 库里没有就是脚本没跑过或落库失败 —— 后台显示「暂无数据」，
 * 让人去看流水线日志，比拿一份可能过期的文件顶上更可信。
 */
async function loadReport<T>(env: Env, key: string): Promise<T | null> {
  const row = await readReport<T>(env.DB, key);
  return row?.data ?? null;
}

/* -------------------------------- 任务记录 -------------------------------- */

interface JobRow {
  id: string;
  kind: string;
  status: string;
  params: string;
  gh_run_id: number | null;
  run_url: string | null;
  summary: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}


/** 没有 run id 的行，留多久还算「刚派发」；超过就判死（run 偶尔建得慢） */
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

async function refreshJob(env: Env, cfg: GhConfig | null, row: JobRow): Promise<JobRow> {
  if (["success", "failure", "cancelled"].includes(row.status)) return row;

  /*
   * 没有 run id 就无从回源：这类行是 dispatch 那一步没反查到运行编号留下的，
   * 查不到状态、也不会自己变失败，会永远占着「排队中」，前端还一直每 12 秒轮询。
   * 给两分钟宽限后直接判死，让被占住的条目退回可重发。
   */
  if (!row.gh_run_id) {
    if (Date.now() - row.created_at < ORPHAN_GRACE_MS) return row;
    const now = Date.now();
    const error = "dispatch_unconfirmed";
    await env.DB.prepare(
      "UPDATE tool_jobs SET status = 'failure', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(error, now, row.id)
      .run();
    return { ...row, status: "failure", error, updated_at: now };
  }

  if (!cfg) return row;

  const run = await fetchRun(cfg, row.gh_run_id);
  if (!run) return row;
  const status = mapStatus(run, row.status);
  if (status === row.status) return row;

  const now = Date.now();
  await env.DB.prepare("UPDATE tool_jobs SET status = ?, run_url = ?, updated_at = ? WHERE id = ?")
    .bind(status, run.html_url ?? row.run_url, now, row.id)
    .run();
  return { ...row, status, run_url: run.html_url ?? row.run_url, updated_at: now };
}

/**
 * 发布任务终结时，把被占住的条目落成最终态。
 *
 * 成功由流水线自己写 published（只有它知道哪些真的进了榜），这里只处理失败：
 * 把 publishing 退回 publish_failed，让后台能重新选中再发一次 —— 否则条目会
 * 一直挂在「发布中」，既发不出去也删不掉。
 */
async function settlePublishJob(env: Env, job: JobRow, prevStatus: string): Promise<void> {
  if (job.kind !== "publish") return;
  if (job.status !== "failure" && job.status !== "cancelled") return;
  if (job.status === prevStatus) return;

  let domains: string[] = [];
  try {
    const p = JSON.parse(job.params) as { domains?: unknown };
    if (Array.isArray(p.domains)) {
      domains = p.domains.filter((d): d is string => typeof d === "string" && d.length > 0);
    }
  } catch {
    // 老任务可能没有 params：退回该榜全部「发布中」，宁可多退不可卡住
  }
  const n = await releasePublishing(env.DB, "tools", domains).catch(() => 0);
  if (n > 0) console.log(`[publish] 任务${job.status}，${n} 条退回「发布失败」可重发`);
}

/**
 * 富化任务失败/取消时，把被它占住的条目落成「富化失败」。
 *
 * 脚本正常跑完会自己写（成功 → enriched、失败 → enrich_failed、没跑到的 → approved），
 * 但子进程崩溃、任务被 cancel、Actions 超时硬杀时收尾根本不执行，这批条目就一直挂着
 * 「富化中」：后台复选框禁用、富化也选不中，跟运行记录里「失败 N 条」的数量对不上，
 * 只能等 60 分钟超时 —— 而超时兜底靠 updated_at，任何一次写库都会把计时往后推，
 * 实际常常等不到（11-26 tiden.ai 卡了两小时就是这么来的）。
 *
 * 这里按任务参数里记的名单把失败落定，与运行记录对齐，且能重新勾选重试。
 * 只处理失败/取消：成功说明脚本跑到了收尾，孤儿已被脚本自己退回待富化；
 * 此时再动名单反倒会把「刚提交、正在排队」的下一批占位抢掉。
 */
async function settleEnrichJob(env: Env, job: JobRow, prevStatus: string): Promise<void> {
  if (job.kind !== "enrich") return;
  if (job.status === prevStatus) return;
  if (job.status !== "failure" && job.status !== "cancelled") return;

  let domains: string[] = [];
  try {
    const p = JSON.parse(job.params) as { domains?: unknown };
    if (Array.isArray(p.domains)) {
      domains = p.domains.filter((d): d is string => typeof d === "string" && d.length > 0);
    }
  } catch {
    // 老任务没有 params：名单未知就不猜，留给脚本收尾与超时兜底
  }
  const n = await settleEnriching(env.DB, "tools", domains).catch(() => 0);
  if (n > 0) console.log(`[enrich] 任务${job.status}，${n} 条又挂在「富化中」，已判「富化失败」可重试`);
}

async function listJobs(env: Env, limit: number): Promise<JobRow[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM tool_jobs ORDER BY created_at DESC LIMIT ?",
  )
    .bind(limit)
    .all<JobRow>();
  return results ?? [];
}

/* ---------------------------------- 路由 ---------------------------------- */

/** 概览数字读 tools-stats.json（几百字节），不碰 8MB 的 aitools.json */
tools.get("/overview", async (c) => {
  const cfg = ghConfig(c.env);
  const missing = missingSecrets(c.env);
  const jobs = await listJobs(c.env, 5);
  // 在榜条数走 D1：即使 GitHub 未配置、快照读不到，这个数字依然可用
  const board = (await readBoardStats(c.env.DB).catch(() => ({}) as BoardStats)).tools ?? null;

  // 统计快照也走 D1：脚本生成快照时已落库，不再为了几个数字去读仓库
  try {
    const stats = await loadReport<Record<string, unknown>>(c.env, "tools-stats");
    return c.json({ configured: Boolean(cfg), missing, stats, board, jobs });
  } catch (e) {
    return c.json({
      configured: Boolean(cfg),
      missing,
      stats: null,
      board,
      jobs,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

tools.get("/jobs", async (c) => {
  const cfg = ghConfig(c.env);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, MAX_PAGE_SIZE);
  const rows = await listJobs(c.env, limit);
  // 所有「还没终结」的行都要回源校准，不能只看前 5 条：
  // 一旦队列里积下 queued 僵尸（run 早结束但状态没同步），前端按活跃数算展示条数时
  // 会多出一行 —— 点一次抓取变 4 条、刷新后又缩回 3 条，就是这个原因。
  // 上限 10 只是防极端情况下一次性打太多 GitHub 请求。
  /*
   * 只排除三种终态，而不是只挑 queued/running：
   * 库里可能残留旧版本写进来的 pending（GitHub 的中间态被原样落库），
   * 按白名单筛就永远捞不到它，那一行会一直卡在「排队中」。
   */
  const live = rows
    .filter((r) => r.status !== "success" && r.status !== "failure" && r.status !== "cancelled")
    .slice(0, 10);
  const refreshed = new Map<string, JobRow>();
  const settled: Promise<void>[] = [];
  await Promise.all(
    live.map(async (r) => {
      const next = await refreshJob(c.env, cfg, r);
      refreshed.set(r.id, next);
      // 发布任务刚判死：顺手把条目从「发布中」退回，前端下一次刷新就能重发
      settled.push(settlePublishJob(c.env, next, r.status));
      // 富化任务终结（成功/失败/取消）：把还挂在「富化中」的条目落定，
      // 否则它们既不能重选也不会自己消失，运行记录与队列数字永远对不上
      settled.push(settleEnrichJob(c.env, next, r.status));
    }),
  );
  await Promise.all(settled);
  return c.json({ jobs: rows.map((r) => refreshed.get(r.id) ?? r) });
});

tools.post("/jobs", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // 指定网站优先：填了名单就按名单抓，count/order/topic 由脚本忽略
  const domains = normalizeDomainInput(body.domains);
  const count = domains.length
    ? domains.length
    : Math.max(1, Math.min(Number(body.count ?? 60) || 60, MAX_COUNT));
  const order = body.order === "votes" ? "votes" : "newest";
  const topic =
    typeof body.topic === "string" && body.topic.trim()
      ? body.topic.trim()
      : "artificial-intelligence";
  const enrich = body.enrich !== false;
  const note = typeof body.note === "string" ? body.note.slice(0, 120) : "";

  const id = crypto.randomUUID();
  const now = Date.now();

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, FETCH_WORKFLOW, {
      count: String(count),
      order,
      topic,
      enrich: String(enrich),
      // workflow_dispatch 的 input 是单行字符串，逗号分隔交给脚本再拆
      domains: domains.join(","),
      job_id: id,
    });
  } catch (e) {
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO tool_jobs (id, kind, status, params, gh_run_id, run_url, created_at, updated_at)
     VALUES (?, 'fetch', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      run ? mapStatus(run, "queued") : "queued",
      JSON.stringify({ count, order, topic, enrich, note, ...(domains.length ? { domains } : {}) }),
      run?.id ?? null,
      run?.html_url ?? null,
      now,
      now,
    )
    .run();

  const { results } = await c.env.DB.prepare("SELECT * FROM tool_jobs WHERE id = ?")
    .bind(id)
    .all<JobRow>();
  return c.json({ job: results?.[0] ?? null });
});

tools.get("/jobs/:id", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM tool_jobs WHERE id = ?")
    .bind(c.req.param("id"))
    .all<JobRow>();
  const row = results?.[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  const job = await refreshJob(c.env, ghConfig(c.env), row);
  await Promise.all([
    settlePublishJob(c.env, job, row.status),
    settleEnrichJob(c.env, job, row.status),
  ]);
  return c.json({ job });
});

/**
 * 页面展示的 15 个数据维度，与 scripts/admin/verdict.ts 的 FIELD_DIMENSIONS 对齐。
 *
 * 为什么在 API 里再算一遍：card 里的 fieldGaps 只在「富化成功」那天写过，
 * 采集入库的条目压根没这个字段，接口一律 ?? [] 返回空数组，
 * 后台就把一条缺关键词/外链/AI 解读的条目显示成「缺失：完整」。
 */
const FIELD_PATHS = [
  "description",
  "categories",
  "trafficMetrics.monthlyVisits",
  "trafficMetrics.monthlyVisitsGrowth",
  "metrics.registeredAt",
  // 自然搜索量：新方案写在 trafficMetrics，searchTraffic 已无生产者
  "trafficMetrics.organicSearchVisits",
  "geoDistribution",
  "keywords",
  "observations.competitors",
  "pricing",
  "pageStructure",
  "screenshotDesktopUrl",
  "siteAudit",
  "aiInsight",
] as const;

function hasValueAt(t: Record<string, unknown>, path: string): boolean {
  const v = path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, t);
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** 实时算还缺哪些维度；存过的不再信任，口径以当前卡片数据为准 */
function fieldGapsOf(t: Record<string, unknown>): string[] {
  return FIELD_PATHS.filter((p) => !hasValueAt(t, p));
}

/** 待发布队列：只读 board_items，返回列表页需要的精简字段 */
tools.get("/staging", async (c) => {
  /*
   * 超时兜底：富化中超过 10 分钟判失败。
   *
   * 有任务在跑时先不动 —— 10 条是串行跑的，排后面的条目到点时其实还没轮到，
   * 按时间判死会让用户在任务跑到一半时看到一片「富化失败」。
   * 但 job 本身也可能卡死（DB 里永远是 running），所以超过 workflow 的 60 分钟
   * 上限后照样判死，不能指望人工去清。
   */
  const running = await c.env.DB.prepare(
    "SELECT created_at FROM tool_jobs WHERE kind='enrich' AND status IN ('queued','running')" +
      " ORDER BY created_at DESC LIMIT 1",
  ).first<{ created_at: number }>();
  const jobStale = !running || Date.now() - running.created_at > 60 * 60 * 1000;
  if (jobStale) {
    const expired = await expireStaleEnriching(c.env.DB, "tools").catch(() => 0);
    if (expired > 0) console.log(`[staging] ${expired} 条富化超时，已标记失败`);
  }

  // 发布同理：流水线卡死时不能让条目永远停在「发布中」，否则既发不出去也删不掉
  const publishRun = await c.env.DB.prepare(
    "SELECT created_at FROM tool_jobs WHERE kind='publish' AND status IN ('queued','running')" +
      " ORDER BY created_at DESC LIMIT 1",
  ).first<{ created_at: number }>();
  const publishStale = !publishRun || Date.now() - publishRun.created_at > PUBLISH_TIMEOUT_MS;
  if (publishStale) {
    const released = await expireStalePublishing(c.env.DB, "tools").catch(() => 0);
    if (released > 0) console.log(`[staging] ${released} 条发布超时，已退回「发布失败」`);
  }

  const ws = await listWorkspace<Record<string, unknown> & TierInput>(c.env.DB, "tools");
  const { updatedAt } = ws;
  const all = ws.items;
  const rejectedList = ws.rejected;

  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const tierFilter = c.req.query("tier") ?? "all";
  /**
   * 来源隔离：「数据抓取」只看 new，「线上榜单」只看 refresh。
   * 两个 tab 的待审条目绝不混在一个列表里。
   */
  const source = c.req.query("source") ?? "all";
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(Math.max(1, Number(c.req.query("pageSize") ?? 50) || 50), MAX_PAGE_SIZE);

  const rejectedSet = new Set(rejectedList.map((d) => d.toLowerCase()));

  const stageOf = (t: Record<string, unknown>): string => (t.stage as string) ?? "candidate";
  const kindOf = (t: Record<string, unknown>): "new" | "refresh" =>
    t.kind === "refresh" ? "refresh" : "new";

  const mapped = all.map((t) => {
    const verdict = t.verdict as { tier?: string; reason?: string } | undefined;
    return {
      domain: t.domain,
      name: (t.name as string) ?? t.domain,
      url: (t.url as string) ?? null,
      description: (t.description as string) ?? null,
      phUpvotes: (t.phUpvotes as number) ?? 0,
      monthlyVisits: t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits ?? null,
      /*
       * 「更新待审核」要比对「9 月 → 10 月」这种月份变化，没有这个字段前端只能显示
       * 破折号（旧值 2026-09 → — 看起来像新月没数据）。与线上榜单列同源取 snapshotMonth。
       */
      snapshotMonth:
        (t.trafficMetrics as { snapshotMonth?: string } | undefined)?.snapshotMonth ?? null,
      heatScore: (t.heatScore as number) ?? 0,
      categories: ((t.categories as string[]) ?? []).slice(0, 3),
      firstSeenAt: (t.firstSeenAt as string) ?? null,
      // 采集时的判定结果优先，缺失才回退本地兜底判定
      tier: verdict?.tier ?? tierOf(t),
      reason: verdict?.reason ?? null,
      stage: stageOf(t),
      kind: kindOf(t),
      // 一律按当前卡片实时算：存值只反映上次富化那一刻，采集入库的条目根本没有
      fieldGaps: fieldGapsOf(t),
      rejected: rejectedSet.has(String(t.domain).toLowerCase()),
    };
  });
  type StagingCandidate = (typeof mapped)[number];

  /**
   * 每个档位的判定口径：筛选与「下拉里的计数」共用同一份。
   *
   * 分开写迟早会漂 —— 下拉显示 3 条、点进去 0 条，用户只会以为坏了。
   *
   * 档位就是队列的 6 个状态，一个 stage 只落一档：
   * 待确认 / 待富化（含富化中）/ 富化失败 / 待发布（含发布中）/ 发布失败 / 发布完成。
   * 「进行中」（enriching、publishing）不单列 —— 它们和上一档是同一件事的两个时刻，
   * 分开筛只会让人在两处找同一条目。
   */
  const matchTier = (r: StagingCandidate, tier: string): boolean => {
    if (tier === "pending") return r.stage === "candidate";
    if (tier === "approved") return r.stage === "approved" || r.stage === "enriching";
    if (tier === "enrich_failed") return r.stage === "enrich_failed";
    if (tier === "enriched") return r.stage === "enriched" || r.stage === "publishing";
    if (tier === "publish_failed") return r.stage === "publish_failed";
    if (tier === "published") return r.stage === "published";
    return true;
  };

  // 搜索/来源先收窄：下拉计数跟着搜索走，否则会出现「全部 43」但列表 3 条
  const scoped = mapped.filter((r) => {
    if (source !== "all" && r.kind !== source) return false;
    return !(q && !r.domain.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q));
  });

  /**
   * 各档位条数：前端据此只列出「当前真的有条目」的选项 ——
   * 队列里没有富化失败时还挂着「仅富化失败」，点开就是一张空表。
   */
  const tierCounts: Record<string, number> = { all: scoped.length };
  for (const tier of [
    "pending",
    "approved",
    "enrich_failed",
    "enriched",
    "publish_failed",
    "published",
  ]) {
    tierCounts[tier] = scoped.filter((r) => matchTier(r, tier)).length;
  }

  const filtered = scoped.filter((r) => matchTier(r, tierFilter));

  // 已发榜的排在最后：它们等人工点「处理完成」，不该盖住还在等发布的条目
  const rows = [...filtered].sort(
    (a, b) => Number(a.stage === "published") - Number(b.stage === "published"),
  );

  const start = (page - 1) * pageSize;
  return c.json({
    updatedAt,
    // 库里没有「上次采集耗时」这类元信息，updatedAt 就是最近一次落库时间
    lastRun: null,
    lastEnrich: null,
    total: rows.length,
    // 各筛选档的条数（已按搜索/来源收窄）：前端下拉只列有货的档位
    counts: tierCounts,
    // pending = 还没确认收录的（含判定为 reject 的）
    pending: all.filter((t) => stageOf(t) === "candidate").length,
    approved: all.filter((t) => stageOf(t) === "approved").length,
    // 富化中单独计数：这些条目会被占住，不能重复选，也不该算进「待富化」里
    enriching: all.filter((t) => stageOf(t) === "enriching").length,
    enrichFailed: all.filter((t) => stageOf(t) === "enrich_failed").length,
    enriched: all.filter((t) => stageOf(t) === "enriched").length,
    // 发布三态单独计数：发布中占位、发布失败可重发、已发榜等「处理完成」
    publishing: all.filter((t) => stageOf(t) === "publishing").length,
    publishFailed: all.filter((t) => stageOf(t) === "publish_failed").length,
    published: all.filter((t) => stageOf(t) === "published").length,
    rejected: rejectedList.length,
    // 「线上榜单」tab 顶部的「更新待审核」红点：只算 refresh 且已跑完的
    refreshPending: all.filter(
      (t) =>
        kindOf(t) === "refresh" &&
        (stageOf(t) === "enriched" || stageOf(t) === "publish_failed"),
    ).length,
    refreshPublished: all.filter((t) => kindOf(t) === "refresh" && stageOf(t) === "publishing")
      .length,
    newPending: all.filter(
      (t) => kindOf(t) === "new" && (stageOf(t) === "enriched" || stageOf(t) === "publish_failed"),
    ).length,
    page,
    pageSize,
    items: rows.slice(start, start + pageSize),
  });
});

/**
 * 「处理完成」：把发布成功的条目从后台队列移除。
 *
 * 发布成功不会自动消失 —— 条目停在 published 让后台仍能看到「发布成功」。
 * 只有人确认线上没问题、点了这个按钮才真正删掉：自动删的话，万一构建失败
 * 或者上线后发现问题，后台就什么都看不见了。
 */
tools.post("/staging/done", async (c) => {
  let domains: string[] = [];
  /** all=true：批量收尾该榜全部「已发布成功」的条目 */
  let all = false;
  try {
    const body = (await c.req.json()) as { domains?: unknown; all?: unknown };
    all = body?.all === true;
    domains = normalizeDomainInput(body?.domains);
  } catch {
    return c.json({ error: "bad_request", detail: "body 必须是 JSON" }, 400);
  }

  // 批量入口单独走 all 标记：不能靠「domains 为空」推断，
  // 否则前端传了一串非法域名被过滤成空数组时会变成整批删除。
  if (all) {
    const removed = await deleteAllPublished(c.env.DB, "tools");
    return c.json({ removed, skipped: 0 });
  }

  if (!domains.length) return c.json({ error: "bad_request", detail: "缺少 domains" }, 400);

  const removed = await deletePublished(c.env.DB, "tools", domains);
  return c.json({ removed, skipped: domains.length - removed });
});

/** 单条详情：完整 AITool（含流量明细、分类、原始链接等） */
tools.get("/staging/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase();

  const ws = await listWorkspace<Record<string, unknown>>(c.env.DB, "tools");
  const items = ws.items;
  const rejectedList = ws.rejected;

  const tool = items.find((t) => String(t.domain).toLowerCase() === domain);
  if (!tool) return c.json({ error: "not_found" }, 404);

  return c.json({
    tool,
    tier: tierOf(tool as unknown as TierInput),
    rejected: rejectedList.includes(domain),
  });
});

/**
 * 拒绝 / 恢复：只改 board_items.status。
 * 拒绝的域名 status='rejected'，采集脚本读库把它并进拒绝名单，下次抓取跳过。
 */
tools.post("/staging/reject", async (c) => {
  let body: { domains?: unknown; reject?: unknown };
  try {
    body = (await c.req.json()) as { domains?: unknown; reject?: unknown };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const raw = Array.isArray(body.domains) ? body.domains : [body.domains];
  const domains = raw
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => d.toLowerCase())
    .slice(0, 100);
  if (domains.length === 0) return c.json({ error: "empty_domains" }, 400);

  const reject = body.reject !== false;

  const changed = await setItemsStatus(
    c.env.DB,
    "tools",
    domains,
    reject ? "rejected" : "candidate",
  );
  if (changed === 0) return c.json({ error: "not_found" }, 404);

  const ws = await listWorkspace(c.env.DB, "tools");
  return c.json({ ok: true, rejected: ws.rejected.length, pending: ws.items.length });
});

/**
 * 确认收录 / 取消确认：只改 stage，不触发富化。
 * 只有 approved 的条目会被 enrich-staging.ts 选中。
 */
tools.post("/staging/approve", async (c) => {
  let body: { domains?: unknown; approve?: unknown };
  try {
    body = (await c.req.json()) as { domains?: unknown; approve?: unknown };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const raw = Array.isArray(body.domains) ? body.domains : [body.domains];
  const domains = raw
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => d.toLowerCase())
    .slice(0, 200);
  if (domains.length === 0) return c.json({ error: "empty_domains" }, 400);

  const approve = body.approve !== false;

  const changed = await setItemsStatus(
    c.env.DB,
    "tools",
    domains,
    approve ? "approved" : "candidate",
  );
  if (changed === 0) return c.json({ error: "not_found" }, 404);

  const ws = await listWorkspace<Record<string, unknown>>(c.env.DB, "tools");
  return c.json({
    ok: true,
    changed,
    approved: ws.items.filter((t) => t.stage === "approved").length,
    enriched: ws.items.filter((t) => t.stage === "enriched").length,
  });
});

/** 触发富化：对已确认收录的候选补流量/关键词/竞品与 AI 解读，并产出字段完整度报告 */
tools.post("/enrich", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  let body: { domains?: unknown; limit?: unknown; freeOnly?: unknown; note?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    // 允许空 body：富化全部已确认条目
  }

  const raw = Array.isArray(body.domains) ? body.domains : body.domains ? [body.domains] : [];
  const domains = raw
    .filter((d): d is string => typeof d === "string" && d.length > 0)
    .map((d) => d.toLowerCase())
    .slice(0, 50);
  const limit = Math.max(1, Math.min(Number(body.limit ?? 10) || 10, 20));
  const freeOnly = body.freeOnly === true;
  const note = typeof body.note === "string" ? body.note.slice(0, 120) : "";

  // 防重：富化是按次扣钱的，前端按钮锁只是第一道；直接打接口、两个标签页同时点都得挡住。
  // 先回源校准最近几条，避免被「run 早结束但状态没同步」的僵尸任务误封。
  const recent = await c.env.DB.prepare(
    "SELECT * FROM tool_jobs WHERE kind = 'enrich' ORDER BY created_at DESC LIMIT 5",
  ).all<JobRow>();
  let running: JobRow | null = null;
  for (const row of recent.results ?? []) {
    const fresh = await refreshJob(c.env, cfg, row);
    if (fresh.status === "queued" || fresh.status === "running") {
      running = fresh;
      break;
    }
  }

  /*
   * 有一批在跑时，只拦「和它重叠的那部分」，不再一刀切拒绝：
   * 富化中的条目在派发时就已经被标成 enriching，可以逐条比对；
   * 队列里其它待富化的条目没理由跟着停（一个批次要跑十几分钟）。
   *
   * 没指定域名则不放过 —— 那等于「跑全部已确认」，必然和正在跑的批次重叠，
   * 而脚本在 --domains 缺省时会把 enriching 的条目也一起挑走（重复计费）。
   */
  let todo = domains;
  if (running) {
    if (!domains.length) {
      return c.json(
        {
          error: "already_running",
          message: "已有富化任务在跑。要追加富化请先勾选具体条目，跳过正在跑的那批",
          job: running,
        },
        409,
      );
    }
    const busy = await listEnrichingItems(c.env.DB, "tools", domains);
    todo = domains.filter((d) => !busy.has(d));
    if (!todo.length) {
      return c.json(
        {
          error: "all_enriching",
          message: "勾选的条目都在富化中，等这批跑完再提交，或换一批",
          job: running,
        },
        409,
      );
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, ENRICH_WORKFLOW, {
      // 只发真正要跑的（已被别的批次占住的条目不进这批）
      domains: todo.join(","),
      limit: String(limit),
      free_only: String(freeOnly),
      job_id: id,
    });
  } catch (e) {
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO tool_jobs (id, kind, status, params, gh_run_id, run_url, created_at, updated_at)
     VALUES (?, 'enrich', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      run ? mapStatus(run, "queued") : "queued",
      JSON.stringify({ domains: todo, limit, freeOnly, note }),
      run?.id ?? null,
      run?.html_url ?? null,
      now,
      now,
    )
    .run();

  /*
   * 派发成功后再占位：条目状态立刻变成 enriching，后台据此禁掉复选框，
   * 避免「已提交但还显示待富化」时被再选一次，一份钱买两遍。
   * 这也是「任务在跑时仍可提交另一批」的前提 —— 占位越晚，重叠窗口越长。
   *
   * 顺序不能反 —— dispatch 失败要能干净地不改任何状态。
   */
  const marked = await markEnriching(c.env.DB, "tools", todo, limit).catch(() => 0);
  console.log(
    `[enrich] 已标记 ${marked} 条为富化中（domains=${todo.length || "全部"}${todo.length !== domains.length ? `，跳过占住 ${domains.length - todo.length}` : ""}）`,
  );

  const { results } = await c.env.DB.prepare("SELECT * FROM tool_jobs WHERE id = ?")
    .bind(id)
    .all<JobRow>();
  return c.json({ job: results?.[0] ?? null });
});

/* ---------------------------- 线上榜单（D1） ---------------------------- */

/** 数据源月更，最近完整月 = 当前月 - 1 */
function targetSnapshotMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 线上榜单条目的状态。
 *
 * publishing = 正在发布/更新（黄）；failed = 上次发布失败（红）；
 * updated = 版本已是最新（绿）；stale = 数据还是旧的（灰）；
 * nodata = 从没抓到过流量（灰，反复跑只会白花钱）。
 */
type ListedState = "publishing" | "failed" | "updated" | "stale" | "nodata";

interface ListedRow {
  item_key: string;
  rank: number;
  tier: string | null;
  name: string;
  url: string | null;
  visits: number | null;
  /** 月环比增长 %，用来倒推上月访问量 */
  growth: number | null;
  /** 一句话简介，表格里截断显示，完整内容走 title */
  descr: string | null;
  snapshot: string | null;
  analyzed_at: string | null;
  collected_at: string | null;
  cats: string | null;
  heat: number | null;
}

/** 当前版本的已发布工具榜，card 里的字段用 json_extract 只取需要的（不拉 25KB detail） */
async function readListed(db: D1Database): Promise<{ version: string; rows: ListedRow[] }> {
  const ver = await db
    .prepare("SELECT val FROM app_config WHERE key='config.current_version'")
    .first<{ val: string }>();
  if (!ver?.val) return { version: "", rows: [] };

  const { results } = await db
    .prepare(
      `SELECT l.item_key, l.rank, l.tier, l.name, l.url,
              json_extract(l.card, '$.description') AS descr,
              json_extract(l.card, '$.trafficMetrics.monthlyVisits') AS visits,
              json_extract(l.card, '$.trafficMetrics.monthlyVisitsGrowth') AS growth,
              json_extract(l.card, '$.trafficMetrics.snapshotMonth') AS snapshot,
              json_extract(l.card, '$.aiInsight.analyzedAt') AS analyzed_at,
              json_extract(l.card, '$.collectedAt') AS collected_at,
              json_extract(l.card, '$.categories') AS cats,
              json_extract(l.card, '$.heatScore') AS heat
         FROM board_listed l
        WHERE l.version = ? AND l.board = 'tools'
        ORDER BY l.rank ASC`,
    )
    .bind(ver.val)
    .all<ListedRow>();

  return { version: ver.val, rows: results ?? [] };
}

/**
 * 线上榜单列表：210 条已发布条目 + 快照月，用于挑「该更新的那些」。
 *
 * 这条路径只读 D1 —— 不碰 content/aitools.json（7.7MB，Worker 读不了也解析不了）。
 */
tools.get("/listed", async (c) => {
  const { version, rows } = await readListed(c.env.DB);
  if (!version) {
    return c.json({
      version: "",
      target: targetSnapshotMonth(),
      total: 0,
      items: [],
      message: "库里还没有发布过工具榜，先到「数据抓取」发一次",
    });
  }

  const target = targetSnapshotMonth();
  /*
   * 版本号 = 流量月去掉横线（2026-10 → 202610）。
   *
   * 不落库：卡片里本来就有 snapshotMonth，任何需要比较「新旧」的地方现算即可。
   * 用数字是为了让「202609 < 202610」自动成立 —— 跨年也不会错（202612 < 202701），
   * 而 '2026-09' 这种字符串只适合相等判断，算差距得先拆年月。
   */
  const targetVersion = Number(target.replace("-", ""));

  /*
   * 本轮正在跑 / 上一次跑失败的条目。
   *
   * 这些状态只在工作区（board_items）里，榜单快照没有，所以要单独查一次。
   * 跑批中的条目快照还是上个月的，光看版本号会显示成「未更新」，看不出它其实在跑。
   * enriching 是采集/富化，publishing 是发布，对后台来说都是「更新中」。
   */
  const { results: procs } = await c.env.DB.prepare(
    "SELECT item_key, status FROM board_items WHERE board = 'tools' AND status IN ('enriching','publishing','publish_failed')",
  ).all<{ item_key: string; status: string }>();
  const procStatus = new Map<string, string>();
  for (const p of procs ?? []) procStatus.set(p.item_key.toLowerCase(), p.status);

  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const versionFilter = (c.req.query("version") ?? "all").trim();
  const statusFilter = c.req.query("status") ?? "all";
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(Math.max(1, Number(c.req.query("pageSize") ?? 50) || 50), MAX_PAGE_SIZE);

  const decorated = rows.map((r) => {
    const proc = procStatus.get(r.item_key.toLowerCase());
    /*
     * 优先级：更新中 > 失败 > 版本是否最新 > 有没有数据。
     * 「更新中」排在最前：发布还没回写快照，按版本判会显示成「未更新」，看不出它在跑。
     */
    const state: ListedState =
      proc === "publishing" || proc === "enriching"
        ? "publishing"
        : proc === "publish_failed"
          ? "failed"
          : !r.snapshot
            ? "nodata"
            : r.snapshot >= target
              ? "updated"
              : "stale";
    /*
     * 上月访问量：流量源只给「本月值 + 环比 %」，没有历史序列，
     * 所以用 visits / (1 + growth/100) 倒推。环比 ≤ -100% 时公式无意义（分母 ≤ 0），
     * 只给 null 让前端显示破折号。
     */
    const prevVisits =
      r.visits != null && r.growth != null && r.growth > -100
        ? Math.round(r.visits / (1 + r.growth / 100))
        : null;

    return {
      domain: r.item_key,
      name: r.name,
      url: r.url,
      description: r.descr,
      rank: r.rank,
      tier: r.tier,
      monthlyVisits: r.visits,
      prevVisits,
      growth: r.growth,
      snapshotMonth: r.snapshot,
      /** 流量月的版本号，缺数据为 null（前端据此筛选、排序、判断是否落后） */
      snapshotVersion: r.snapshot ? Number(r.snapshot.replace("-", "")) : null,
      analyzedAt: r.analyzed_at,
      collectedAt: r.collected_at,
      categories: r.cats ? (JSON.parse(r.cats) as string[]).slice(0, 3) : [],
      heatScore: r.heat ?? 0,
      state,
    };
  });

  const filtered = decorated.filter((r) => {
    if (q && !r.domain.includes(q) && !r.name.toLowerCase().includes(q)) return false;
    // version 是主筛选（按流量月版本号）；status 保留给旧页面，两者同时出现时以 version 为准
    if (versionFilter !== "all") {
      if (versionFilter === "none") return r.snapshotVersion === null;
      const want = Number(versionFilter);
      return Number.isFinite(want) ? r.snapshotVersion === want : true;
    }
    if (statusFilter === "stale") return r.state === "stale";
    if (statusFilter === "updated") return r.state === "updated";
    if (statusFilter === "nodata") return r.state === "nodata";
    return true;
  });

  /*
   * 出现过的版本号清单（全量统计，不受分页影响），给前端做下拉选项。
   * 每月跑一轮后这里自然多一行，不需要改任何代码。
   */
  const versionCount = new Map<number, number>();
  for (const r of decorated) {
    if (r.snapshotVersion == null) continue;
    versionCount.set(r.snapshotVersion, (versionCount.get(r.snapshotVersion) ?? 0) + 1);
  }
  const versions = [...versionCount.entries()]
    .map(([version, count]) => ({ version, count }))
    .sort((a, b) => b.version - a.version);

  const start = (page - 1) * pageSize;
  return c.json({
    version,
    target,
    /** 当前该抓到的版本号（202610）；快照版本低于它就算落后 */
    targetVersion,
    /** 榜单里出现过的所有版本及条数，按版本倒序 */
    versions,
    total: filtered.length,
    all: decorated.length,
    stale: decorated.filter((r) => r.state === "stale").length,
    updated: decorated.filter((r) => r.state === "updated").length,
    nodata: decorated.filter((r) => r.state === "nodata").length,
    page,
    pageSize,
    items: filtered.slice(start, start + pageSize),
  });
});

/** 单条对比：线上旧值 vs 工作区里的重采结果（待审核时才存在） */
tools.get("/listed/:domain", async (c) => {
  const domain = c.req.param("domain").toLowerCase();
  const { version, rows } = await readListed(c.env.DB);
  const listed = rows.find((r) => r.item_key.toLowerCase() === domain);
  if (!listed) return c.json({ error: "not_listed", message: "该域名不在当前线上榜单" }, 404);

  const ws = await listWorkspace<Record<string, unknown>>(c.env.DB, "tools");
  const fresh = ws.items.find((t) => String(t.domain).toLowerCase() === domain) ?? null;
  const freshKind = fresh && fresh.kind === "refresh" ? "refresh" : fresh ? "new" : null;

  const pick = (t: Record<string, unknown> | null) => {
    if (!t) return null;
    const traffic = t.trafficMetrics as { monthlyVisits?: number; snapshotMonth?: string } | undefined;
    const ai = t.aiInsight as { analyzedAt?: string; summary?: string } | undefined;
    return {
      name: (t.name as string) ?? null,
      monthlyVisits: traffic?.monthlyVisits ?? null,
      snapshotMonth: traffic?.snapshotMonth ?? null,
      analyzedAt: ai?.analyzedAt ?? null,
      summary: ai?.summary ?? null,
      stage: (t.stage as string) ?? null,
      kind: (t.kind as string) ?? null,
    };
  };

  return c.json({
    version,
    domain,
    before: {
      name: listed.name,
      rank: listed.rank,
      monthlyVisits: listed.visits,
      snapshotMonth: listed.snapshot,
      analyzedAt: listed.analyzed_at,
      summary: null,
    },
    after: pick(fresh),
    /** 只有重采结果真的落在工作区里才谈得上发布 */
    reviewable: Boolean(fresh) && freshKind === "refresh",
  });
});

/**
 * 触发「线上更新」：把选中的已发布条目重采一遍。
 *
 * 回填工作区（refresh-prepare）与富化（enrich-staging）都在 Actions 里跑，
 * 走的是和新条目**完全相同**的采集代码 —— 采集口径不能有两套。
 */
tools.post("/refresh", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  let body: { domains?: unknown; collect?: unknown; rewrite?: unknown; note?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const domains = normalizeDomainInput(body.domains);
  if (!domains.length) return c.json({ error: "empty_domains" }, 400);
  /*
   * 超限必须报错，不能 slice 掉尾巴。
   *
   * 以前这里是 `.slice(0, MAX_REFRESH_DOMAINS)`：勾 50 条只有前 30 条真的进了
   * Actions，剩下 20 条静默消失，后台还照样提示「已提交 50 条」，一小时也等不到。
   * 拆批由前端做（每批一次请求，enrich-tools 的 concurrency 会串行排队），
   * 这里只守「单个 Actions job 跑得完」这条硬约束。
   */
  if (domains.length > MAX_REFRESH_DOMAINS) {
    return c.json(
      {
        error: "too_many_domains",
        max: MAX_REFRESH_DOMAINS,
        received: domains.length,
        message: `单批最多 ${MAX_REFRESH_DOMAINS} 条（Actions 单次 60 分钟跑不完更多），请分 ${Math.ceil(
          domains.length / MAX_REFRESH_DOMAINS,
        )} 批提交`,
      },
      400,
    );
  }

  // 两个开关：重新采集（含流量与截图）/ 重跑文案。都关等于什么也不做。
  const collect = body.collect !== false;
  const rewrite = body.rewrite !== false;
  if (!collect && !rewrite) {
    return c.json({ error: "nothing_to_do", message: "「重新采集」和「重跑文案」至少选一个" }, 400);
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, ENRICH_WORKFLOW, {
      domains: domains.join(","),
      limit: String(MAX_REFRESH_DOMAINS),
      kind: "refresh",
      // 数据源月更，命中一个月缓存等于白跑 —— 线上更新一律强刷
      force: String(collect),
      no_llm: String(!rewrite),
      insight_only: String(!collect),
      job_id: id,
    });
  } catch (e) {
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO tool_jobs (id, kind, status, params, gh_run_id, run_url, created_at, updated_at)
     VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      run ? mapStatus(run, "queued") : "queued",
      JSON.stringify({ domains, collect, rewrite, note: typeof body.note === "string" ? body.note : "" }),
      run?.id ?? null,
      run?.html_url ?? null,
      now,
      now,
    )
    .run();

  return c.json({ job: { id, kind: "refresh", status: "queued", count: domains.length } });
});

/** GitHub 把排队/预热中的 run 也报成这些状态，都算「还没跑完」 */
const RUNNING_STATUS = new Set(["queued", "requested", "waiting", "pending", "in_progress"]);

/**
 * 预览页重建（按需）。
 *
 * /preview/{domain} 是 astro build 从 D1 工作区导出的静态 HTML，重采只改库不改
 * 页面。自动重建太贵（整站约 20 分钟，且多数更新没人看预览），改成管理员点一次。
 * GET 拿最近一次构建状态给按钮用，POST 才真的 dispatch。
 */
tools.get("/refresh-preview", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);
  try {
    return c.json({ run: await latestRun(cfg, DEPLOY_WORKFLOW) });
  } catch (e) {
    return c.json(
      { error: "github_unreachable", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }
});

tools.post("/refresh-preview", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  /*
   * 正在构建就别再发一次：deploy-site 是 cancel-in-progress: true，
   * 后触发的会把跑到一半的那次掐掉重来 —— 等于白等一个 20 分钟。
   */
  const current = await latestRun(cfg, DEPLOY_WORKFLOW).catch(() => null);
  if (current && RUNNING_STATUS.has(current.status)) {
    return c.json(
      { error: "already_running", run: current, message: "站点正在构建，等这次跑完再看预览" },
      409,
    );
  }

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, DEPLOY_WORKFLOW, {});
  } catch (e) {
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  return c.json({ run });
});

/**
 * 触发存量重判：重新体检已上榜的条目，找出该下榜的。
 * 默认刷新流量 + 探活；关掉流量刷新可以只用现有数据重算（$0）。
 */
tools.post("/audit", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  let traffic = true;
  let probe = true;
  try {
    const body = (await c.req.json()) as { traffic?: unknown; probe?: unknown };
    if (body?.traffic === false) traffic = false;
    if (body?.probe === false) probe = false;
  } catch {
    // 允许空 body：默认全开
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, AUDIT_WORKFLOW, {
      job_id: id,
      traffic: traffic ? "1" : "0",
      probe: probe ? "1" : "0",
    });
  } catch (e) {
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO tool_jobs (id, kind, status, params, gh_run_id, run_url, created_at, updated_at)
     VALUES (?, 'audit', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      run ? mapStatus(run, "queued") : "queued",
      JSON.stringify({ traffic, probe }),
      run?.id ?? null,
      run?.html_url ?? null,
      now,
      now,
    )
    .run();

  const { results } = await c.env.DB.prepare("SELECT * FROM tool_jobs WHERE id = ?")
    .bind(id)
    .all<JobRow>();
  return c.json({ job: results?.[0] ?? null });
});

/** 富化后的字段完整度报告（enrich-staging.ts 生成并落库，后台只读） */
tools.get("/field-report", async (c) => {
  const report = await loadReport<Record<string, unknown>>(c.env, "tools-field");
  return c.json({ report });
});

/* ------------------------------ 原始接口返回 ------------------------------ */

const RAW_MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** 月份写法 → `YYYY-MM`，与 scripts/field-collect/mapping.ts 的 toMonthKey 同口径 */
function rawMonthKey(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const iso = /^(\d{4})[-/](\d{1,2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}`;
  const en = /^([A-Za-z]+)\s+(\d{4})$/.exec(s);
  if (en) {
    const idx = RAW_MONTH_NAMES.indexOf(en[1].toLowerCase());
    if (idx >= 0) return `${en[2]}-${String(idx + 1).padStart(2, "0")}`;
  }
  return null;
}

/**
 * 采集原文里的月度访问量。
 *
 * 三种形态并存，少认一种就会得出「接口没给这个月」的错误结论 ——
 * vortex 是英文月名 + ISO key 双份（DateFormat 更直接），lergassy 是 ISO 数组。
 */
function rawMonthsOf(payload: unknown): { month: string; visits: number }[] {
  const byMonth = new Map<string, number>();
  const push = (month: unknown, visits: unknown): void => {
    const key = rawMonthKey(month);
    const v = Number(visits);
    if (key && Number.isFinite(v)) byMonth.set(key, v);
  };
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const dateFormat = obj.monthlyVisitsDateFormat;
    if (dateFormat && typeof dateFormat === "object" && !Array.isArray(dateFormat)) {
      for (const [k, v] of Object.entries(dateFormat as Record<string, unknown>)) push(k, v);
    }
    for (const key of ["monthlyVisits", "monthlyVisitsHistory"]) {
      const arr = obj[key];
      if (!Array.isArray(arr)) continue;
      for (const row of arr) {
        const r = row as { month?: unknown; date?: unknown; visits?: unknown };
        push(r.month ?? r.date, r.visits);
      }
    }
  }
  return [...byMonth.entries()]
    .map(([month, visits]) => ({ month, visits }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

/** 原文超过这个体积就不回前端了，免得一个后台接口吐几百 KB */
const RAW_PAYLOAD_LIMIT = 96_000;

interface RawRow {
  source: string;
  period: string;
  ok: number;
  payload: string | null;
  error: string | null;
  cost_usd: number;
  via: string | null;
  fetched_at: number;
}

/**
 * 审核用的「接口到底返回了什么」。
 *
 * 卡片上看到的是解析后的结果，字段缺失时无法区分「接口没给」和「我们没取」——
 * 例如流量月停在 9 月，可能是接口只到 9 月，也可能是英文月名被丢掉了。
 * 这里把 collect_raw 原文摆出来，并把月度序列算好一起给，
 * 顺带带上 traffic_history（库里的累积值），两边一比就知道断在哪一环。
 */
tools.get("/raw", async (c) => {
  const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
  if (!domain) return c.json({ error: "missing_domain" }, 400);

  const { results } = await c.env.DB.prepare(
    "SELECT source, period, ok, payload, error, cost_usd, via, fetched_at " +
      "FROM collect_raw WHERE domain = ? ORDER BY fetched_at DESC LIMIT 24",
  )
    .bind(domain)
    .all<RawRow>();

  // 同一个源只留最新一条：vortex_base 每月一行，历史月份的原文价值不大
  const seen = new Set<string>();
  const records = [];
  for (const row of results ?? []) {
    if (seen.has(row.source)) continue;
    seen.add(row.source);

    const bytes = row.payload?.length ?? 0;
    let parsed: unknown = null;
    let json: unknown = null;
    if (row.payload) {
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        parsed = null;
      }
      // 解析成功且体积可接受才把原文发回去；超大的保留月份摘要就够判断了
      if (parsed !== null && bytes <= RAW_PAYLOAD_LIMIT) json = parsed;
    }

    records.push({
      source: row.source,
      period: row.period || null,
      ok: row.ok === 1,
      via: row.via,
      costUsd: row.cost_usd ?? 0,
      error: row.error,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null,
      bytes,
      /** 原文被体积上限挡掉了（前端据此提示「只给了月份摘要」） */
      payloadOmitted: parsed !== null && json === null,
      months: rawMonthsOf(parsed),
      payload: json,
    });
  }

  const hist = await c.env.DB.prepare(
    "SELECT month, visits, source FROM traffic_history WHERE domain = ? ORDER BY month DESC LIMIT 12",
  )
    .bind(domain)
    .all<{ month: string; visits: number; source: string | null }>();

  return c.json({
    domain,
    records,
    history: (hist.results ?? []).reverse(),
  });
});

/**
 * 发布预览：给「这次发布会发生什么」一个完整交代。
 * 三块内容——新增（enriched 待发）、下榜（存量重判结果）、榜单前后条数。
 */
tools.get("/publish/preview", async (c) => {
  // 候选池与两份报告都读库：不依赖 GitHub 凭据，也不会读到过期的文件
  const ws = await listWorkspace<Record<string, unknown>>(c.env.DB, "tools");
  const [stats, audit] = await Promise.all([
    loadReport<Record<string, unknown>>(c.env, "tools-stats"),
    loadReport<Record<string, unknown>>(c.env, "tools-audit"),
  ]);

  const items = ws.items;
  const stageOf = (t: Record<string, unknown>): string => (t.stage as string) ?? "candidate";
  const enriched = items.filter((t) => stageOf(t) === "enriched").length;
  const approved = items.filter((t) => stageOf(t) === "approved").length;
  const candidates = items.filter((t) => stageOf(t) === "candidate").length;
  // 发布失败的也能再发一次，一起算进「可发榜」
  const publishFailed = items.filter((t) => stageOf(t) === "publish_failed").length;
  // 只有已富化的条目才会被 publish-tools.ts 合并进榜单
  const pending = enriched + publishFailed;
  const s = (stats ?? undefined) as
    | { candidates?: number; listed?: number; qualified?: number; target?: number }
    | undefined;

  const a = (audit ?? undefined) as
    | {
        generatedAt?: string;
        total?: number;
        refreshedTraffic?: boolean;
        probed?: boolean;
        dropped?: Array<{ domain: string; name: string; reason: string; monthlyVisits?: number }>;
        degraded?: Array<{ domain: string; name: string; monthlyVisits?: number }>;
      }
    | undefined;

  const dropCount = a?.dropped?.length ?? 0;
  // 缺省值与 tool-stats.ts 的 TARGET_LISTED、data.ts 的 MAX_LISTED_TOOLS 对齐
  const target = s?.target ?? 3000;
  const listedBefore = s?.listed ?? 0;
  const listedAfter = Math.max(0, Math.min(listedBefore - dropCount + pending, target));

  return c.json({
    pending,
    approved,
    enriched,
    publishFailed,
    candidates,
    rejected: ws.rejected.length,
    stats,
    estimate: s
      ? {
          candidatesAfter: (s.candidates ?? 0) + pending,
          listedBefore,
          listedAfter,
          dropCount,
        }
      : null,
    /** 存量重判结果：null 表示还没跑过审计，下榜清单未知 */
    audit: a
      ? {
          generatedAt: a.generatedAt ?? null,
          total: a.total ?? 0,
          dropCount,
          dropped: (a.dropped ?? []).slice(0, 20),
          degraded: (a.degraded ?? []).slice(0, 20),
          refreshedTraffic: Boolean(a.refreshedTraffic),
          probed: Boolean(a.probed),
        }
      : null,
  });
});

/** 触发发布：合并 staging → aitools.json → 触发站点构建 */
tools.post("/publish", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  let note = "";
  let domains: string[] = [];
  // 默认执行下榜清单（清单由「重判存量」产出，且脚本侧会校验 24 小时保鲜期）
  let drops = true;
  // 发布口按来源分开：新条目走「数据抓取」，更新条目走「线上榜单」
  let kind: "new" | "refresh" | undefined;
  try {
    const body = (await c.req.json()) as {
      note?: unknown;
      domains?: unknown;
      drops?: unknown;
      kind?: unknown;
    };
    if (typeof body?.note === "string") note = body.note.slice(0, 120);
    if (body?.drops === false) drops = false;
    if (body?.kind === "new" || body?.kind === "refresh") kind = body.kind;
    const raw = Array.isArray(body?.domains) ? body.domains : body?.domains ? [body.domains] : [];
    domains = raw
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .map((d) => d.toLowerCase())
      .slice(0, 200);
  } catch {
    // 允许空 body：发布全部已富化条目
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  /*
   * 先占住条目再派发：后台立刻能显示「发布中」，刷新也不会丢。
   * 脚本读队列时认 publishing（与 enriched 同一档），所以这一步不影响实际发出什么。
   * 没有可发的就当场拒绝 —— 否则点了按钮毫无反应，看不出是状态不对还是任务没起来。
   */
  let marked = await markPublishing(c.env.DB, "tools", domains, kind).catch(() => 0);
  if (marked === 0) {
    /*
     * 上一轮发布跑空时（域名其实已在线上、脚本判重复跳过），占位可能没被还回来，
     * 条目就一直显示「发布中」，再点发布又被自己的占位挡住 —— markPublishing 不认
     * publishing。这里先放掉 5 分钟没动静的占位再试一次；正在跑的发布刚标记过，
     * 不会被抢走。
     */
    const released = await releaseStalePublishing(c.env.DB, "tools", domains, kind).catch(() => 0);
    if (released > 0) {
      marked = await markPublishing(c.env.DB, "tools", domains, kind).catch(() => 0);
    }
  }
  if (marked === 0) {
    return c.json(
      {
        error: "nothing_to_publish",
        detail: domains.length
          ? "选中的条目不在可发榜状态（可能正在发布或已发榜）"
          : "队列里没有可发榜的条目",
      },
      409,
    );
  }

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, PUBLISH_WORKFLOW, {
      note,
      job_id: id,
      // 空串 = 发布全部 enriched 条目；否则只发选中域名
      domains: domains.join(","),
      drops: drops ? "1" : "0",
      kind: kind ?? "new",
      /*
       * 一律增量：只写在榜数据里变了的行，新增条目同样只是插入几行。
       * 需要留一个可回滚的版本时，手动在 Actions 里传 patch=0。
       */
      patch: "1",
    });
  } catch (e) {
    // 派发失败要立刻退回占位，否则条目卡在「发布中」得等 60 分钟超时才能重发
    await releasePublishing(c.env.DB, "tools", domains).catch(() => 0);
    return c.json(
      { error: "dispatch_failed", detail: e instanceof Error ? e.message : String(e) },
      502,
    );
  }

  await c.env.DB.prepare(
    `INSERT INTO tool_jobs (id, kind, status, params, gh_run_id, run_url, created_at, updated_at)
     VALUES (?, 'publish', ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      run ? mapStatus(run, "queued") : "queued",
      JSON.stringify({ note, domains }),
      run?.id ?? null,
      run?.html_url ?? null,
      now,
      now,
    )
    .run();

  const { results } = await c.env.DB.prepare("SELECT * FROM tool_jobs WHERE id = ?")
    .bind(id)
    .all<JobRow>();
  return c.json({ job: results?.[0] ?? null });
});

export { tools as adminTools };