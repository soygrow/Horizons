/**
 * 后台「每日情报」。
 *
 * 采集与成稿都不在本地做：本地到 reddit、bbc 等源不通，采集会静默少收
 * 几十条，而且这类缺失不报错，只体现为当天头条质量变差。所以三个环节
 * 全部交给 GitHub Actions，这里只负责触发与核对。
 *
 * 读的是仓库里的 content/digest，不读 D1 —— 历史期本来就只以文件形式
 * 存在（/daily/[date] 直接读文件），D1 只有最新一期的名次表。
 */
import { Hono } from "hono";
import type { Env } from "../env";
import {
  dispatchWorkflow,
  ghConfig,
  latestRun,
  listRepoDir,
  mapStatus,
  missingSecrets,
  readRepoJson,
} from "../lib/github";

export const adminDaily = new Hono<{ Bindings: Env }>();

const WORKFLOW = "daily.yml";
const DIGEST_DIR = "content/digest";
const MAX_ISSUES = 12;
const MODES = ["fetch", "build", "publish", "all"];

interface DigestItem {
  id: string;
  title: string;
  score?: number;
  category?: string;
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
 * 目录一次请求，每期各读一次文件 —— GitHub 单次返回的是元信息，不含
 * 模块构成，所以想看「这期收录了多少条」只能把文件读回来。默认只取 6 期，
 * 打开页签时 7 个请求，远低于 5000/h 的限额。
 */
adminDaily.get("/issues", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 6) || 6, 1), MAX_ISSUES);

  let entries;
  try {
    entries = await listRepoDir(cfg, DIGEST_DIR);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "list_failed", detail }, 502);
  }

  const dates = entries
    .filter((e) => e.type === "file" && /^\d{4}-\d{2}-\d{2}\.json$/.test(e.name))
    .map((e) => e.name.slice(0, -".json".length))
    .sort()
    .reverse()
    .slice(0, limit);

  const issues = await Promise.all(
    dates.map(async (date) => {
      try {
        const file = await readRepoJson<DigestFile>(cfg, `${DIGEST_DIR}/${date}.json`);
        if (!file) return { date, total: 0, modules: {}, top: [] as string[], generatedAt: null };

        const modules = Array.isArray(file.data.modules) ? file.data.modules : [];
        const counts: Record<string, number> = {};
        for (const mod of modules) {
          counts[mod.key] = Array.isArray(mod.items) ? mod.items.length : 0;
        }

        return {
          date,
          generatedAt: file.data.generatedAt ?? null,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          modules: counts,
          // 第一个模块就是今日头条，列两条足够判断这期值不值得看
          top: (modules[0]?.items ?? []).slice(0, 2).map((i) => i.title),
        };
      } catch {
        // 单期读坏不能拖垮整页
        return { date, error: "read_failed", total: 0, modules: {}, top: [] as string[], generatedAt: null };
      }
    }),
  );

  return c.json({ issues });
});

/** 单期全文，用于在后台直接看这一期长什么样 */
adminDaily.get("/issues/:date", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  const date = c.req.param("date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "bad_date", detail: "日期格式应为 YYYY-MM-DD" }, 400);
  }

  try {
    const file = await readRepoJson<DigestFile>(cfg, `${DIGEST_DIR}/${date}.json`);
    if (!file) return c.json({ error: "not_found" }, 404);
    return c.json(file.data);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ error: "read_failed", detail }, 502);
  }
});

/* --------------------------------- 触发 --------------------------------- */

adminDaily.get("/run-status", async (c) => {
  const cfg = ghConfig(c.env);
  if (!cfg) return c.json(notConfigured(c.env), 400);

  const run = await latestRun(cfg, WORKFLOW);
  return c.json({
    status: mapStatus(run, "idle"),
    run: run
      ? { id: run.id, url: run.html_url, status: run.status, conclusion: run.conclusion }
      : null,
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
    return c.json({ error: "bad_mode", detail: "mode 只接受 fetch / build / publish / all" }, 400);
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