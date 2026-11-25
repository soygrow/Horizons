/**
 * GitHub 仓库读写与 Actions 触发。
 *
 * 工具榜和趋势榜都要「后台点按钮 → 跑 Actions → 读仓库 JSON」，
 * 封装放这里，两边共用一份，避免分头修 bug。
 */
import type { Env } from "../env";

const GH_API = "https://api.github.com";

export interface GhConfig {
  token: string;
  repo: string;
}

export function ghConfig(env: Env): GhConfig | null {
  return env.GITHUB_TOKEN && env.GITHUB_REPO
    ? { token: env.GITHUB_TOKEN, repo: env.GITHUB_REPO }
    : null;
}

export function missingSecrets(env: Env): string[] {
  const missing: string[] = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");
  return missing;
}

async function ghFetch(cfg: GhConfig, path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "horizons-admin",
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  return fetch(`${GH_API}${path}`, {
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export interface RepoFile<T> {
  data: T;
  sha: string;
}

/** 读仓库 JSON；超过 1MB 时 contents API 不给内容，回落到 blobs API */
export async function readRepoJson<T>(cfg: GhConfig, path: string): Promise<RepoFile<T> | null> {
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/contents/${path}?ref=main`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github_read_${res.status}`);

  const meta = (await res.json()) as { sha: string; content?: string; encoding?: string };
  let text: string;
  if (meta.content && meta.encoding === "base64") {
    text = fromBase64(meta.content);
  } else {
    const blobRes = await ghFetch(cfg, `/repos/${cfg.repo}/git/blobs/${meta.sha}`);
    if (!blobRes.ok) throw new Error(`github_blob_${blobRes.status}`);
    text = fromBase64(((await blobRes.json()) as { content: string }).content);
  }
  return { data: JSON.parse(text) as T, sha: meta.sha };
}

export async function writeRepoJson(
  cfg: GhConfig,
  path: string,
  data: unknown,
  sha: string,
  message: string,
): Promise<boolean> {
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: toBase64(JSON.stringify(data, null, 2) + "\n"),
      sha,
      branch: "main",
    }),
  });
  return res.ok;
}

export interface RepoEntry {
  name: string;
  path: string;
  sha: string;
  size: number;
  type: string;
}

/** 列出目录；不存在时返回空数组（首期情报还没有目录，不该 500） */
export async function listRepoDir(cfg: GhConfig, path: string): Promise<RepoEntry[]> {
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/contents/${path}?ref=main`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`github_list_${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as RepoEntry[]) : [];
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at?: string;
  /** 真正开始跑的时间（排队时间不算），算耗时用这个 */
  run_started_at?: string;
  updated_at?: string;
  /** workflow_dispatch / schedule / push … */
  event?: string;
  /**
   * dispatch 时传的那几个 input。
   *
   * 注意：REST 的「列 runs」接口**不返回** inputs（只有 webhook 事件里才有），
   * 所以后台不能指望这个字段 —— 期号和模式主要靠 workflow 里写的 `run-name`
   * （落到 display_title 上），这里命中就当额外确认。
   */
  inputs?: Record<string, string> | null;
  /** workflow 里 `run-name:` 渲染出来的标题 */
  display_title?: string;
}

/**
 * 最近若干次运行。
 *
 * 后台的「运行记录」要的是列表而不是「最近一条」：一次失败之后，
 * 得能往上翻两行看是「这次改坏了」还是「上一版也一样」。
 */
export async function listWorkflowRuns(
  cfg: GhConfig,
  workflow: string,
  limit = 5,
): Promise<WorkflowRun[]> {
  const res = await ghFetch(
    cfg,
    `/repos/${cfg.repo}/actions/workflows/${workflow}/runs?branch=main&per_page=${limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs ?? [];
}

export async function latestRun(cfg: GhConfig, workflow: string): Promise<WorkflowRun | null> {
  const runs = await listWorkflowRuns(cfg, workflow, 1);
  return runs[0] ?? null;
}

/** dispatch 不返回 run id，只能对比触发前后的「最新 run」 */
export async function dispatchWorkflow(
  cfg: GhConfig,
  workflow: string,
  inputs: Record<string, string>,
): Promise<WorkflowRun> {
  const before = await latestRun(cfg, workflow);
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`dispatch_${res.status}:${detail.slice(0, 200)}`);
  }

  /*
   * dispatch 只回 204，run id 得靠对比「最新 run」反查，而 GitHub 建 run 有秒级延迟。
   * 原先只等 3×1.2s≈3.6 秒，赶上 GitHub 侧慢一点就拿不到 —— 调用方于是写进一行
   * gh_run_id 为空的任务：回源查不到它、也不会判失败，永远停在「排队中」。
   *
   * 现在拉到约 11 秒；仍未出现就抛错，让调用方按「派发失败」处理（不写库、释放占位），
   * 而不是留下一条永远不会动的记录。
   */
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? 1000 : 2000));
    const now = await latestRun(cfg, workflow);
    if (now && (!before || now.id !== before.id)) return now;
  }
  throw new Error("dispatch_unconfirmed:GitHub 已接收请求但未创建运行，请重试");
}

export function mapStatus(run: WorkflowRun | null, fallback: string): string {
  if (!run) return fallback;
  /*
   * GitHub 在 run 刚创建、还在等 runner 或等并发组释放时返回 pending。
   * 它和 queued 在后台是同一件事，必须落成 queued：库里出现第四种状态
   * （pending）后，回源校准和前端轮询的活跃判断都只认 queued/running，
   * 这条任务就再也不会有任何一次刷新，永远停在「排队中」。
   */
  if (run.status === "queued" || run.status === "requested" || run.status === "waiting") return "queued";
  if (run.status === "pending") return "queued";
  if (run.status === "in_progress") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion) return "failure";
  /*
   * 走到这里说明 GitHub 给了个我们没见过的中间态。兜底不能原样返回 ——
   * 那会把未知字符串写进库里当作 status，前端认不出、回源也筛不中。
   * 按「还没结束」处理，至少下一轮还会继续查它。
   */
  return "queued";
}

/** 拉取单次 run 的最新状态 */
export async function fetchRun(cfg: GhConfig, runId: number): Promise<WorkflowRun | null> {
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/actions/runs/${runId}`);
  if (!res.ok) return null;
  return (await res.json()) as WorkflowRun;
}

export interface RunFailure {
  job: string;
  step: string | null;
  url: string;
}

interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps?: Array<{ name: string; status: string; conclusion: string | null }>;
}

/**
 * 失败时把「哪个 job、哪一步、去哪看日志」带回来。
 *
 * 后台原来只显示一个裸的结论字符串（而且前端只认 failed、后端给的是
 * failure，红字都不会变），点进去还得自己在十几个步骤里翻。
 */
export async function failedJob(cfg: GhConfig, runId: number): Promise<RunFailure | null> {
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/actions/runs/${runId}/jobs?per_page=20`);
  if (!res.ok) return null;
  const body = (await res.json()) as { jobs?: WorkflowJob[] };
  const job = (body.jobs ?? []).find(
    (j) => j.conclusion && j.conclusion !== "success" && j.conclusion !== "cancelled",
  );
  if (!job) return null;
  const step = (job.steps ?? []).find((s) => s.conclusion === "failure");
  return { job: job.name, step: step?.name ?? null, url: job.html_url };
}