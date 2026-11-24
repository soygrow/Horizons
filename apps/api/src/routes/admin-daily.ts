/**
 * 后台「每日情报」。
 *
 * 采集与成稿都不在本地做：本地到 reddit、bbc 等源不通，采集会静默少收
 * 几十条，而且这类缺失不报错，只体现为当天头条质量变差。所以三个环节
 * 全部交给 GitHub Actions，这里只负责触发与核对。
 *
 * 往期列表与全文读 D1 的 digest_issues（发布时整期 JSON 存一份）；
 * 站点构建仍读 content/digest/<date>.json，两边不互相影响。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import {
  dispatchWorkflow,
  failedJob,
  ghConfig,
  latestRun,
  mapStatus,
  missingSecrets,
  readRepoJson,
  writeRepoJson,
} from "../lib/github";

export const adminDaily = new Hono<{ Bindings: Env }>();

const WORKFLOW = "daily.yml";
const MAX_ISSUES = 12;
const MODES = ["fetch", "build", "compose", "publish", "all"];

interface DigestItem {
  id: string;
  title: string;
  summary?: string;
  why?: string;
  score?: number;
  category?: string;
  evidence?: string;
  heat?: number;
  missing?: string;
  [k: string]: unknown;
}

interface DigestModule {
  key: string;
  name?: string;
  items: DigestItem[];
}

interface DigestFile {
  date: string;
  generatedAt?: string;
  modules?: DigestModule[];
  [k: string]: unknown;
}

function notConfigured(env: Env) {
  return { error: "github_not_configured", missing: missingSecrets(env) };
}

/* --------------------------------- 期次 --------------------------------- */

/**
 * 最近若干期的概要。
 *
 * 期次清单来自 D1 的 digest_issues（整期 JSON 原样存一份），
 * 一次查询就能拿到模块构成，不用再逐期打 GitHub Contents API。
 */
adminDaily.get("/issues", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 6) || 6, 1), MAX_ISSUES);

  try {
    const { results } = await c.env.DB.prepare(
      "SELECT date, payload FROM digest_issues ORDER BY date DESC LIMIT ?",
    )
      .bind(limit)
      .all<{ date: string; payload: string }>();

    const issues = (results ?? []).flatMap((row) => {
      try {
        const data = JSON.parse(row.payload) as DigestFile;
        const modules = Array.isArray(data.modules) ? data.modules : [];
        const counts: Record<string, number> = {};
        for (const mod of modules) {
          counts[mod.key] = Array.isArray(mod.items) ? mod.items.length : 0;
        }
        return [
          {
            date: row.date,
            generatedAt: data.generatedAt ?? null,
            total: Object.values(counts).reduce((a, b) => a + b, 0),
            modules: counts,
            /*
             * 第一个模块就是今日头条。后台要判断「这期值不值得发」，
             * 只看标题不够——情报的价值就在那几句话里，所以带上摘要。
             */
            top: (modules[0]?.items ?? []).slice(0, 3).map((i) => ({
              title: i.title,
              summary: i.summary ?? "",
            })),
          },
        ];
      } catch {
        // 单期存坏了不能拖垮整页
        return [
          { date: row.date, error: "read_failed", total: 0, modules: {}, top: [], generatedAt: null },
        ];
      }
    });

    return c.json({ issues });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "read_failed", detail }, 502);
  }
});

/** 单期全文，用于在后台直接看这一期长什么样 */
adminDaily.get("/issues/:date", async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "bad_date", detail: "日期格式应为 YYYY-MM-DD" }, 400);
  }

  try {
    const row = await c.env.DB.prepare("SELECT payload FROM digest_issues WHERE date = ?")
      .bind(date)
      .first<{ payload: string }>();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json(JSON.parse(row.payload) as DigestFile);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "read_failed", detail }, 502);
  }
});

/** 某期当前状态：已发布（published）/ 已成稿未发布（draft）/ 还不存在（missing） */
adminDaily.get("/draft/:date", async (c) => {
  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "bad_date", detail: "日期格式应为 YYYY-MM-DD" }, 400);
  }
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  // 1) 已发布？查 D1 的 digest_issues
  let published: DigestFile | null = null;
  try {
    const row = await c.env.DB.prepare("SELECT payload FROM digest_issues WHERE date = ?")
      .bind(date)
      .first<{ payload: string }>();
    if (row) published = JSON.parse(row.payload) as DigestFile;
  } catch {
    // 单期存坏不拖垮整页
    published = null;
  }

  // 2) 已成稿未发布？读仓库里的成稿文件（build 产物会在 Actions 里提交回 main）
  let draft: DigestFile | null = null;
  try {
    const file = await readRepoJson<DigestFile>(cfg, `content/digest/${date}.json`);
    if (file) draft = file.data;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "draft_read_failed", detail }, 502);
  }

  const status = published ? "published" : draft ? "draft" : "missing";
  return c.json({ date, status, draft, published });
});

/**
 * 手改一条的「几句话」。
 *
 * 模板拼出来的事实句是准的，但「所以呢」经常差半句人话 —— 每天都有那么两三条
 * 需要人来补一刀。以前只能改脚本重跑，等于整期重来；这里直接改仓库里的成稿
 * 文件：提交后前台随部署更新，D1 里的那一期要再点一次「发布本期」才同步。
 *
 * 只允许改 summary / why / missing 三个纯文本字段。标题是原文标题，改了就没法
 * 核对出处；分数、证据等级是算法结论，手改会让人分不清哪句是机器判断。
 */
adminDaily.post("/items", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  type EditBody = {
    date?: string;
    id?: string;
    summary?: string;
    why?: string;
    missing?: string;
  };
  const body = await c.req.json<EditBody>().catch(() => ({} as EditBody));

  const date = String(body.date ?? "").trim();
  const id = String(body.id ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "bad_date", detail: "日期格式应为 YYYY-MM-DD" }, 400);
  }
  if (!id) return c.json({ error: "bad_id", detail: "缺少条目 id" }, 400);

  const summary = body.summary === undefined ? undefined : String(body.summary).trim();
  const why = body.why === undefined ? undefined : String(body.why).trim();
  const missing = body.missing === undefined ? undefined : String(body.missing).trim();
  if (summary === "" || why === "") {
    return c.json(
      { error: "empty_text", detail: "「发生了什么」和「所以呢」都不能空——这两句就是这条情报本身" },
      400,
    );
  }

  const path = `content/digest/${date}.json`;
  const file = await readRepoJson<DigestFile>(cfg, path).catch(() => null);
  if (!file) {
    return c.json({ error: "not_found", detail: `仓库里没有 ${date} 的成稿文件` }, 404);
  }

  let hit = false;
  for (const mod of file.data.modules ?? []) {
    for (const item of mod.items) {
      if (item.id !== id) continue;
      if (summary !== undefined) item.summary = summary;
      if (why !== undefined) item.why = why;
      if (missing !== undefined) {
        if (missing) item.missing = missing;
        else delete item.missing;
      }
      hit = true;
    }
  }
  if (!hit) {
    return c.json({ error: "item_not_found", detail: `${date} 这一期里没有这条` }, 404);
  }

  const ok = await writeRepoJson(
    cfg,
    path,
    file.data,
    file.sha,
    `chore(digest): 手改 ${date} 第 ${id} 条的几句话`,
  );
  if (!ok) return c.json({ error: "write_failed", detail: "写回仓库失败" }, 502);

  return c.json({
    ok: true,
    syncedToD1: false,
    detail: "已写回仓库，前台会在部署后更新；要让后台列表也同步，再点一次「发布本期」。",
  });
});

/* --------------------------------- 触发 --------------------------------- */

adminDaily.get("/run-status", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  const run = await latestRun(cfg, WORKFLOW);
  const status = mapStatus(run, "idle");
  // 失败时多查一次 jobs：给出失败 job / 失败步骤，省得再去十几个步骤里翻
  const failure = run && status === "failure" ? await failedJob(cfg, run.id) : null;

  return c.json({
    status,
    run: run
      ? { id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion }
      : null,
    failure,
  });
});

adminDaily.post("/run", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  const body = await c.req
    .json<{ mode?: string; date?: string }>()
    .catch(() => ({}) as { mode?: string; date?: string });

  const mode = String(body.mode ?? "all");
  if (!MODES.includes(mode)) {
    return c.json({ error: "bad_mode", detail: "mode 只接受 fetch / build / compose / publish / all" }, 400);
  }

  // 日期为空表示「今天」，由 workflow 按 UTC+8 计算；给了就必须是完整日期
  const date = String(body.date ?? "").trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "bad_date", detail: "日期格式应为 YYYY-MM-DD" }, 400);
  }

  try {
    const run = await dispatchWorkflow(cfg, WORKFLOW, { mode, date });
    return c.json({ ok: true, mode, date: date || null, run });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "dispatch_failed", detail }, 502);
  }
});