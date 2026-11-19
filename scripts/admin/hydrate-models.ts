/**
 * 从 D1 还原 `content/models.json` —— 构建链路的第一步。
 *
 * 与工具榜 / 趋势榜同一套思路：模型榜的唯一真源是 D1 的当前版本快照
 *   `board_listed`（名次/卡片）+ `board_listed_details`（完整模型对象），
 * 仓库里的 `content/models.json` 不再入库（.gitignore），只作为构建缓存存在，
 * 每次构建前由本脚本重新生成 —— 内容和线上榜单一致，不会跑偏。
 *
 * 与工具榜的唯一区别：模型文件是**带元数据的对象**，不是裸数组。
 * `mode` / `source` / `sources` / `note` / `capabilityNote` 是采集侧的说明与来源统计，
 * 不是条目的字段，所以发布时整块写进 `board_stats.meta`，这里原样拼回去。
 *
 * 三种失败一律硬失败（构建不能悄悄用旧数据）：
 *   1. 没有 D1 通道；
 *   2. 当前版本一条都没有；
 *   3. 有条目缺 detail（详情页会缺页）。
 *
 * 为什么一次读完：370 条 detail 合计约 0.5MB，分页只会把「一次线性扫描」
 * 拆成八次重复扫描（Σoffset）。整榜都要用，就没有分页的理由。
 *
 * 用法：
 *   pnpm tsx scripts/admin/hydrate-models.ts                  # 写 content/models.json
 *   pnpm tsx scripts/admin/hydrate-models.ts --dry            # 只读不写，打印统计
 *   pnpm tsx scripts/admin/hydrate-models.ts --from 2026-11-19T01:20:17
 *   pnpm tsx scripts/admin/hydrate-models.ts --out /tmp/models.json
 *   pnpm tsx scripts/admin/hydrate-models.ts --force          # 允许条数明显下降
 *   pnpm tsx scripts/admin/hydrate-models.ts --no-snapshot    # 强制走 D1
 *   pnpm tsx scripts/admin/hydrate-models.ts --upload-snapshot
 */
import fs from "node:fs";
import path from "node:path";
import { createD1Client, d1Configured } from "./d1-client";
import { currentBoardVersion, readSnapshot, snapshotEnabled, writeSnapshot } from "./snapshot";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MODELS_PATH = path.join(ROOT, "content/models.json");
const BOARD = "models";

/** 条数安全阀：新数据比现有缓存少这么多就拒绝覆盖 */
const MIN_RATIO = 0.9;

export interface ModelRecord {
  slug: string;
  name: string;
  provider: string;
  capability: number;
  tags?: string[];
  price?: { input?: number | null; output?: number | null; cachedInput?: number | null } | null;
  [key: string]: unknown;
}

/** 文件的元数据部分：不含 models 的其余字段，发布时存进 board_stats.meta */
export type ModelsMeta = Record<string, unknown>;

export interface HydrateModelsResult {
  version: string;
  models: ModelRecord[];
  meta: ModelsMeta;
  /** 缺 detail 的 slug（非空时调用方应视为失败） */
  missing: string[];
}

interface ListedPageRow {
  item_key: string;
  rank: number;
  detail: string | null;
}

/** 库里 detail 是 `{ data, derived }` 包装，条目本体在 data 里（与 publish-models 一致） */
function unpack(detail: string): ModelRecord {
  const parsed = JSON.parse(detail) as { data?: ModelRecord };
  return parsed.data ?? (parsed as unknown as ModelRecord);
}

/**
 * 读取指定版本（默认当前生效版本）的完整模型列表，按 rank 升序。
 *
 * 不写盘 —— publish-models / 采集脚本复用同一份实现，
 * 避免「构建还原」和「发布基线」两套读法算出不同的榜单。
 */
export async function readListedModels(version?: string): Promise<HydrateModelsResult> {
  const client = createD1Client();

  /* 本机 wrangler 通道偶发网络抖动，只读查询重试；写语句的重试交给发布脚本 */
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
  if (!ver) throw new Error("库里没有 config.current_version，说明这个库还没发布过榜单");

  const countRow = await read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
    [ver, BOARD],
  );
  const total = countRow.results[0]?.n ?? 0;
  if (total === 0) throw new Error(`版本 ${ver} 里没有 models 榜数据，拒绝用它还原榜单文件`);

  const statRow = await read<{ total: number; updated_at: string | null; meta: string | null }>(
    "SELECT total, updated_at, meta FROM board_stats WHERE board = ?",
    [BOARD],
  );
  const stat = statRow.results[0];

  let meta: ModelsMeta = {};
  if (stat?.meta) {
    try {
      meta = JSON.parse(stat.meta) as ModelsMeta;
    } catch {
      console.warn("[hydrate] board_stats.meta 不是合法 JSON，按无元数据处理");
    }
  }
  /* 老版本发布时还没有 meta 列：用版本号与条数拼一个最小可用的头，保证页面不空 */
  if (!meta.updatedAt) meta.updatedAt = ver.slice(0, 10);
  if (!meta.mode) meta.mode = "live";

  const models: ModelRecord[] = [];
  const missing: string[] = [];

  const page = await read<ListedPageRow>(
    `SELECT l.item_key, l.rank, d.detail
       FROM board_listed l
       LEFT JOIN board_listed_details d
         ON d.version = l.version AND d.board = l.board AND d.item_key = l.item_key
      WHERE l.version = ? AND l.board = ?
      ORDER BY l.rank
      LIMIT ?`,
    [ver, BOARD, total],
  );

  for (const row of page.results) {
    if (!row.detail) {
      missing.push(row.item_key);
      continue;
    }
    const model = unpack(row.detail);
    /*
     * slug 必须与 item_key 一致：详情页路由是 /models/<slug>，
     * 而更新接口按 item_key 定位线上条目。以库里的 key 为准并告警。
     */
    if (model.slug !== row.item_key) {
      console.warn(
        `::warning::[hydrate] ${row.item_key} 的 detail.slug=${model.slug ?? "(空)"}，已按库里的 key 纠正`,
      );
      model.slug = row.item_key;
    }
    models.push(model);
  }

  if (models.length !== total - missing.length) {
    throw new Error(`读到的条数与计数不一致：${models.length} ≠ ${total} - ${missing.length}`);
  }

  return { version: ver, models, meta, missing };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readExisting(): ModelRecord[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8")) as { models?: ModelRecord[] };
    return Array.isArray(raw.models) ? raw.models : null;
  } catch {
    return null;
  }
}

/** 条数骤降保护：构建宁可失败，也不要把线上榜换成残缺版 */
function assertNotShrunk(count: number, force: boolean, existing: ModelRecord[] | null): void {
  if (force || !existing?.length) return;
  if (count >= existing.length * MIN_RATIO) return;
  throw new Error(
    `还原出 ${count} 条，比现有文件的 ${existing.length} 条少很多（阈值 ${Math.round(
      MIN_RATIO * 100,
    )}%）。\n` +
      "通常是版本指针指到了一个没有 models 的快照，或换库了。确认无误后加 --force。",
  );
}

/** 原子写：写临时文件再 rename，构建中途失败也不会留下半截 JSON */
function writeAtomic(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const uploadSnap = process.argv.includes("--upload-snapshot");
  const out = arg("out") ? path.resolve(ROOT, arg("out") as string) : MODELS_PATH;

  /* 快照优先：发布后导出一次，之后构建不再碰 D1 */
  if (snapshotEnabled() && d1Configured()) {
    const ver = arg("from") ?? (await currentBoardVersion());
    const buf = ver ? await readSnapshot(BOARD, ver) : null;
    if (buf) {
      const payload = JSON.parse(buf.toString("utf8")) as { models?: ModelRecord[] };
      const models = Array.isArray(payload.models) ? payload.models : [];
      if (models.length === 0) throw new Error(`快照 ${ver} 里没有模型数据，拒绝用它还原站点数据`);
      assertNotShrunk(models.length, force, readExisting());
      if (!dry) writeAtomic(out, payload);
      console.log(
        `[hydrate]${dry ? " dry-run" : ""} 快照命中 boards/${BOARD}/${ver}.json｜${models.length} 条` +
          `｜${(buf.length / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, out)}`,
      );
      console.log(
        JSON.stringify({
          version: ver,
          count: models.length,
          bytes: buf.length,
          source: "snapshot",
          out: path.relative(ROOT, out),
          dry,
        }),
      );
      return;
    }
  }

  /* 没有 D1 通道时：有缓存就沿用（本地开发），没有就硬失败（否则构建出空榜） */
  if (!d1Configured()) {
    const existing = readExisting();
    if (existing?.length) {
      console.log(
        `[hydrate] 无 D1 通道（CLOUDFLARE_API_TOKEN 或 wrangler 登录态），` +
          `沿用现有文件 ${existing.length} 条`,
      );
      return;
    }
    throw new Error(
      "无法还原模型榜：既没有 D1 凭据，本地也没有 content/models.json。\n" +
        "配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或执行 `pnpm wrangler login`。",
    );
  }

  const { version, models, meta, missing } = await readListedModels(arg("from"));

  if (missing.length > 0) {
    throw new Error(
      `版本 ${version} 里有 ${missing.length} 条缺 detail，详情页会缺页：` +
        `${missing.slice(0, 12).join("、")}${missing.length > 12 ? " …" : ""}\n` +
        "先重新发布这些条目（发布时会补写 detail），或确认快照是否完整。",
    );
  }

  assertNotShrunk(models.length, force, readExisting());

  const payload = { ...meta, models };
  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2));
  const summary = { version, count: models.length, bytes, out: path.relative(ROOT, out), dry };

  if (!dry) writeAtomic(out, payload);

  /* 发布流程收尾：导出快照，之后构建读 R2 而不是 D1 */
  if (uploadSnap && !dry) {
    const hit = await writeSnapshot(BOARD, version, JSON.stringify(payload, null, 2) + "\n", true);
    if (hit) console.log(`[snapshot] ${hit.key}｜${(hit.bytes / 1024).toFixed(0)}KB`);
  }

  console.log(
    `[hydrate]${dry ? " dry-run" : ""} 版本 ${version}｜${models.length} 条` +
      `｜${(bytes / 1024).toFixed(0)}KB → ${summary.out}`,
  );
  console.log(JSON.stringify(summary));
}

/* 被 publish-models 当模块 import 时不能触发退出 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error("[hydrate] 失败：", e);
    process.exitCode = 1;
  });
}