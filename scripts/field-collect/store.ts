/**
 * 结果落地：D1 写一行（field_collect_runs）+ 截图推 R2。
 *
 * 为什么写 D1 而不是 commit 一个 JSON 文件：
 *   - 仓库里的 content/*.json 会触发站点重建，这个验证页跟线上数据毫无关系，
 *     不该为了看一眼字段结果就跑一次部署；
 *   - 后台列表和详情页都要按需读，D1 一行一查最省事。
 *
 * 依赖自带的极简实现（REST 优先，本地退回 wrangler 登录态），不改动 scripts/admin/d1-client.ts。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_DB_ID = "355e5cca-29ca-4b37-90a5-6c88d94e7a4b";
const DB_NAME = "horizons-db";
const R2_BUCKET = "horizons-archive";

export interface RunPatch {
  id: string;
  url: string;
  domain: string;
  status: "queued" | "running" | "success" | "failure";
  step?: string | null;
  filled?: number;
  total?: number;
  desktopUrl?: string | null;
  mobileUrl?: string | null;
  result?: unknown;
  error?: string | null;
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`store: 不支持内联的类型 ${typeof v}`);
}

function inline(sql: string, params: readonly unknown[]): string {
  let i = 0;
  const out = sql.replace(/\?/g, () => sqlLiteral(params[i++]));
  if (i !== params.length) throw new Error(`store: 占位符 ${i} 个，参数 ${params.length} 个`);
  return out;
}

/** 执行一条带参数绑定的语句；REST 可用时走 REST（CI），否则用本机 wrangler 登录态 */
export async function d1Query(sql: string, params: readonly unknown[] = []): Promise<void> {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId = process.env.D1_DATABASE_ID || DEFAULT_DB_ID;

  if (token && account) {
    const res = await fetch(`${CF_API}/accounts/${account}/d1/database/${dbId}/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql, params }),
    });
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; errors?: { message?: string }[]; result?: { success?: boolean }[] }
      | null;
    if (!res.ok || !body?.success || body.result?.[0]?.success === false) {
      const detail = body?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
      throw new Error(`D1 写入失败：${detail}`);
    }
    return;
  }

  execFileSync(
    "pnpm",
    ["--filter", "@horizons/api", "exec", "wrangler", "d1", "execute", DB_NAME, "--remote", "--command", inline(sql, params)],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * 写一行采集记录。
 *
 * UPSERT 而不是 UPDATE：后台点按钮时 API 先插一行（拿到 id 才能让前端立刻看到），
 * 但本地手动跑脚本时库里可能还没有这行 —— 两条路径共用同一句 SQL 才不会分叉。
 * run_url / gh_run_id 只在脚本自己知道时才覆盖（CI 里由 GITHUB_RUN_ID 提供）。
 */
export async function saveRun(patch: RunPatch): Promise<void> {
  const now = Date.now();
  const ghRunId = Number(process.env.GITHUB_RUN_ID ?? 0) || null;
  const runUrl =
    ghRunId && process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${ghRunId}`
      : null;

  await d1Query(
    `INSERT INTO field_collect_runs
       (id, url, domain, status, step, filled, total, desktop_url, mobile_url,
        gh_run_id, run_url, result, error, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       step = excluded.step,
       filled = excluded.filled,
       total = excluded.total,
       desktop_url = excluded.desktop_url,
       mobile_url = excluded.mobile_url,
       gh_run_id = COALESCE(excluded.gh_run_id, field_collect_runs.gh_run_id),
       run_url = COALESCE(excluded.run_url, field_collect_runs.run_url),
       result = COALESCE(excluded.result, field_collect_runs.result),
       error = excluded.error,
       updated_at = excluded.updated_at`,
    [
      patch.id,
      patch.url,
      patch.domain,
      patch.status,
      patch.step ?? null,
      patch.filled ?? 0,
      patch.total ?? 0,
      patch.desktopUrl ?? null,
      patch.mobileUrl ?? null,
      ghRunId,
      runUrl,
      patch.result === undefined ? null : JSON.stringify(patch.result),
      patch.error ?? null,
      now,
      now,
    ],
  );
}

/**
 * 截图推 R2。
 *
 * key 必须是平铺文件名（不能带 /）：站点 Worker 的 /screenshots/* 只按平铺 key 取图，
 * 带斜杠会被当成路径穿越挡掉。前缀 `fieldcollect-` 与现有工具的
 * `<domain>.png` 命名完全隔开，不会覆盖线上已知站的截图。
 */
export async function putScreenshot(file: string, key: string): Promise<string> {
  const bin = path.resolve(process.cwd(), "apps/site/node_modules/.bin/wrangler");
  execFileSync(
    bin,
    ["r2", "object", "put", `${R2_BUCKET}/${key}`, `--file=${file}`, "--content-type=image/png", "--remote"],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 },
  );
  return `/screenshots/${key}`;
}