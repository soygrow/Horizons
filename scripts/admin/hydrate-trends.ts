/**
 * 从 D1 还原 `content/trends.json` —— 构建链路的第一步。
 *
 * 和 hydrate-tools.ts 同一套思路：榜单的唯一真源是 D1 的当前版本快照
 * （`board_listed` 名次/卡片 + `board_listed_details` 完整对象），
 * 仓库里的 `content/trends.json` 不再入库（.gitignore），只作为构建缓存存在。
 *
 * 与工具榜的唯一区别：趋势词有别名（variantOf）。
 * 别名也要上线（/trends/<slug> 是长尾 SEO 入口），但不占名次，所以：
 *   - `variant_of` 为空的是代表词，rank 从 1 连续；
 *   - `variant_of` 有值的是别名，rank 继承代表词，还原时插在代表词后面。
 *
 * 三种失败一律硬失败（构建不能悄悄用旧数据）：
 *   1. 没有 D1 通道；
 *   2. 当前版本一条都没有；
 *   3. 有条目缺 detail（详情页会缺页）。
 *
 * 为什么一次读完：487 条 detail 合计约 2.3MB，一次查询把 `OFFSET` 的重复扫描
 * 和「每页重新排序」都消掉了 —— 原来 `ORDER BY rank, (variant_of IS NOT NULL), item_key`
 * 带表达式，用不上索引，每页都要全量取 + 临时 B 树排序，一轮二十多页就是二十多次排序。
 *
 * 用法：
 *   pnpm tsx scripts/admin/hydrate-trends.ts                  # 写 content/trends.json
 *   pnpm tsx scripts/admin/hydrate-trends.ts --dry            # 只读不写，打印统计
 *   pnpm tsx scripts/admin/hydrate-trends.ts --from 2026-11-17T10:14:25
 *   pnpm tsx scripts/admin/hydrate-trends.ts --out /tmp/trends.json
 *   pnpm tsx scripts/admin/hydrate-trends.ts --force          # 允许条数明显下降
 *   pnpm tsx scripts/admin/hydrate-trends.ts --no-snapshot    # 强制走 D1
 *   pnpm tsx scripts/admin/hydrate-trends.ts --upload-snapshot
 */
import fs from "node:fs";
import path from "node:path";
import type { AITrend, EntryPolicy, TrendDataset } from "@horizons/shared";
import { createD1Client, d1Configured } from "./d1-client";
import { currentBoardVersion, readSnapshot, snapshotEnabled, writeSnapshot } from "./snapshot";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TRENDS_PATH = path.join(ROOT, "content/trends.json");
const POLICY_PATH = path.join(ROOT, "content/trends-policy.json");
const BOARD = "trends";

/** 条数安全阀：新数据比现有缓存少这么多就拒绝覆盖 */
const MIN_RATIO = 0.9;

/**
 * 采集期的簿记字段，不是榜单数据。
 *
 * `enrichStatus` 只对候选池有意义（pending/failed），进榜的词一律是已富化；
 * `previousSnapshot` 是刷新前的对比副本，发布时剥离，还原时也不能带回来。
 */
const BOOKKEEPING = ["enrichStatus", "previousSnapshot"] as const;

export interface HydrateTrendsResult {
  version: string;
  trends: AITrend[];
  /** 别名条数（不占名次，仅在页面上单独成页） */
  aliases: number;
  /** 缺 detail 的 slug（非空时调用方应视为失败） */
  missing: string[];
}

interface ListedPageRow {
  item_key: string;
  rank: number;
  variant_of: string | null;
  detail: string | null;
}

/**
 * 读取指定版本（默认当前生效版本）的完整趋势列表。
 *
 * 不写盘、不校验体积，纯读 —— 便于将来自检脚本复用同一份实现。
 */
export async function readListedTrends(version?: string): Promise<HydrateTrendsResult> {
  const client = createD1Client();

  /* 本机 wrangler 通道偶发网络抖动，只读查询重试几次，避免一次抖动让构建失败 */
  const read = async <T>(sql: string, params: readonly unknown[]): Promise<{ results: T[] }> => {
    let last: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await client.query<T>(sql, params);
      } catch (e) {
        last = e;
        if (attempt < 4) await new Promise((r) => setTimeout(r, 1200 * attempt));
      }
    }
    throw last;
  };

  let ver = version;
  if (!ver) {
    const cur = await read<{ val: string }>(
      "SELECT val FROM app_config WHERE key = 'config.current_version'",
      [],
    );
    ver = cur.results[0]?.val;
  }

  if (!ver) {
    throw new Error("库里没有 config.current_version，说明这个库还没发布过榜单");
  }

  const countRow = await read<{ n: number; alias: number }>(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN variant_of IS NULL THEN 0 ELSE 1 END) AS alias
       FROM board_listed WHERE version = ? AND board = ?`,
    [ver, BOARD],
  );
  const total = countRow.results[0]?.n ?? 0;
  const aliasCount = countRow.results[0]?.alias ?? 0;
  if (total === 0) {
    throw new Error(`版本 ${ver} 里没有 trends 榜数据，拒绝用它还原榜单文件`);
  }

  const trends: AITrend[] = [];
  const missing: string[] = [];

  let page: { results: ListedPageRow[] };
  try {
    page = await read<ListedPageRow>(
      `SELECT l.item_key, l.rank, l.variant_of, d.detail
         FROM board_listed l
         LEFT JOIN board_listed_details d
           ON d.version = l.version AND d.board = l.board AND d.item_key = l.item_key
         WHERE l.version = ? AND l.board = ?
         ORDER BY l.rank, (l.variant_of IS NOT NULL), l.item_key
         LIMIT ?`,
      [ver, BOARD, total],
    );
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("no such column") && msg.includes("variant_of")) {
      throw new Error(
        "board_listed 还没有 variant_of 列：先执行 apps/api/migrations/0018_board_listed_variant.sql，"
          + "再重新发布一次趋势榜（把别名写进库）。",
      );
    }
    throw e;
  }

  for (const row of page.results) {
    if (!row.detail) {
      missing.push(row.item_key);
      continue;
    }
    const trend = JSON.parse(row.detail) as AITrend;
    for (const k of BOOKKEEPING) delete (trend as unknown as Record<string, unknown>)[k];
    /*
     * slug 必须与 item_key 一致：详情页路由是 /trends/<slug>，
     * 别名指向代表词也靠 slug 对上。以库里的 key 为准并告警。
     */
    if (trend.slug !== row.item_key) {
      console.warn(
        `::warning::[hydrate] ${row.item_key} 的 detail.slug=${trend.slug ?? "(空)"}，已按库里的 key 纠正`,
      );
      trend.slug = row.item_key;
    }
    // 别名关系以库里的 variant_of 为准：detail 里可能缺这个字段（老数据）
    if (row.variant_of) trend.variantOf = row.variant_of;
    else delete trend.variantOf;
    trends.push(trend);
  }

  if (trends.length !== total - missing.length) {
    throw new Error(`读到的条数与计数不一致：${trends.length} ≠ ${total} - ${missing.length}`);
  }

  return { version: ver, trends, aliases: aliasCount, missing };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readExisting(): AITrend[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TRENDS_PATH, "utf-8")) as TrendDataset | AITrend[];
    if (Array.isArray(raw)) return raw;
    return Array.isArray(raw.keywords) ? raw.keywords : null;
  } catch {
    return null;
  }
}

function readPolicy(): EntryPolicy | undefined {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8")) as EntryPolicy;
  } catch {
    return undefined;
  }
}

/** 条数骤降保护：构建宁可失败，也不要把线上榜换成残缺版 */
function assertNotShrunk(count: number, force: boolean, existing: AITrend[] | null): void {
  if (force || !existing?.length) return;
  if (count >= existing.length * MIN_RATIO) return;
  throw new Error(
    `还原出 ${count} 条，比现有缓存的 ${existing.length} 条少很多`
      + `（阈值 ${Math.round(MIN_RATIO * 100)}%）。\n`
      + "常见原因：这一版只发布了部分词，或库里还没有别名行（旧版本发布时过滤了 variantOf）。\n"
      + "确认无误后加 --force 强制覆盖。",
  );
}

/** 原子写：写临时文件再 rename，构建中途失败也不会留下半截 JSON */
function writeAtomic(file: string, payload: TrendDataset): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const uploadSnap = process.argv.includes("--upload-snapshot");
  const out = arg("out") ? path.resolve(ROOT, arg("out") as string) : TRENDS_PATH;

  /* 快照优先：发布后导出一次，之后构建不再碰 D1 */
  if (snapshotEnabled() && d1Configured()) {
    const ver = arg("from") ?? (await currentBoardVersion());
    const buf = ver ? await readSnapshot(BOARD, ver) : null;
    if (buf) {
      const payload = JSON.parse(buf.toString("utf8")) as TrendDataset;
      const trends = Array.isArray(payload.keywords) ? payload.keywords : [];
      if (trends.length === 0) throw new Error(`快照 ${ver} 里没有趋势词，拒绝用它还原站点数据`);
      assertNotShrunk(trends.length, force, readExisting());
      if (!dry) writeAtomic(out, payload);
      console.log(
        `[hydrate]${dry ? " dry-run" : ""} 快照命中 boards/${BOARD}/${ver}.json｜${trends.length} 条` +
          `｜${(buf.length / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, out)}`,
      );
      console.log(
        JSON.stringify({
          version: ver,
          count: trends.length,
          bytes: buf.length,
          source: "snapshot",
          out: path.relative(ROOT, out),
          dry,
        }),
      );
      return;
    }
  }

  if (!d1Configured()) {
    const existing = readExisting();
    if (existing?.length) {
      console.log(
        `[hydrate] 无 D1 通道（CLOUDFLARE_API_TOKEN 或 wrangler 登录态），`
          + `沿用现有缓存 ${existing.length} 条`,
      );
      return;
    }
    throw new Error(
      "无法还原趋势榜：既没有 D1 凭据，本地也没有 content/trends.json。\n"
        + "配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或执行 `pnpm wrangler login`。",
    );
  }

  const { version, trends, aliases, missing } = await readListedTrends(arg("from"));

  if (missing.length > 0) {
    throw new Error(
      `版本 ${version} 里有 ${missing.length} 条缺 detail，详情页会缺页：`
        + `${missing.slice(0, 12).join("、")}${missing.length > 12 ? " …" : ""}\n`
        + "先重新发布这些条目（发布时会补写 detail），或确认快照是否完整。",
    );
  }

  assertNotShrunk(trends.length, force, readExisting());

  const policy = readPolicy();
  const payload: TrendDataset = {
    // 版本号是 UTC 秒级，补成 ISO 便于站点展示「数据截止」
    updatedAt: `${version.replace(" ", "T")}Z`,
    mode: "live",
    region: "US",
    keywords: trends,
    ...(policy ? { policy } : {}),
  };

  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2));
  if (!dry) writeAtomic(out, payload);

  /* 发布流程收尾：导出快照，之后构建读 R2 而不是 D1 */
  if (uploadSnap && !dry) {
    const hit = await writeSnapshot(BOARD, version, JSON.stringify(payload, null, 2) + "\n", true);
    if (hit) console.log(`[snapshot] ${hit.key}｜${(hit.bytes / 1024).toFixed(0)}KB`);
  }

  console.log(
    `[hydrate]${dry ? " dry-run" : ""} 版本 ${version}｜${trends.length} 条`
      + `（代表词 ${trends.length - aliases} + 别名 ${aliases}）`
      + `｜${(bytes / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, out)}`,
  );
  console.log(
    JSON.stringify({ version, count: trends.length, aliases, bytes, out: path.relative(ROOT, out), dry }),
  );
}

/* 被其他脚本 import 时不能触发落盘 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error("[hydrate] 失败：", e);
    process.exitCode = 1;
  });
}