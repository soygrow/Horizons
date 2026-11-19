/**
 * 从 D1 还原 `content/github.json` —— 构建链路的第一步。
 *
 * 与工具榜 / 趋势榜 / 模型榜同一套思路：GitHub 榜的唯一真源是 D1 的当前版本快照
 *   `board_listed`（名次/卡片）+ `board_listed_details`（完整 repo，含 README），
 * 仓库里的 `content/github.json` 不再入库（.gitignore，62MB），只作为构建缓存存在。
 *
 * 为什么必须取 detail：`web-data.mjs` 要剥掉 README 生成 github-web.json，
 * 而 card 在发布时已经削掉了 README —— 只有 detail 是发布那一刻的完整对象。
 *
 * 读法：优先 R2 快照（发布时导出一次），没有快照才回落到 D1 游标分页。
 *
 * worker 版的 `readListedGithub` 用游标（`rank > 上一页最后一条`）而不是 OFFSET：
 * OFFSET 每翻一页都要从索引头重新跳过前面所有行，1500 条按 12/页读完整轮
 * 是 Σ12k ≈ 9.3 万 rows read；游标分页一轮正好 1500 行（+ 1500 次详情主键查找）。
 *
 * 三种失败一律硬失败（构建不能悄悄用旧数据）：
 *   1. 没有 D1 通道且没有快照；
 *   2. 当前版本一条都没有；
 *   3. 有条目缺 detail（详情页会缺页）。
 *
 * 用法：
 *   pnpm tsx scripts/admin/hydrate-github.ts                  # 写 content/github.json
 *   pnpm tsx scripts/admin/hydrate-github.ts --dry            # 只读不写，打印统计
 *   pnpm tsx scripts/admin/hydrate-github.ts --from 2026-11-19T01:20:17
 *   pnpm tsx scripts/admin/hydrate-github.ts --out /tmp/github.json
 *   pnpm tsx scripts/admin/hydrate-github.ts --force          # 允许条数明显下降
 *   pnpm tsx scripts/admin/hydrate-github.ts --no-snapshot    # 强制走 D1
 *   pnpm tsx scripts/admin/hydrate-github.ts --upload-snapshot  # 读 D1 后导出 R2 快照
 */
import fs from "node:fs";
import path from "node:path";
import type { GitHubRepo } from "@horizons/shared";
import { createD1Client, d1Configured } from "./d1-client";
import { currentBoardVersion, readSnapshot, snapshotEnabled, writeSnapshot } from "./snapshot";

const ROOT = path.resolve(import.meta.dirname, "../..");
const GITHUB_PATH = path.join(ROOT, "content/github.json");
const BOARD = "github";

/**
 * 游标分页的页大小。
 *
 * 发布侧已经剥掉 readme（74.8% 体积），单条 detail 从 184KB 降到 8KB；
 * 60 条/页 ≈ 0.5MB，远离 REST 响应与 wrangler 输出截断。
 */
const PAGE_SIZE = 60;

/** 条数安全阀：新数据比现有缓存少这么多就拒绝覆盖 */
const MIN_RATIO = 0.9;

/** 文件头（不含 repos），发布时整块存进 board_stats.meta */
export interface GithubMeta {
  updatedAt?: string;
  ruleVersion?: string;
  scoreModel?: string;
  [key: string]: unknown;
}

export interface HydrateGithubResult {
  version: string;
  repos: GitHubRepo[];
  meta: GithubMeta;
  /** 缺 detail 的 key（非空时调用方应视为失败） */
  missing: string[];
}

interface ListedPageRow {
  item_key: string;
  rank: number;
  detail: string | null;
}

/**
 * 读取指定版本（默认当前生效版本）的完整仓库列表，按 rank 升序。
 *
 * 不写盘 —— publish-github 也用它取「现榜基线」（旧榜保留 README 与中文情报），
 * 避免「构建还原」和「发布基线」两套读法算出不同的榜单。
 */
export async function readListedGithub(version?: string): Promise<HydrateGithubResult> {
  const client = createD1Client();

  /* 本机 wrangler 通道偶发网络抖动，只读查询重试；1500 条要读一百多页 */
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
  if (total === 0) throw new Error(`版本 ${ver} 里没有 github 榜数据，拒绝用它还原榜单文件`);

  const statRow = await read<{ meta: string | null }>(
    "SELECT meta FROM board_stats WHERE board = ?",
    [BOARD],
  );

  let meta: GithubMeta = {};
  if (statRow.results[0]?.meta) {
    try {
      meta = JSON.parse(statRow.results[0].meta) as GithubMeta;
    } catch {
      console.warn("[hydrate] board_stats.meta 不是合法 JSON，按无元数据处理");
    }
  }
  /* 老版本发布时还没有 meta 列：至少给出可用的 updatedAt，避免页面空白 */
  if (!meta.updatedAt) meta.updatedAt = ver;

  const repos: GitHubRepo[] = [];
  const missing: string[] = [];

  /*
   * 游标分页：每页从上一页最后一条的 rank 之后开始。
   * 索引 idx_listed_rank(version, board, rank) 一次范围扫描 + LIMIT 即可，
   * 不再有「翻到第 100 页就先跳过 1200 行」的重复读。
   */
  let cursor = -1;
  while (repos.length + missing.length < total) {
    const page = await read<ListedPageRow>(
      `SELECT l.item_key, l.rank, d.detail
         FROM board_listed l
         LEFT JOIN board_listed_details d
           ON d.version = l.version AND d.board = l.board AND d.item_key = l.item_key
        WHERE l.version = ? AND l.board = ? AND l.rank > ?
        ORDER BY l.rank
        LIMIT ?`,
      [ver, BOARD, cursor, PAGE_SIZE],
    );

    if (page.results.length === 0) break;

    for (const row of page.results) {
      cursor = row.rank;
      if (!row.detail) {
        missing.push(row.item_key);
        continue;
      }
      const repo = JSON.parse(row.detail) as GitHubRepo;
      /* item_key 是 fullName 小写，发布/更新接口按 fullName 定位，错了就更新不到 */
      if (repo.fullName?.toLowerCase() !== row.item_key.toLowerCase()) {
        console.warn(
          `::warning::[hydrate] ${row.item_key} 的 detail.fullName=${repo.fullName ?? "(空)"}，已按库里的 key 纠正`,
        );
        repo.fullName = row.item_key;
      }
      repos.push(repo);
    }

    if (page.results.length < PAGE_SIZE) break;
    if ((repos.length + missing.length) % (PAGE_SIZE * 20) < PAGE_SIZE) {
      console.log(`[hydrate] 已读 ${repos.length}/${total} 条…`);
    }
  }

  if (repos.length !== total - missing.length) {
    throw new Error(`读到的条数与计数不一致：${repos.length} ≠ ${total} - ${missing.length}`);
  }

  return { version: ver, repos, meta, missing };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readExisting(): GitHubRepo[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(GITHUB_PATH, "utf-8")) as { repos?: GitHubRepo[] };
    return Array.isArray(raw.repos) ? raw.repos : null;
  } catch {
    return null;
  }
}

/** 原子写：写临时文件再 rename，构建中途失败也不会留下半截 JSON */
function writeAtomic(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** 条数骤降保护：构建宁可失败，也不要把线上榜换成残缺版 */
function assertNotShrunk(count: number, force: boolean): void {
  const existing = readExisting();
  if (force || !existing?.length) return;
  if (count >= existing.length * MIN_RATIO) return;
  throw new Error(
    `还原出 ${count} 条，比现有文件的 ${existing.length} 条少很多（阈值 ${Math.round(
      MIN_RATIO * 100,
    )}%）。\n` +
      "通常是版本指针指到了一个没有 github 的快照，或换库了。确认无误后加 --force。",
  );
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const uploadSnap = process.argv.includes("--upload-snapshot");
  const out = arg("out") ? path.resolve(ROOT, arg("out") as string) : GITHUB_PATH;

  /*
   * 快照优先：发布后导出一次，之后构建只读 R2 对象。
   * 命中时不再碰 board_listed / board_listed_details（0 rows read）。
   */
  if (snapshotEnabled() && d1Configured()) {
    const ver = arg("from") ?? (await currentBoardVersion());
    const buf = ver ? await readSnapshot(BOARD, ver) : null;
    if (buf) {
      const payload = JSON.parse(buf.toString("utf8")) as GithubMeta & { repos?: GitHubRepo[] };
      const repos = Array.isArray(payload.repos) ? payload.repos : [];
      if (repos.length === 0) throw new Error(`快照 ${ver} 里没有 repos，拒绝用它还原站点数据`);
      assertNotShrunk(repos.length, force);
      if (!dry) writeAtomic(out, payload);
      const bytes = buf.length;
      console.log(
        `[hydrate]${dry ? " dry-run" : ""} 快照命中 boards/${BOARD}/${ver}.json｜${repos.length} 条` +
          `｜${(bytes / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, out)}`,
      );
      console.log(
        JSON.stringify({
          version: ver,
          count: repos.length,
          bytes,
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
      "无法还原 GitHub 榜：既没有 D1 凭据，本地也没有 content/github.json。\n" +
        "配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或执行 `pnpm wrangler login`。",
    );
  }

  const { version, repos, meta, missing } = await readListedGithub(arg("from"));

  if (missing.length > 0) {
    throw new Error(
      `版本 ${version} 里有 ${missing.length} 条缺 detail，详情页会缺页：` +
        `${missing.slice(0, 12).join("、")}${missing.length > 12 ? " …" : ""}\n` +
        "先重新发布这些条目（发布时会补写 detail），或确认快照是否完整。",
    );
  }

  assertNotShrunk(repos.length, force);

  const payload = { ...meta, repos };
  const bytes = Buffer.byteLength(JSON.stringify(payload, null, 2));
  const summary = { version, count: repos.length, bytes, out: path.relative(ROOT, out), dry };

  if (!dry) writeAtomic(out, payload);

  /* 发布流程的最后一步：把这份数据导出成快照，之后的构建就不用再碰 D1 */
  if (uploadSnap && !dry) {
    const hit = await writeSnapshot(BOARD, version, JSON.stringify(payload, null, 2) + "\n", true);
    if (hit) {
      console.log(
        `[snapshot] ${hit.key}｜${(hit.bytes / 1024 / 1024).toFixed(1)}MB`,
      );
    }
  }

  console.log(
    `[hydrate]${dry ? " dry-run" : ""} 版本 ${version}｜${repos.length} 条` +
      `｜${(bytes / 1024 / 1024).toFixed(1)}MB → ${summary.out}`,
  );
  console.log(JSON.stringify(summary));
}

/* 被 publish-github 当模块 import 时不能触发退出 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error("[hydrate] 失败：", e);
    process.exitCode = 1;
  });
}