/**
 * 后台任务记录（github_jobs 表）。
 *
 * 趋势、工具、GitHub、模型这几条流水线都是「Worker 派发 GitHub Actions、表里记一行」，
 * 表结构和状态机完全一样，所以放在这里共享 —— 之前只有 GitHub 榜路由里有一份，
 * 别的榜想显示「上一次跑了什么」就得复制粘贴。
 *
 * 状态只有四种：queued / running / success / failure（外加 cancelled）。
 * 前端轮询的活跃判断只认 queued 和 running，所以中间态一律归到 queued。
 */
import type { Env } from "../env";
import { fetchRun, ghConfig, mapStatus, type WorkflowRun } from "./github";

export interface JobRow {
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

export async function refreshJob(
  env: Env,
  cfg: ReturnType<typeof ghConfig>,
  row: JobRow,
): Promise<JobRow> {
  if (!cfg || !row.gh_run_id) return row;
  if (["success", "failure", "cancelled"].includes(row.status)) return row;

  const run = await fetchRun(cfg, row.gh_run_id);
  if (!run) return row;
  const status = mapStatus(run, row.status);
  if (status === row.status) return row;

  const now = Date.now();
  await env.DB.prepare("UPDATE github_jobs SET status = ?, run_url = ?, updated_at = ? WHERE id = ?")
    .bind(status, run.html_url ?? row.run_url, now, row.id)
    .run();
  return { ...row, status, run_url: run.html_url ?? row.run_url, updated_at: now };
}

/**
 * 最近的任务，按创建时间倒序。
 *
 * `kindPrefix` 用来只看某条流水线（比如模型榜只关心 models-*）。
 * `excludePrefixes` 是它的反面：GitHub 榜的 job kind 没有前缀（fetch / refresh / publish），
 * 没法用正向前缀挑出来，只能把别的流水线（models-* / opps-*）挡掉 ——
 * 否则 GitHub 榜的运行记录里会冒出 opps-generate，看着像自己跑了个同名任务。
 */
export async function listJobs(
  env: Env,
  limit: number,
  kindPrefix?: string,
  excludePrefixes: string[] = [],
): Promise<JobRow[]> {
  const conds: string[] = [];
  const binds: unknown[] = [];
  if (kindPrefix) {
    conds.push("kind LIKE ?");
    binds.push(`${kindPrefix}%`);
  }
  for (const prefix of excludePrefixes) {
    conds.push("kind NOT LIKE ?");
    binds.push(`${prefix}%`);
  }

  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const { results } = await env.DB.prepare(
    `SELECT * FROM github_jobs${where} ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<JobRow>();

  const rows = results ?? [];
  const cfg = ghConfig(env);
  return Promise.all(rows.map((r) => refreshJob(env, cfg, r).catch(() => r)));
}

export async function insertJob(
  env: Env,
  kind: string,
  params: Record<string, unknown>,
  run: WorkflowRun | null,
  error: string | null,
): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO github_jobs (id, kind, status, params, gh_run_id, run_url, error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      kind,
      error ? "failure" : mapStatus(run, "queued"),
      JSON.stringify(params),
      run?.id ?? null,
      run?.html_url ?? null,
      error,
      now,
      now,
    )
    .run();
}