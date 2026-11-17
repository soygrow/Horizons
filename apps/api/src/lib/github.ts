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
}

export async function latestRun(cfg: GhConfig, workflow: string): Promise<WorkflowRun | null> {
  const res = await ghFetch(
    cfg,
    `/repos/${cfg.repo}/actions/workflows/${workflow}/runs?branch=main&per_page=1`,
  );
  if (!res.ok) return null;
  const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
  return body.workflow_runs?.[0] ?? null;
}

/** dispatch 不返回 run id，只能对比触发前后的「最新 run」 */
export async function dispatchWorkflow(
  cfg: GhConfig,
  workflow: string,
  inputs: Record<string, string>,
): Promise<WorkflowRun | null> {
  const before = await latestRun(cfg, workflow);
  const res = await ghFetch(cfg, `/repos/${cfg.repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`dispatch_${res.status}:${detail.slice(0, 200)}`);
  }

  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 1200));
    const now = await latestRun(cfg, workflow);
    if (now && (!before || now.id !== before.id)) return now;
  }
  return null;
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