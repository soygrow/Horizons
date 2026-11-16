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
  setItemsStatus,
} from "../lib/board-items";
import { readReport } from "../lib/reports";

const tools = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const GH_API = "https://api.github.com";
const FETCH_WORKFLOW = "fetch-tools.yml";
const ENRICH_WORKFLOW = "enrich-tools.yml";
const PUBLISH_WORKFLOW = "publish-tools.yml";
const AUDIT_WORKFLOW = "audit-tools.yml";

const MAX_COUNT = 200;
const MAX_PAGE_SIZE = 100;
/** 指定网站单次上限，与 scripts/admin/fetch-staging.ts 的 MAX_MANUAL 保持一致 */
const MAX_MANUAL_DOMAINS = 50;

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


async function refreshJob(env: Env, cfg: GhConfig | null, row: JobRow): Promise<JobRow> {
  if (!cfg || !row.gh_run_id) return row;
  if (["success", "failure", "cancelled"].includes(row.status)) return row;

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
  const live = rows
    .filter((r) => r.status === "queued" || r.status === "running")
    .slice(0, 10);
  const refreshed = new Map<string, JobRow>();
  const settled: Promise<void>[] = [];
  await Promise.all(
    live.map(async (r) => {
      const next = await refreshJob(c.env, cfg, r);
      refreshed.set(r.id, next);
      // 发布任务刚判死：顺手把条目从「发布中」退回，前端下一次刷新就能重发
      settled.push(settlePublishJob(c.env, next, r.status));
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
  await settlePublishJob(c.env, job, row.status);
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
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(Math.max(1, Number(c.req.query("pageSize") ?? 50) || 50), MAX_PAGE_SIZE);

  const rejectedSet = new Set(rejectedList.map((d) => d.toLowerCase()));

  const stageOf = (t: Record<string, unknown>): string => (t.stage as string) ?? "candidate";

  const filtered = all
    .map((t) => {
      const verdict = t.verdict as { tier?: string; reason?: string } | undefined;
      return {
        domain: t.domain,
        name: (t.name as string) ?? t.domain,
        url: (t.url as string) ?? null,
        description: (t.description as string) ?? null,
        phUpvotes: (t.phUpvotes as number) ?? 0,
        monthlyVisits: t.trafficMetrics?.monthlyVisits ?? t.metrics?.monthlyVisits ?? null,
        heatScore: (t.heatScore as number) ?? 0,
        categories: ((t.categories as string[]) ?? []).slice(0, 3),
        firstSeenAt: (t.firstSeenAt as string) ?? null,
        // 采集时的判定结果优先，缺失才回退本地兜底判定
        tier: verdict?.tier ?? tierOf(t),
        reason: verdict?.reason ?? null,
        stage: stageOf(t),
        // 一律按当前卡片实时算：存值只反映上次富化那一刻，采集入库的条目根本没有
        fieldGaps: fieldGapsOf(t),
        rejected: rejectedSet.has(String(t.domain).toLowerCase()),
      };
    })
    .filter((r) => {
      if (q && !r.domain.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      if (tierFilter === "qualified") return r.tier === "core" || r.tier === "watch";
      if (tierFilter === "unqualified") return r.tier === "reject";
      if (tierFilter === "rejected") return r.rejected;
      // 「待发布」= 还没进发布队列的：待富化 / 富化中 / 富化失败，都能在这里找回
      if (tierFilter === "approved") {
        return r.stage === "approved" || r.stage === "enriching" || r.stage === "enrich_failed";
      }
      // 「可发榜」含发布失败的（点一下就能重发），发布中/已发榜单独筛
      if (tierFilter === "enriched") return r.stage === "enriched" || r.stage === "publish_failed";
      if (tierFilter === "enrich_failed") return r.stage === "enrich_failed";
      if (tierFilter === "published") return r.stage === "published";
      return true;
    });

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
  try {
    const body = (await c.req.json()) as { domains?: unknown };
    domains = normalizeDomainInput(body?.domains);
  } catch {
    return c.json({ error: "bad_request", detail: "body 必须是 JSON" }, 400);
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
  const target = s?.target ?? 1000;
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
  try {
    const body = (await c.req.json()) as { note?: unknown; domains?: unknown; drops?: unknown };
    if (typeof body?.note === "string") note = body.note.slice(0, 120);
    if (body?.drops === false) drops = false;
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
  const marked = await markPublishing(c.env.DB, "tools", domains).catch(() => 0);
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