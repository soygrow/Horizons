/**
 * 采集结果的统一存取层（D1）。
 *
 * 这里只做两件事，且都不发外部请求：
 *
 *   1. `cachedFetch()` —— 付费源「先查库、没有再买」。命中时返回 cost=0，
 *      调用方据此打印账目即可，不需要自己判断是否重复采购。
 *   2. `traffic_history` 月度序列 —— 每次拿到 vortex 快照就把**所有**返回月份写进去，
 *      页面读近 6 个月、缺月补 0。vortex 一次给 3 个月，采两次就能凑满 6 格。
 *
 * 为什么不用文件缓存：CI 每次 checkout 都是干净环境，文件缓存等于没有。
 * 仓库里原有的 `.cache/field-collect/` 只在本地调试时有效，正式链路以 D1 为准。
 *
 * 没有 D1 通道时**不抛错**：返回 null / 空数组，让调用方退化成「每次都买」。
 * 本地能看到 warn，线上 workflow 缺凭据时会在 fetch-staging 的 assertD1 处更早失败。
 */
import { createD1Client, d1Configured, type D1Client } from "../admin/d1-client";

/** 采集源标识。新增源时同步加到 collect_raw.source 的注释里 */
export type CollectSource =
  | "vortex_base"
  | "vortex_aitdk"
  | "vortex_similar"
  | "serp"
  | "html"
  | "pricing"
  | "wayback"
  | "crtsh"
  | "commoncrawl"
  | "lergassy";

/** 只有 vortex_base 按月过期，其余源按域名全局唯一 */
const MONTHLY_SOURCES: ReadonlySet<CollectSource> = new Set<CollectSource>(["vortex_base"]);

/* ------------------------------- 月份工具 ------------------------------- */

/** Date → 'YYYY-MM' */
export function monthKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 'YYYY-MM' 加减月份，用于拼「近 N 个月」的区间 */
export function shiftMonth(ym: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return ym;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + delta;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** 当前快照月份：3 号之前拿到的还是未补齐的上月数据，沿用上月 */
export function currentPeriod(now: Date = new Date()): string {
  const day = now.getUTCDate();
  const d = day < 3 ? new Date(now.getTime() - 3 * 86_400_000) : now;
  return monthKey(d);
}

/* ------------------------------- 客户端 ------------------------------- */

let shared: D1Client | null | undefined;

function db(): D1Client | null {
  if (shared !== undefined) return shared;
  if (!d1Configured()) {
    console.warn("[collect] 未配置 D1 通道，采集结果不落库（重复调用会重复付费）");
    shared = null;
    return null;
  }
  try {
    shared = createD1Client();
  } catch (e) {
    console.warn(`[collect] 初始化 D1 失败：${e instanceof Error ? e.message : String(e)}`);
    shared = null;
  }
  return shared;
}

/* ------------------------------ 前置检查 ------------------------------ */

/**
 * 确认两张表存在。
 *
 * 迁移没应用时，写入会被 catch 成 warn，读也被当成「未命中」——
 * 结果是每轮采集都把 vortex 重新买一遍，钱花了、数据还是没存下来。
 * 所以付费调用前先探一次表，缺表直接中止整轮，而不是默默烧钱。
 */
export async function assertStore(): Promise<void> {
  const client = db();
  if (!client) return;
  try {
    await client.query("SELECT 1 FROM collect_raw LIMIT 1", []);
    await client.query("SELECT 1 FROM traffic_history LIMIT 1", []);
  } catch (e) {
    throw new Error(
      "采集表不存在，请先应用迁移 apps/api/migrations/0016_collect_raw.sql：" +
        "`pnpm wrangler d1 migrations apply horizons-db --remote`。" +
        `原始错误：${e instanceof Error ? e.message.slice(0, 200) : String(e)}`,
    );
  }
}

/* ------------------------------ 原始响应 ------------------------------ */

export interface RawRecord<T = unknown> {
  domain: string;
  source: CollectSource;
  period: string;
  ok: boolean;
  payload: T | null;
  error: string | null;
  costUsd: number;
  via: string;
  fetchedAt: number;
}

/**
 * 读一条原始响应。
 *
 * `source` 是月度源时 `period` 必传，否则拿不到「本月是否已经买过」的答案；
 * 非月度源忽略 `period`，按域名取最新一条。
 */
export async function getRaw<T = unknown>(
  domain: string,
  source: CollectSource,
  period = "",
): Promise<RawRecord<T> | null> {
  const client = db();
  if (!client) return null;

  const d = domain.toLowerCase();
  const monthly = MONTHLY_SOURCES.has(source);
  try {
    const res = monthly
      ? await client.query<{
          domain: string;
          source: string;
          period: string;
          ok: number;
          payload: string | null;
          error: string | null;
          cost_usd: number;
          via: string | null;
          fetched_at: number;
        }>(
          "SELECT domain, source, period, ok, payload, error, cost_usd, via, fetched_at " +
            "FROM collect_raw WHERE domain=? AND source=? AND period=?",
          [d, source, period],
        )
      : await client.query<{
          domain: string;
          source: string;
          period: string;
          ok: number;
          payload: string | null;
          error: string | null;
          cost_usd: number;
          via: string | null;
          fetched_at: number;
        }>(
          "SELECT domain, source, period, ok, payload, error, cost_usd, via, fetched_at " +
            "FROM collect_raw WHERE domain=? AND source=? ORDER BY fetched_at DESC LIMIT 1",
          [d, source],
        );

    const row = res.results?.[0];
    if (!row) return null;
    return {
      domain: row.domain,
      source: row.source as CollectSource,
      period: row.period ?? "",
      ok: row.ok === 1,
      payload: row.payload ? (JSON.parse(row.payload) as T) : null,
      error: row.error ?? null,
      costUsd: row.cost_usd ?? 0,
      via: row.via ?? "",
      fetchedAt: row.fetched_at,
    };
  } catch (e) {
    console.warn(
      `[collect] 读取 ${d}/${source} 失败（按未命中处理）：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return null;
  }
}

/** 写一条原始响应（按 domain+source+period 覆盖） */
export async function saveRaw<T = unknown>(
  record: Omit<RawRecord<T>, "fetchedAt" | "period"> & { period?: string },
): Promise<boolean> {
  const client = db();
  if (!client) return false;

  const period = MONTHLY_SOURCES.has(record.source) ? (record.period ?? "") : "";
  try {
    await client.query(
      `INSERT INTO collect_raw (domain, source, period, ok, payload, error, cost_usd, via, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (domain, source, period) DO UPDATE SET
         ok = excluded.ok,
         payload = excluded.payload,
         error = excluded.error,
         cost_usd = excluded.cost_usd,
         via = excluded.via,
         fetched_at = excluded.fetched_at`,
      [
        record.domain.toLowerCase(),
        record.source,
        period,
        record.ok ? 1 : 0,
        record.payload === null || record.payload === undefined
          ? null
          : JSON.stringify(record.payload),
        record.error ?? null,
        record.costUsd ?? 0,
        record.via ?? null,
        Date.now(),
      ],
    );
    return true;
  } catch (e) {
    console.warn(
      `[collect] 写入 ${record.domain}/${record.source} 失败：${
        e instanceof Error ? e.message.slice(0, 160) : String(e)
      }`,
    );
    return false;
  }
}

/* ------------------------------ 带缓存的调用 ------------------------------ */

export interface FetchOutcome<T> {
  payload: T | null;
  error?: string;
  /** 本次真实花费；命中缓存为 0 */
  costUsd: number;
  /** true = 直接用了库里的旧响应，没有调用外部接口 */
  cached: boolean;
  /** true = 库里只有一条失败记录，本次仍按未命中重试过 */
  retried?: boolean;
}

export interface CachedFetchOptions {
  /** 谁在调：admission | enrich，落库用于溯源 */
  via: string;
  /** true = 忽略缓存强制重买（后台「强制刷新」用） */
  force?: boolean;
  /**
   * 失败记录要不要复用。
   *
   * 默认 false：上一次 401 / 限流失败不该让这个站永远拿不到数据，
   * 下次进来必须重试。传 true 则连失败结果一起缓存（适合确定性的 404）。
   */
  cacheFailure?: boolean;
}

/**
 * 「先查库、没有再买」。
 *
 * `run()` 返回 `{ payload, error?, costUsd? }`：payload 为 null 视为失败，
 * 失败默认不写缓存（见 cacheFailure），下次调用会重新尝试。
 */
export async function cachedFetch<T>(
  domain: string,
  source: CollectSource,
  period: string,
  run: () => Promise<{ payload: T | null; error?: string; costUsd?: number }>,
  opts: CachedFetchOptions = { via: "unknown" },
): Promise<FetchOutcome<T>> {
  if (!opts.force) {
    const hit = await getRaw<T>(domain, source, period);
    if (hit && (hit.ok || opts.cacheFailure)) {
      if (hit.ok && hit.payload !== null) {
        return { payload: hit.payload, costUsd: 0, cached: true };
      }
      if (!hit.ok && opts.cacheFailure) {
        return { payload: null, error: hit.error ?? "上次调用失败", costUsd: 0, cached: true };
      }
    }
  }

  const r = await run();
  const ok = r.payload !== null && r.payload !== undefined;
  const costUsd = ok ? (r.costUsd ?? 0) : 0;

  // 失败也落一行，但 cost 记 0：后台能看出「这个站试过了、失败了」，
  // 而账目上不会因为失败被计入花费。
  await saveRaw({
    domain,
    source,
    period,
    ok,
    payload: r.payload ?? null,
    error: ok ? null : (r.error ?? "无数据"),
    costUsd,
    via: opts.via,
  });

  return { payload: r.payload ?? null, error: r.error, costUsd, cached: false };
}

/* ------------------------------ 月度序列 ------------------------------ */

export interface TrafficMonth {
  /** YYYY-MM */
  month: string;
  visits: number;
}

export interface TrafficPoint extends TrafficMonth {
  /** false = 该月没有采集记录，visits 是补的 0 */
  collected: boolean;
}

/** 每行 6 个绑定参数，D1 单语句上限 100 → 16 行一批（96 个） */
const TRAFFIC_ROWS_PER_STATEMENT = 16;

/**
 * 写入月度访问量（按 domain+month 覆盖）。
 *
 * 调用方应传 vortex 返回的**全部**月份，不只是当月：
 * 一次调用补 3 个月，两次就能把 6 个月的图填满，这是「缺月补 0」能自然收敛的前提。
 * visits <= 0 的月份直接跳过：0 写进库和「没采到」在页面上都是 0，
 * 但写 0 会掩盖「这个月确实采到了、只是数据异常」这件事。
 */
export async function saveTrafficMonths(
  domain: string,
  months: readonly TrafficMonth[],
  opts: { source?: string; snapshotDate?: string } = {},
): Promise<number> {
  const client = db();
  if (!client) return 0;

  const rows = months
    .filter((m) => /^\d{4}-\d{2}$/.test(m.month) && Number.isFinite(m.visits) && m.visits > 0)
    .map((m) => ({
      domain: domain.toLowerCase(),
      month: m.month,
      visits: Math.round(m.visits),
      source: opts.source ?? "vortex_base",
      snapshotDate: opts.snapshotDate ?? null,
    }));
  if (rows.length === 0) return 0;

  const now = Date.now();
  let written = 0;
  try {
    for (let i = 0; i < rows.length; i += TRAFFIC_ROWS_PER_STATEMENT) {
      const chunk = rows.slice(i, i + TRAFFIC_ROWS_PER_STATEMENT);
      const values = chunk.map(() => "(?,?,?,?,?,?)").join(",");
      const params: unknown[] = [];
      for (const r of chunk) {
        params.push(r.domain, r.month, r.visits, r.source, r.snapshotDate, now);
      }
      await client.query(
        `INSERT INTO traffic_history (domain, month, visits, source, snapshot_date, updated_at)
         VALUES ${values}
         ON CONFLICT (domain, month) DO UPDATE SET
           visits = excluded.visits,
           source = excluded.source,
           snapshot_date = excluded.snapshot_date,
           updated_at = excluded.updated_at`,
        params,
      );
      written += chunk.length;
    }
    return written;
  } catch (e) {
    console.warn(
      `[collect] 写入 ${domain} 月度序列失败：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
    );
    return written;
  }
}

/**
 * 读近 N 个月的访问量，缺失月份补 0（`collected=false`）。
 *
 * 页面固定画 6 个月，不因为「只有 3 个月数据」就把横轴缩到 3 个点 ——
 * 那样新站会显得像老站，也看不出数据是逐步累积起来的。
 */
export async function readTrafficMonths(
  domain: string,
  opts: { months?: number; now?: Date } = {},
): Promise<TrafficPoint[]> {
  const count = opts.months ?? 6;
  const end = monthKey(opts.now ?? new Date());
  const wanted: string[] = [];
  for (let i = count - 1; i >= 0; i--) wanted.push(shiftMonth(end, -i));

  const found = new Map<string, number>();
  const client = db();
  if (client) {
    try {
      const res = await client.query<{ month: string; visits: number }>(
        "SELECT month, visits FROM traffic_history WHERE domain=? AND month>=? ORDER BY month",
        [domain.toLowerCase(), wanted[0]],
      );
      for (const r of res.results ?? []) found.set(r.month, r.visits);
    } catch (e) {
      console.warn(
        `[collect] 读取 ${domain} 月度序列失败：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`,
      );
    }
  }

  return wanted.map((month) => {
    const visits = found.get(month);
    return visits === undefined
      ? { month, visits: 0, collected: false }
      : { month, visits, collected: true };
  });
}