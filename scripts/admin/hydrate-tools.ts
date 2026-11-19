/**
 * 从 D1 还原 `content/aitools.json` —— 构建链路的第一步。
 *
 * 第二期起，AI 工具榜的唯一真源是 D1 的当前版本快照：
 *   `board_listed`（名次/卡片）+ `board_listed_details`（完整 tool 对象）。
 * 仓库里的 `content/aitools.json` 不再入库（.gitignore），只作为构建缓存存在，
 * 每次构建前由本脚本重新生成 —— 内容和线上榜单逐字节一致，不会跑偏。
 *
 * 为什么取 detail 而不是 card：
 *   card 在发布时被刻意削掉了 pageStructure（单条 11KB，列表查询用不上），
 *   detail 才是发布那一刻的完整 AITool。详情页、sitemap 都依赖完整字段。
 *
 * 为什么一次读完（不再分页）：
 *   203 条 detail 合计约 5MB，一次查询即可，往返次数从 14 次降到 1 次。
 *   分页本身没有意义 —— 整榜都要用，`OFFSET` 只是把一次线性扫描拆成了
 *   十四次重复扫描（Σoffset ≈ 1.4k 行）。
 *
 * 三种失败一律硬失败（构建不能悄悄用旧数据）：
 *   1. 没有 D1 通道且没有快照；
 *   2. 当前版本一条都没有；
 *   3. 有条目缺 detail（详情页会缺页）。
 *
 * 用法：
 *   pnpm tsx scripts/admin/hydrate-tools.ts                  # 写 content/aitools.json
 *   pnpm tsx scripts/admin/hydrate-tools.ts --dry            # 只读不写，打印统计
 *   pnpm tsx scripts/admin/hydrate-tools.ts --from 2026-11-10T12:00:00
 *   pnpm tsx scripts/admin/hydrate-tools.ts --out /tmp/tools.json
 *   pnpm tsx scripts/admin/hydrate-tools.ts --force          # 允许条数明显下降
 *   pnpm tsx scripts/admin/hydrate-tools.ts --no-snapshot    # 强制走 D1
 *   pnpm tsx scripts/admin/hydrate-tools.ts --upload-snapshot
 *
 * 无凭据时的行为由调用方决定（`strict=false` 时返回 null 而不是退出）：
 * 本地开发不想每次都连库，但 CI 里必须成功。
 */
import fs from "node:fs";
import path from "node:path";
import type { AITool } from "@horizons/shared";
import { createD1Client, d1Configured } from "./d1-client";
import { currentBoardVersion, readSnapshot, snapshotEnabled, writeSnapshot } from "./snapshot";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOLS_PATH = path.join(ROOT, "content/aitools.json");
const BOARD = "tools";

/**
 * 条数安全阀：新数据比现有文件少这么多就拒绝覆盖。
 *
 * 典型的踩坑是「指针指到一个只发布了 github 的版本」或「D1 迁移到新库」，
 * 此时 D1 里 tools 是空的或只有几十条，构建会把线上页面删掉一半。
 * 真正需要缩减榜单时加 --force。
 */
const MIN_RATIO = 0.9;

/**
 * 采集期的簿记字段，不是榜单数据 —— 与 publish-tools 的 toCleanTool 保持一致。
 *
 * 线上快照里（至少老版本写入的）可能残留这些字段，还原时必须剔除：
 * 否则它们会跟着 detail 一路传回正在发布的新版本，越积越多。
 */
const BOOKKEEPING = ["stage", "kind", "refreshFrom", "fieldGaps", "enrichedAt"] as const;

export interface HydrateResult {
  version: string;
  tools: AITool[];
  /** 缺 detail 的域名（非空时调用方应视为失败） */
  missing: string[];
}

interface ListedPageRow {
  item_key: string;
  rank: number;
  detail: string | null;
}

/**
 * 读取指定版本（默认当前生效版本）的完整工具列表，按 rank 升序。
 *
 * 不写盘、不校验文件体积，纯读 —— 便于 publish-tools 复用同一份实现，
 * 避免「构建还原」和「发布基线」两套读法算出不同的榜单。
 */
export async function readListedTools(version?: string): Promise<HydrateResult> {
  const client = createD1Client();

  /*
   * 本机 wrangler 通道偶发 `A fetch request failed`（网络抖动，不是数据问题），
   * 而 210 条要读 11 页 —— 一次抖动就让整个构建失败太脆。
   * 这里只重试只读查询，写语句的重试仍然交给各发布脚本自己决定。
   */
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

  // 线上口径以当前版本指针为准，不允许不带 version 查 board_listed
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

  const countRow = await read<{ n: number }>(
    "SELECT COUNT(*) AS n FROM board_listed WHERE version = ? AND board = ?",
    [ver, BOARD],
  );
  const total = countRow.results[0]?.n ?? 0;
  if (total === 0) {
    throw new Error(`版本 ${ver} 里没有 tools 榜数据，拒绝用它还原榜单文件`);
  }

  const tools: AITool[] = [];
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
    const tool = JSON.parse(row.detail) as AITool;
    for (const k of BOOKKEEPING) delete (tool as unknown as Record<string, unknown>)[k];
    /*
     * domain 必须与 item_key 一致：详情页路由是 /tools/<domain>，
     * 而更新接口按 item_key 定位线上条目。两者错位会让「点了更新却更新不到」。
     * 以库里的 key 为准并告警 —— key 是发布时写死的，不会自己变。
     */
    if (tool.domain !== row.item_key) {
      console.warn(
        `::warning::[hydrate] ${row.item_key} 的 detail.domain=${tool.domain ?? "(空)"}，已按库里的 key 纠正`,
      );
      tool.domain = row.item_key;
    }
    tools.push(tool);
  }

  if (tools.length !== total - missing.length) {
    throw new Error(`读到的条数与计数不一致：${tools.length} ≠ ${total} - ${missing.length}`);
  }

  return { version: ver, tools, missing };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readExisting(): AITool[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as unknown;
    return Array.isArray(raw) ? (raw as AITool[]) : null;
  } catch {
    return null;
  }
}

/** 条数骤降保护：构建宁可失败，也不要把线上榜换成残缺版 */
function assertNotShrunk(count: number, force: boolean, existing: AITool[] | null): void {
  if (force || !existing?.length) return;
  if (count >= existing.length * MIN_RATIO) return;
  throw new Error(
    `还原出 ${count} 条，比现有文件的 ${existing.length} 条少很多（阈值 ${Math.round(
      MIN_RATIO * 100,
    )}%）。\n` +
      "通常是版本指针指到了一个没有 tools 的快照，或换库了。确认无误后加 --force。",
  );
}

/** 原子写：写临时文件再 rename，构建中途失败也不会留下半截 JSON */
function writeAtomic(file: string, tools: readonly AITool[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tools, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const uploadSnap = process.argv.includes("--upload-snapshot");
  const out = arg("out") ? path.resolve(ROOT, arg("out") as string) : TOOLS_PATH;

  /* 快照优先：发布后导出一次，之后构建不再碰 board_listed_details */
  if (snapshotEnabled() && d1Configured()) {
    const ver = arg("from") ?? (await currentBoardVersion());
    const buf = ver ? await readSnapshot(BOARD, ver) : null;
    if (buf) {
      const tools = JSON.parse(buf.toString("utf8")) as AITool[];
      if (!Array.isArray(tools) || tools.length === 0) {
        throw new Error(`快照 ${ver} 里没有工具数据，拒绝用它还原站点数据`);
      }
      assertNotShrunk(tools.length, force, readExisting());
      if (!dry) writeAtomic(out, tools);
      console.log(
        `[hydrate]${dry ? " dry-run" : ""} 快照命中 boards/${BOARD}/${ver}.json｜${tools.length} 条` +
          `｜${(buf.length / 1024 / 1024).toFixed(1)}MB → ${path.relative(ROOT, out)}`,
      );
      console.log(
        JSON.stringify({
          version: ver,
          count: tools.length,
          bytes: buf.length,
          source: "snapshot",
          out: path.relative(ROOT, out),
          dry,
        }),
      );
      return;
    }
  }

  /*
   * 没有 D1 通道时：
   *   - 已有可用文件 → 告警后沿用（本地 astro dev / 没登录 wrangler 的场景）；
   *   - 没有文件 → 硬失败，因为构建出来会是一条都没有的空榜。
   */
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
      "无法还原榜单：既没有 D1 凭据，本地也没有 content/aitools.json。\n" +
        "配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或执行 `pnpm wrangler login`。",
    );
  }

  const { version, tools, missing } = await readListedTools(arg("from"));

  if (missing.length > 0) {
    throw new Error(
      `版本 ${version} 里有 ${missing.length} 条缺 detail，详情页会缺页：` +
        `${missing.slice(0, 12).join("、")}${missing.length > 12 ? " …" : ""}\n` +
        "先重新发布这些条目（发布时会补写 detail），或确认快照是否完整。",
    );
  }

  assertNotShrunk(tools.length, force, readExisting());

  const bytes = Buffer.byteLength(JSON.stringify(tools, null, 2));
  const summary = {
    version,
    count: tools.length,
    bytes,
    out: path.relative(ROOT, out),
    dry,
  };

  if (!dry) writeAtomic(out, tools);

  /* 发布流程收尾：导出快照，之后构建读 R2 而不是 D1 */
  if (uploadSnap && !dry) {
    const hit = await writeSnapshot(BOARD, version, JSON.stringify(tools, null, 2) + "\n", true);
    if (hit) console.log(`[snapshot] ${hit.key}｜${(hit.bytes / 1024 / 1024).toFixed(1)}MB`);
  }

  console.log(
    `[hydrate]${dry ? " dry-run" : ""} 版本 ${version}｜${tools.length} 条` +
      `｜${(bytes / 1024 / 1024).toFixed(1)}MB → ${summary.out}`,
  );
  console.log(JSON.stringify(summary));
}

/*
 * 只有直接执行时才跑 CLI：被 publish-tools 当模块 import 时不能触发退出
 * （否则 dry-run 里会顺手写一次文件）。
 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error("[hydrate] 失败：", e);
    process.exitCode = 1;
  });
}