/**
 * 后台「工具榜」API：抓取任务、待发布审核、发布上线。
 *
 * Worker 跑不了 Playwright，也写不了仓库文件，所以这里只做三件事：
 *   1. 通过 GitHub API 触发 fetch-tools.yml / publish-tools.yml；
 *   2. 读仓库里的 content/tools-staging.json 做审核界面；
 *   3. 把每次点击记到 D1 的 tool_jobs，便于回看结果。
 *
 * 候选数据不进 D1：仓库 JSON 是唯一事实来源，避免双写不一致。
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
  readRepoJson,
  type WorkflowRun,
  writeRepoJson,
} from "../lib/github";

const tools = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const GH_API = "https://api.github.com";
const STAGING_PATH = "content/tools-staging.json";
const STATS_PATH = "content/tools-stats.json";
const FIELD_REPORT_PATH = "content/tools-field-report.json";
const AUDIT_PATH = "content/tools-audit.json";
const FETCH_WORKFLOW = "fetch-tools.yml";
const ENRICH_WORKFLOW = "enrich-tools.yml";
const PUBLISH_WORKFLOW = "publish-tools.yml";
const AUDIT_WORKFLOW = "audit-tools.yml";

const MAX_COUNT = 200;
const MAX_PAGE_SIZE = 100;

/* ------------------------------- 收录口径 ------------------------------- */
/**
 * 收录判定统一由 `@horizons/shared` 的 tool-tier 提供（见文件顶部 import）。
 *
 * 此前这里有一份漏掉 isBlockedDomain 的副本，导致被黑名单屏蔽的域名
 * 在后台显示为「已收录」，站点却不上榜。不要再在本地复制这段逻辑。
 */

/* GitHub 封装见 ../lib/github：与趋势榜后台共用一份 */

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
  if (!cfg) return c.json({ configured: false, missing, stats: null, jobs });

  try {
    const stats = await readRepoJson<Record<string, unknown>>(cfg, STATS_PATH);
    return c.json({ configured: true, missing, stats: stats?.data ?? null, jobs });
  } catch (e) {
    return c.json({
      configured: true,
      missing,
      stats: null,
      jobs,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

tools.get("/jobs", async (c) => {
  const cfg = ghConfig(c.env);
  const limit = Math.min(Number(c.req.query("limit") ?? 20) || 20, MAX_PAGE_SIZE);
  const rows = await listJobs(c.env, limit);
  const refreshed = await Promise.all(rows.slice(0, 5).map((r) => refreshJob(c.env, cfg, r)));
  return c.json({ jobs: [...refreshed, ...rows.slice(5)] });
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

  const count = Math.max(1, Math.min(Number(body.count ?? 60) || 60, MAX_COUNT));
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
      JSON.stringify({ count, order, topic, enrich, note }),
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
  return c.json({ job: await refreshJob(c.env, ghConfig(c.env), row) });
});

/** 待发布队列：读 staging 文件，返回列表页需要的精简字段 */
tools.get("/staging", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  const file = await readRepoJson<{
    updatedAt: string;
    items: Array<Record<string, unknown> & TierInput>;
    rejected: string[];
    lastRun?: unknown;
  }>(cfg, STAGING_PATH);

  if (!file) {
    return c.json({ updatedAt: null, total: 0, pending: 0, rejected: 0, items: [], lastRun: null });
  }

  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const tierFilter = c.req.query("tier") ?? "all";
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(Math.max(1, Number(c.req.query("pageSize") ?? 50) || 50), MAX_PAGE_SIZE);

  const rejectedSet = new Set((file.data.rejected ?? []).map((d) => d.toLowerCase()));
  const all = file.data.items ?? [];

  const stageOf = (t: Record<string, unknown>): string => (t.stage as string) ?? "candidate";

  const rows = all
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
        fieldGaps: (t.fieldGaps as string[]) ?? [],
        rejected: rejectedSet.has(String(t.domain).toLowerCase()),
      };
    })
    .filter((r) => {
      if (q && !r.domain.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false;
      if (tierFilter === "qualified") return r.tier === "core" || r.tier === "watch";
      if (tierFilter === "unqualified") return r.tier === "reject";
      if (tierFilter === "rejected") return r.rejected;
      if (tierFilter === "approved") return r.stage === "approved";
      if (tierFilter === "enriched") return r.stage === "enriched";
      return true;
    });

  const start = (page - 1) * pageSize;
  return c.json({
    updatedAt: file.data.updatedAt ?? null,
    lastRun: file.data.lastRun ?? null,
    lastEnrich: (file.data as { lastEnrich?: unknown }).lastEnrich ?? null,
    total: rows.length,
    // pending = 还没确认收录的（含判定为 reject 的）
    pending: all.filter((t) => stageOf(t) === "candidate").length,
    approved: all.filter((t) => stageOf(t) === "approved").length,
    enriched: all.filter((t) => stageOf(t) === "enriched").length,
    rejected: (file.data.rejected ?? []).length,
    page,
    pageSize,
    items: rows.slice(start, start + pageSize),
  });
});

/** 单条详情：完整 AITool（含流量明细、分类、原始链接等） */
tools.get("/staging/:domain", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  const domain = c.req.param("domain").toLowerCase();
  const file = await readRepoJson<{ items: Array<Record<string, unknown>>; rejected: string[] }>(
    cfg,
    STAGING_PATH,
  );
  if (!file) return c.json({ error: "not_found" }, 404);

  const tool = (file.data.items ?? []).find((t) => String(t.domain).toLowerCase() === domain);
  if (!tool) return c.json({ error: "not_found" }, 404);

  return c.json({
    tool,
    tier: tierOf(tool as unknown as TierInput),
    rejected: (file.data.rejected ?? []).includes(domain),
  });
});

/**
 * 拒绝 / 恢复：直接改 staging 文件。
 * 拒绝的域名进入 rejected 名单，下次抓取跳过、发布时过滤。
 */
tools.post("/staging/reject", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

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
  const file = await readRepoJson<{
    updatedAt: string;
    items: Array<Record<string, unknown>>;
    rejected: string[];
    lastRun?: unknown;
  }>(cfg, STAGING_PATH);
  if (!file) return c.json({ error: "not_found" }, 404);

  const rejectedSet = new Set((file.data.rejected ?? []).map((d) => d.toLowerCase()));
  for (const d of domains) {
    if (reject) rejectedSet.add(d);
    else rejectedSet.delete(d);
  }

  const next = {
    ...file.data,
    updatedAt: new Date().toISOString(),
    items: reject
      ? (file.data.items ?? []).filter((t) => !rejectedSet.has(String(t.domain).toLowerCase()))
      : file.data.items,
    rejected: [...rejectedSet].sort(),
  };

  const ok = await writeRepoJson(
    cfg,
    STAGING_PATH,
    next,
    file.sha,
    `chore(tools): ${reject ? "拒绝" : "恢复"} ${domains.length} 个候选（后台）`,
  );
  if (!ok) return c.json({ error: "write_conflict" }, 409);

  return c.json({ ok: true, rejected: next.rejected.length, pending: next.items.length });
});

/**
 * 确认收录 / 取消确认：只改 stage，不触发富化。
 * 只有 approved 的条目会被 enrich-staging.ts 选中。
 */
tools.post("/staging/approve", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

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
  const wanted = new Set(domains);
  const file = await readRepoJson<{
    updatedAt: string;
    items: Array<Record<string, unknown>>;
    rejected: string[];
    lastRun?: unknown;
  }>(cfg, STAGING_PATH);
  if (!file) return c.json({ error: "not_found" }, 404);

  const rejectedSet = new Set((file.data.rejected ?? []).map((d) => d.toLowerCase()));
  let changed = 0;
  const items = (file.data.items ?? []).map((t) => {
    const d = String(t.domain).toLowerCase();
    if (!wanted.has(d) || rejectedSet.has(d)) return t;
    changed++;
    return { ...t, stage: approve ? "approved" : "candidate" };
  });

  const next = { ...file.data, updatedAt: new Date().toISOString(), items };
  const ok = await writeRepoJson(
    cfg,
    STAGING_PATH,
    next,
    file.sha,
    `chore(tools): ${approve ? "确认收录" : "取消确认"} ${changed} 个候选（后台）`,
  );
  if (!ok) return c.json({ error: "write_conflict" }, 409);

  return c.json({
    ok: true,
    changed,
    approved: items.filter((t) => t.stage === "approved").length,
    enriched: items.filter((t) => t.stage === "enriched").length,
  });
});

/** 触发富化：对已确认收录的候选补 DFS/AI 数据，并产出字段完整度报告 */
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

  const id = crypto.randomUUID();
  const now = Date.now();

  let run: WorkflowRun | null;
  try {
    run = await dispatchWorkflow(cfg, ENRICH_WORKFLOW, {
      domains: domains.join(","),
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
      JSON.stringify({ domains, limit, freeOnly, note }),
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

/** 富化后的字段完整度报告（enrich-staging.ts 生成，后台只读） */
tools.get("/field-report", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);
  const file = await readRepoJson<Record<string, unknown>>(cfg, FIELD_REPORT_PATH);
  return c.json({ report: file?.data ?? null });
});

/**
 * 发布预览：给「这次发布会发生什么」一个完整交代。
 * 三块内容——新增（enriched 待发）、下榜（存量重判结果）、榜单前后条数。
 */
tools.get("/publish/preview", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json({ error: "github_not_configured", missing: missingSecrets(c.env) }, 503);

  const [staging, stats, audit] = await Promise.all([
    readRepoJson<{ items: Array<Record<string, unknown>>; rejected: string[] }>(cfg, STAGING_PATH),
    readRepoJson<Record<string, unknown>>(cfg, STATS_PATH),
    readRepoJson<Record<string, unknown>>(cfg, AUDIT_PATH),
  ]);

  const items = staging?.data.items ?? [];
  const stageOf = (t: Record<string, unknown>): string => (t.stage as string) ?? "candidate";
  const enriched = items.filter((t) => stageOf(t) === "enriched").length;
  const approved = items.filter((t) => stageOf(t) === "approved").length;
  const candidates = items.filter((t) => stageOf(t) === "candidate").length;
  // 只有已富化的条目才会被 publish-tools.ts 合并进榜单
  const pending = enriched;
  const s = stats?.data as { candidates?: number; listed?: number; qualified?: number; target?: number } | undefined;

  const a = audit?.data as
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
    candidates,
    rejected: (staging?.data.rejected ?? []).length,
    stats: stats?.data ?? null,
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