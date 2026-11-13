/**
 * 采集结果缓存（按域名，月度滚动）。
 *
 * 数据源（Similarweb / SERP）一个月才更新一次，月内重复采集同一个域名等于重复付费：
 * 之前调试两轮 cliputils 就花了 $0.04。所以缓存不按小时走，而是对齐数据源的刷新节奏 ——
 * 有效期一律截到「下一个 3 号 00:00」：
 *
 *   11-03 采 → 12-03 00:00 过期（用户口径：3 号调用的缓存到下个月 3 号）
 *   11-20 采 → 12-03 00:00 过期
 *   11-01 采 → 11-03 00:00 过期（1 号拿到的还是未补齐的上月数据，3 号刷新后必须重采）
 *
 * 文件落在 .cache/field-collect/<domain>.json（已 gitignore），
 * 用 --refresh 可以强制绕过缓存做回归。
 */
import fs from "node:fs";
import path from "node:path";

export interface CacheEntry<T> {
  domain: string;
  collectedAt: string;
  /** 硬过期时间：下一个 3 号 00:00 */
  expiresAt: string;
  payload: T;
}

export interface CacheHit<T> {
  payload: T;
  collectedAt: string;
  expiresAt: string;
  file: string;
}

/** 数据源每月 3 号刷新一次，缓存生命周期以它为锚点 */
const REFRESH_DAY = 3;

export function cacheDir(): string {
  return process.env.FC_CACHE_DIR || path.join(process.cwd(), ".cache", "field-collect");
}

/**
 * 下一次「数据刷新日」：本月 3 号还没到就是本月 3 号，否则顺延到下月 3 号。
 * 一律取本地时区 00:00，避免 UTC 差异导致 3 号白天还在读旧缓存。
 */
export function nextRefreshAt(now: Date = new Date()): Date {
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), REFRESH_DAY, 0, 0, 0, 0);
  if (now.getTime() < thisMonth.getTime()) return thisMonth;
  return new Date(now.getFullYear(), now.getMonth() + 1, REFRESH_DAY, 0, 0, 0, 0);
}

function cacheFile(domain: string): string {
  const safe = domain.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return path.join(cacheDir(), `${safe}.json`);
}

/** 命中返回缓存内容；过期 / 损坏 / 不存在一律当未命中（不抛错，缓存坏了不该阻塞采集） */
export function readCache<T>(domain: string, now: Date = new Date()): CacheHit<T> | null {
  const file = cacheFile(domain);
  if (!fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEntry<T>;
    if (!entry?.payload || !entry.expiresAt) return null;
    if (Date.parse(entry.expiresAt) <= now.getTime()) return null;
    return { payload: entry.payload, collectedAt: entry.collectedAt, expiresAt: entry.expiresAt, file };
  } catch {
    return null;
  }
}

export function writeCache<T>(domain: string, payload: T, now: Date = new Date()): CacheEntry<T> {
  const entry: CacheEntry<T> = {
    domain,
    collectedAt: now.toISOString(),
    expiresAt: nextRefreshAt(now).toISOString(),
    payload,
  };
  const file = cacheFile(domain);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry));
  return entry;
}