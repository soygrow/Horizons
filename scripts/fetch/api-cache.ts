/**
 * 付费 API 调用的「响应缓存 + 花费台账」。
 *
 * 解决的问题：DataForSEO $50 半天花完，根因是 fetch-apify / enrich-site /
 * fetch-domain-weight 三个脚本没有任何跳过逻辑，重跑一次就原价重花一次。
 *
 * 规则：
 *   1. 同一 (provider, endpoint, key) 在 TTL 内再次调用 → 直接读本地结果，花费 0；
 *   2. 失败/空结果同样落盘缓存 —— 否则「查不到」的站每次都要重新花钱再查一次；
 *   3. 每一次真实调用追加一行到 content/api-ledger.jsonl，随时可审计总花费。
 *
 * 环境变量：
 *   API_CACHE=off       关闭缓存，强制真实调用（调试用）
 *   API_CACHE_TTL=30    覆盖默认 TTL（天）
 *
 * 报表：pnpm tsx scripts/fetch/api-cache.ts --report
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type Provider = "apify" | "dataforseo" | "deepseek";

const ROOT = process.cwd();
/** 体积大、可重建 → 不进仓库 */
const CACHE_DIR = path.join(ROOT, "content/cache/api");
/** 体积小、要长期审计 → 进仓库 */
const LEDGER_PATH = path.join(ROOT, "content/api-ledger.jsonl");

const DEFAULT_TTL_DAYS = Number(process.env.API_CACHE_TTL ?? 30);

export interface CallOptions {
  provider: Provider;
  /** 接口标识，如 vortex_data/similarweb-scraper */
  endpoint: string;
  /** 缓存键：单站用 domain，批量用参数摘要 */
  key: string;
  /** 预估单次成本（美元），仅用于台账统计 */
  costUsd?: number;
  /** 覆盖默认 TTL（天） */
  ttlDays?: number;
  /** 强制跳过缓存 */
  force?: boolean;
  /**
   * 空结果是否落盘缓存，默认 true。
   * 付费源保持 true（避免反复为「查不到」付钱）；
   * 免费源设为 false，防止一次网络抖动/超时被固化成长期「无数据」。
   */
  cacheNull?: boolean;
}

interface CacheFile {
  provider: Provider;
  endpoint: string;
  key: string;
  at: string;
  ok: boolean;
  data: unknown;
}

interface LedgerEntry {
  at: string;
  provider: Provider;
  endpoint: string;
  key: string;
  costUsd: number;
  hit: boolean;
  ok: boolean;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
}

function cachePath(o: CallOptions): string {
  const h = crypto
    .createHash("sha1")
    .update(`${o.provider}|${o.endpoint}|${o.key}`)
    .digest("hex")
    .slice(0, 16);
  return path.join(CACHE_DIR, o.provider, `${slug(o.endpoint)}__${h}.json`);
}

function readCache(o: CallOptions): CacheFile | null {
  try {
    return JSON.parse(fs.readFileSync(cachePath(o), "utf-8")) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(o: CallOptions, ok: boolean, data: unknown): void {
  const p = cachePath(o);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body: CacheFile = {
    provider: o.provider,
    endpoint: o.endpoint,
    key: o.key,
    at: new Date().toISOString(),
    ok,
    data: ok ? data : null,
  };
  fs.writeFileSync(p, JSON.stringify(body), "utf-8");
}

function appendLedger(e: LedgerEntry): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(e) + "\n", "utf-8");
}

function isEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data) && data.length === 0) return true;
  return false;
}

/**
 * 带缓存与台账的调用包装。
 * 命中缓存时 fn 不会执行，因此不会产生任何外部请求。
 */
export async function cachedCall<T>(o: CallOptions, fn: () => Promise<T>): Promise<T> {
  const cacheEnabled = (process.env.API_CACHE ?? "on").toLowerCase() !== "off";
  const ttl = o.ttlDays ?? DEFAULT_TTL_DAYS;
  const force = o.force === true || !cacheEnabled;

  if (!force) {
    const hit = readCache(o);
    if (hit) {
      const ageDays = (Date.now() - Date.parse(hit.at)) / 86_400_000;
      if (Number.isFinite(ageDays) && ageDays <= ttl) {
        appendLedger({
          at: new Date().toISOString(),
          provider: o.provider,
          endpoint: o.endpoint,
          key: o.key,
          costUsd: 0,
          hit: true,
          ok: hit.ok,
        });
        return hit.data as T;
      }
    }
  }

  const data = await fn();
  const ok = !isEmpty(data);
  if (cacheEnabled && (ok || o.cacheNull !== false)) writeCache(o, ok, data);
  appendLedger({
    at: new Date().toISOString(),
    provider: o.provider,
    endpoint: o.endpoint,
    key: o.key,
    costUsd: o.costUsd ?? 0,
    hit: false,
    ok,
  });
  return data;
}

export interface LedgerSummary {
  calls: number;
  hits: number;
  missed: number;
  spentUsd: number;
  savedUsd: number;
  byProvider: Record<
    string,
    { calls: number; hits: number; spentUsd: number; savedUsd: number }
  >;
}

/** 汇总台账（用于 report 与脚本内自检） */
export function ledgerSummary(): LedgerSummary {
  const s: LedgerSummary = {
    calls: 0,
    hits: 0,
    missed: 0,
    spentUsd: 0,
    savedUsd: 0,
    byProvider: {},
  };
  let raw = "";
  try {
    raw = fs.readFileSync(LEDGER_PATH, "utf-8");
  } catch {
    return s;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: LedgerEntry;
    try {
      e = JSON.parse(line) as LedgerEntry;
    } catch {
      continue;
    }
    s.calls++;
    const p = (s.byProvider[e.provider] ??= { calls: 0, hits: 0, spentUsd: 0, savedUsd: 0 });
    p.calls++;
    if (e.hit) {
      s.hits++;
      p.hits++;
      // 命中缓存省下的钱：按该 provider 的平均单次成本估算
      p.savedUsd += e.costUsd;
    } else {
      s.missed++;
      s.spentUsd += e.costUsd;
      p.spentUsd += e.costUsd;
    }
  }
  return s;
}

function report(): void {
  const s = ledgerSummary();
  console.log("=== 付费 API 台账 ===");
  console.log(`  调用记录 ${s.calls} 条：命中缓存 ${s.hits}，真实调用 ${s.missed}`);
  console.log(`  实际花费 $${s.spentUsd.toFixed(4)}，缓存省下 $${s.savedUsd.toFixed(4)}`);
  console.log("  按 provider：");
  for (const [k, v] of Object.entries(s.byProvider)) {
    console.log(
      `    ${k.padEnd(12)} 调用 ${String(v.calls).padStart(4)}｜命中 ${String(v.hits).padStart(4)}｜花费 $${v.spentUsd.toFixed(4)}`,
    );
  }
  if (s.calls === 0) console.log("  （还没有任何记录，跑一次采集后即可看到）");
}

if (process.argv[1]?.includes("api-cache")) {
  report();
}