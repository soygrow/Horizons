/**
 * 整版榜单快照：构建不再从 D1 逐页拉数据。
 *
 * 为什么需要：
 *   GitHub 榜 1500 条、每条一个详情对象，构建时必须全量物化（静态站要为每个
 *   repo 生成一个详情页）。当前做法是每次构建从 D1 分页拉 1500 行 + 1500 条
 *   detail —— 一天里采集、发布、部署各拉一遍，合计十几万 rows read。
 *   而这批数据在一次发布之后就不变了：发布时导出一次、构建时读同一个对象，
 *   是同一份数据，没必要让 D1 反复搬。
 *
 * 存在哪：R2 桶 horizons-archive（`boards/<board>/<version>.json`）。
 *   内存放的是「与 content/*.json 完全一致的最终文件内容」，hydrate 命中时
 *   原样写盘 —— 这样快照与 D1 还原是同一个东西，不需要维护两套拼装逻辑。
 *
 * 降级：R2 不可用（没凭据、没登录、对象不存在）一律返回 null，
 *   hydrate 自动退回 D1。快照是加速层，不能成为构建的单点故障。
 *
 * 开关：`HORIZONS_SNAPSHOT=0` 全体关闭；单次运行加 `--no-snapshot`。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../..");
const BUCKET = process.env.HORIZONS_SNAPSHOT_BUCKET || "horizons-archive";

/** wrangler 装在两个 app 里，谁在就用谁 */
function wranglerBin(): string | null {
  for (const p of [
    path.join(ROOT, "apps/site/node_modules/.bin/wrangler"),
    path.join(ROOT, "apps/api/node_modules/.bin/wrangler"),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function snapshotEnabled(): boolean {
  if (process.argv.includes("--no-snapshot")) return false;
  /* 要导出快照就必须从库读最新数据，否则会把上一份快照原样再传一次 */
  if (process.argv.includes("--upload-snapshot")) return false;
  return process.env.HORIZONS_SNAPSHOT !== "0";
}

export function snapshotKey(board: string, version: string): string {
  return `boards/${board}/${version}.json`;
}

/**
 * 当前生效版本号。
 *
 * 读全库指针是一次主键查找（1 行），比「先猜一个 key 再看对象在不在」可靠：
 * 快照对象名必须带版本，否则发布新版后构建会读到旧版快照。
 */
export async function currentBoardVersion(): Promise<string | undefined> {
  const { createD1Client } = await import("./d1-client");
  const client = createD1Client();
  const res = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key = 'config.current_version'",
    [],
  );
  return res.results[0]?.val;
}

function tmpFile(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hz-snap-")), name);
}

export interface SnapshotHit {
  key: string;
  bytes: number;
}

/**
 * 读快照。不存在 / 读不了都返回 null（由调用方退回 D1）。
 *
 * `--remote` 必须带：默认行为是读本地模拟桶，那里永远是空的。
 */
export async function readSnapshot(board: string, version: string): Promise<Buffer | null> {
  const bin = wranglerBin();
  if (!bin) return null;

  const key = snapshotKey(board, version);
  const out = tmpFile(`${board}-${version}.json`.replace(/[^\w.-]/g, "_"));
  try {
    await execFileAsync(
      bin,
      ["r2", "object", "get", `${BUCKET}/${key}`, `--file=${out}`, "--remote"],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
    );
    if (!fs.existsSync(out)) return null;
    const buf = fs.readFileSync(out);
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

/**
 * 写快照（覆盖同版本旧对象）。失败只告警，不影响发布/还原。
 *
 * 17MB 的 github 快照走 wrangler 上传约 10–30s，比从 D1 拉 1500 行快一个量级。
 */
export async function writeSnapshot(
  board: string,
  version: string,
  body: string,
  strict = false,
): Promise<SnapshotHit | null> {
  const bin = wranglerBin();
  if (!bin) {
    if (strict) throw new Error("[snapshot] 找不到 wrangler，无法导出快照");
    console.warn("[snapshot] 找不到 wrangler，跳过快照上传");
    return null;
  }

  const key = snapshotKey(board, version);
  const file = tmpFile(`${board}.json`);
  try {
    fs.writeFileSync(file, body, "utf-8");
    await execFileAsync(
      bin,
      [
        "r2",
        "object",
        "put",
        `${BUCKET}/${key}`,
        `--file=${file}`,
        "--content-type=application/json",
        "--remote",
      ],
      { cwd: ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 300_000 },
    );
    return { key, bytes: Buffer.byteLength(body) };
  } catch (e) {
    const msg = `[snapshot] 上传失败：${String(e).slice(0, 300)}`;
    /* 发布流程里必须硬失败：快照落后于库,构建会读到旧数据 */
    if (strict) throw new Error(msg);
    console.warn(`${msg}（不影响还原，下次构建仍走 D1）`);
    return null;
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}