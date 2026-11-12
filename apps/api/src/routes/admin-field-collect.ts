/**
 * 后台「新采集」：触发一次按 docs/18-AI工具字段采集方案.md 的字段采集。
 *
 * 这一套是刻意独立的一条线，和工具榜/候选池/每日情报都不共享代码与数据：
 *   - 唯一的表是 field_collect_runs（一行 = 一次采集，result 存整份字段 JSON）；
 *   - 唯一的执行体是 GitHub Actions 上的 scripts/field-collect/index.ts；
 *   - 这里只做三件事：插一条待办、dispatch workflow、把结果读出来给页面。
 *
 * 之所以不在 Worker 里直接采：Wayback / crt.sh / Common Crawl / Apify 这几家在
 * Worker 的 CPU 与子请求预算内根本跑不完（单个 Similarweb Actor 就要 40~90 秒），
 * 而且抓 HTML 和截图必须用 Playwright 有头/无头浏览器。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import { dispatchWorkflow, fetchRun, ghConfig, mapStatus, missingSecrets } from "../lib/github";

export const adminFieldCollect = new Hono<{ Bindings: Env }>();

const WORKFLOW = "collect-fields.yml";
/** 与 scripts/field-collect/fields.ts 的 FIELDS 长度一致；仅用于「排队中」时的分母 */
const TOTAL_FIELDS = 72;
const MAX_ROWS = 30;

interface RunRow {
  id: string;
  url: string;
  domain: string;
  status: string;
  step: string | null;
  filled: number;
  total: number;
  desktop_url: string | null;
  mobile_url: string | null;
  gh_run_id: number | null;
  run_url: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

const notConfigured = (env: Env) => ({
  error: "github_not_configured",
  missing: missingSecrets(env),
});

function isTerminal(status: string): boolean {
  return status === "success" || status === "failure" || status === "cancelled";
}

/**
 * 把地址规范化成「https://host/path」并取出主域名。
 *
 * 这里不做 tldts 那种精确的 eTLD+1（Worker 里没有依赖），只去掉 www 和端口：
 * 真正给第三方接口用的 domain 由采集脚本用 tldts 重新算，这边只用于展示和去重。
 */
function normalize(input: string): { url: string; domain: string } | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /\s/.test(host)) return null;
  return { url: u.toString(), domain: host.replace(/^www\./, "") };
}

function serialize(row: RunRow) {
  return {
    id: row.id,
    url: row.url,
    domain: row.domain,
    status: row.status,
    step: row.step,
    filled: row.filled,
    total: row.total,
    desktopUrl: row.desktop_url,
    mobileUrl: row.mobile_url,
    ghRunId: row.gh_run_id,
    runUrl: row.run_url,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 状态对账。
 *
 * 正常情况下脚本自己把 status 写成 success/failure，这里什么都不用做。
 * 只有一种情况必须兜：脚本在写库之前就挂了（依赖装不上、OOM、workflow 被取消），
 * 行会永远停在 running。所以并行去看一次 GitHub run 的结论，能收尾就收尾 ——
 * 否则页面上会一直转圈，看不出「其实已经失败了」。
 */
async function reconcile(c: { env: Env }, row: RunRow): Promise<RunRow> {
  if (isTerminal(row.status) || !row.gh_run_id) return row;
  const cfg = ghConfig(c.env);
  if (!cfg) return row;

  const run = await fetchRun(cfg, row.gh_run_id);
  if (!run) return row;
  const mapped = mapStatus(run, row.status);
  if (mapped === row.status) return row;
  // workflow 成功 ≠ 采集成功：脚本会在结束前自己写 success，这期间保持原状态等它
  if (mapped === "success") return row;

  const status = mapped === "cancelled" ? "cancelled" : "failure";
  const error =
    status === "cancelled"
      ? "workflow 已取消（可在 run 日志查看中断位置）"
      : "workflow 失败（脚本未能写回结果，请查看 run 日志）";
  const now = Date.now();
  await c.env.DB.prepare("UPDATE field_collect_runs SET status = ?, step = ?, error = ?, updated_at = ? WHERE id = ?")
    .bind(status, "已中断", error, now, row.id)
    .run();
  return { ...row, status, step: "已中断", error, updated_at: now };
}

/* --------------------------------- 列表 --------------------------------- */

adminFieldCollect.get("/", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, url, domain, status, step, filled, total, desktop_url, mobile_url,
              gh_run_id, run_url, result, error, created_at, updated_at
         FROM field_collect_runs
        ORDER BY created_at DESC
        LIMIT ?`,
    )
      .bind(MAX_ROWS)
      .all<RunRow>();

    // 列表不返回整份 result（几十 KB），只给覆盖率摘要
    const runs = (results ?? []).map((row) => ({ ...serialize(row), result: undefined }));
    return c.json({ runs, totalFields: TOTAL_FIELDS });
  } catch (e) {
    return c.json({ error: "db_error", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/* --------------------------------- 触发 --------------------------------- */

adminFieldCollect.post("/", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 503);

  let body: { url?: unknown };
  try {
    body = (await c.req.json()) as { url?: unknown };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const target = normalize(typeof body.url === "string" ? body.url : "");
  if (!target) return c.json({ error: "invalid_url", message: "请输入有效的网站地址，例如 example.com" }, 400);

  const id = crypto.randomUUID();
  const now = Date.now();

  // 先插行再 dispatch：dispatch 之后前端会立刻轮询，库里必须先有一条可查的记录
  await c.env.DB.prepare(
    `INSERT INTO field_collect_runs
       (id, url, domain, status, step, filled, total, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', '已提交，等待 GitHub Actions 排期', 0, ?, ?, ?)`,
  )
    .bind(id, target.url, target.domain, TOTAL_FIELDS, now, now)
    .run();

  try {
    const run = await dispatchWorkflow(cfg, WORKFLOW, { url: target.url, job_id: id });
    if (run) {
      await c.env.DB.prepare("UPDATE field_collect_runs SET gh_run_id = ?, run_url = ?, updated_at = ? WHERE id = ?")
        .bind(run.id, run.html_url, Date.now(), id)
        .run();
    }
    const row = await c.env.DB.prepare("SELECT * FROM field_collect_runs WHERE id = ?").bind(id).first<RunRow>();
    return c.json({ run: row ? serialize(row) : null });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await c.env.DB.prepare(
      "UPDATE field_collect_runs SET status = 'failure', step = '触发失败', error = ?, updated_at = ? WHERE id = ?",
    )
      .bind(`workflow 触发失败：${detail}`.slice(0, 500), Date.now(), id)
      .run();
    return c.json({ error: "dispatch_failed", detail }, 502);
  }
});

/* --------------------------------- 详情 --------------------------------- */

/**
 * 读一条采集详情（含整份 result）。
 *
 * 抽成独立函数是因为结果页现在走公开只读路由 /api/fc/:id —— 那个链接不该依赖
 * 后台登录态（Cookie 一过期、换个浏览器、发给别人看就全打不开了），
 * 两条路由共用这里的查询与状态对账，避免各写一遍。
 */
export async function loadRunDetail(env: Env, id: string): Promise<(ReturnType<typeof serialize> & { result: unknown }) | null> {
  const found = await env.DB.prepare("SELECT * FROM field_collect_runs WHERE id = ?").bind(id).first<RunRow>();
  if (!found) return null;

  const row = await reconcile({ env }, found);
  let result: unknown = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = null;
    }
  }
  return { ...serialize(row), result };
}

adminFieldCollect.get("/:id", async (c) => {
  const run = await loadRunDetail(c.env, c.req.param("id"));
  if (!run) return c.json({ error: "not_found" }, 404);
  return c.json({ run });
});

/** 手动对账入口（页面上的「刷新状态」用，避免有些情况下没轮询到） */
adminFieldCollect.post("/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const found = await c.env.DB.prepare("SELECT * FROM field_collect_runs WHERE id = ?").bind(id).first<RunRow>();
  if (!found) return c.json({ error: "not_found" }, 404);
  const row = await reconcile(c, found);
  return c.json({ run: serialize(row) });
});