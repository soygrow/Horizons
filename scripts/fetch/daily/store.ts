// 采集层存储：只写 date-partitioned 的原始 JSON + Star 采样状态。
// 原子写入，避免中断留下半个文件；重复执行同一天会覆盖当天的原始文件（幂等）。

import fs from "node:fs";
import path from "node:path";
import { dailyConfig } from "./config";
import type { Digest, RawDigest, StarState } from "./types";

const ROOT = path.resolve(process.cwd(), "content/digest");
export const RAW_DIR = path.join(ROOT, "raw");
const STATE_DIR = path.join(ROOT, "state");
export const STAR_STATE_PATH = path.join(STATE_DIR, "github-stars.json");

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file: string, payload: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

export function rawPath(date: string): string {
  return path.join(RAW_DIR, `${date}.json`);
}

export function saveRawDigest(digest: RawDigest): string {
  const file = rawPath(digest.date);
  writeJsonAtomic(file, digest);
  return file;
}

export function digestPath(date: string): string {
  return path.join(ROOT, `${date}.json`);
}

export function saveDigest(digest: Digest): string {
  const file = digestPath(digest.date);
  writeJsonAtomic(file, digest);
  return file;
}

export function loadDigest(date: string): Digest | null {
  try {
    return JSON.parse(fs.readFileSync(digestPath(date), "utf-8")) as Digest;
  } catch {
    return null;
  }
}

export function loadRawDigest(date: string): RawDigest | null {
  try {
    return JSON.parse(fs.readFileSync(rawPath(date), "utf-8")) as RawDigest;
  } catch {
    return null;
  }
}

/** 跨天「见过」索引：url -> 首次发现时间，用于首次发现展示与旧闻识别 */
export interface SeenIndex {
  [key: string]: { firstSeenAt: string; date: string };
}

export const SEEN_INDEX_PATH = path.join(STATE_DIR, "seen.json");

export function loadSeenIndex(): SeenIndex {
  try {
    return JSON.parse(fs.readFileSync(SEEN_INDEX_PATH, "utf-8")) as SeenIndex;
  } catch {
    return {};
  }
}

export function saveSeenIndex(index: SeenIndex): void {
  writeJsonAtomic(SEEN_INDEX_PATH, index);
}

/** 只保留最近 60 天的记录，避免索引无限膨胀 */
export function pruneSeenIndex(index: SeenIndex, keepDays = 60): SeenIndex {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const out: SeenIndex = {};
  for (const [key, value] of Object.entries(index)) {
    if (value.firstSeenAt >= cutoff) out[key] = value;
  }
  return out;
}

export function loadStarState(): StarState {
  try {
    return JSON.parse(fs.readFileSync(STAR_STATE_PATH, "utf-8")) as StarState;
  } catch {
    return {};
  }
}

export function saveStarState(state: StarState): void {
  writeJsonAtomic(STAR_STATE_PATH, state);
}

/**
 * 记录本次采样并返回相对上一次采样的增量。
 * 只有一次采样时 delta 为 0——不能因为「今天第一次看到」就说它在涨。
 */
export function recordStarSample(
  state: StarState,
  repo: string,
  stars: number,
  at: string,
): number {
  const history = state[repo] ?? [];
  const prev = history.length > 0 ? history[history.length - 1].stars : null;
  // 同一分钟内重复执行不追加样本
  const lastAt = history.length > 0 ? Date.parse(history[history.length - 1].at) : 0;
  if (Date.now() - lastAt > 60_000) {
    history.push({ at, stars });
    state[repo] = history.slice(-dailyConfig.github.keepSamples);
  } else {
    state[repo] = history;
  }
  return prev === null ? 0 : Math.max(0, stars - prev);
}