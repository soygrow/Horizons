/**
 * 单个榜的 D1 同步入口 —— models / opps / digest 共用。
 *
 * 与 tools / github / trends 里各自的 syncToD1 是同一套流程，区别只在于
 * 那三个要把同步挂在既有发布脚本里、还要处理各自的 dry-run 分支，
 * 这三个是独立脚本，所以把重复的部分收在这里。
 *
 * 灰度期 JSON 仍是线上数据源（data_source.* = file），D1 是冷备：
 * 写失败默认只告警，不阻塞文件发布。切流前加 --strict-d1 改成硬失败。
 */
import type { Board } from "@horizons/shared";
import { createD1Client, d1Configured } from "./d1-client";
import { lastReleaseRanks, pruneVersions, publishBoard, type PublishRow } from "./publish-board";

export interface SyncOptions {
  board: Board;
  rows: readonly PublishRow[];
  /** 谁触发的，进审计；CI 里传 GITHUB_ACTOR */
  actor: string;
  /**
   * 版本号，默认取当前 UTC 秒级 `YYYY-MM-DDTHH:mm:ss`。
   * 按日发布的榜（digest）传期号，补成 `YYYY-MM-DDT00:00:00` 保持格式统一。
   */
  version?: string;
}

export interface SyncResult {
  ok: boolean;
  version?: string;
  listed?: number;
  entered?: number;
  exited?: number;
  pruned?: string[];
  error?: string;
}

/**
 * 默认版本号：UTC 秒级 `YYYY-MM-DDTHH:mm:ss`。
 *
 * 分钟级不够用：采集落盘后经常同一分钟内连着发 models 和 digest，
 * 两个榜会拿到同一个版本号 —— 后一个被当成「重发」跳过，数据静默丢失。
 * 秒级把撞车概率压到很低，`publishBoard` 里还有一层兜底。
 */
export function versionOf(date = new Date()): string {
  return date.toISOString().slice(0, 19);
}

export async function syncBoardToD1(opts: SyncOptions): Promise<SyncResult> {
  const { board, rows, actor } = opts;

  if (process.argv.includes("--no-d1")) {
    console.log("[sync] --no-d1：跳过 D1 写入");
    return { ok: true };
  }
  if (!d1Configured()) {
    const msg =
      "没有可用的 D1 通道（既无 CLOUDFLARE_API_TOKEN / ACCOUNT_ID，本机也未 wrangler login）";
    if (process.argv.includes("--strict-d1")) throw new Error(`--strict-d1 但${msg}`);
    console.warn(`[sync] ${msg}，跳过 D1 写入（JSON 链路不受影响）`);
    return { ok: false, error: "missing-credentials" };
  }

  const version = opts.version ?? versionOf();

  try {
    const client = createD1Client();
    // 上期名次从库里取，不依赖 JSON 的历史顺序
    const previous = await lastReleaseRanks(client, board);

    const res = await publishBoard(client, { board, version, rows, actor, previous });

    // 同版本号重发：内容没变，正常跳过，不是失败
    if (res.skipped) {
      console.log(`[sync] ${board} ${res.version} 已生效且内容未变，跳过`);
      return { ok: true, version: res.version, listed: res.listed };
    }

    const pruned = await pruneVersions(client);

    console.log(
      `[sync] ${board} 已写入 ${res.version}：${res.listed} 条` +
        `（进 ${res.entered} / 出 ${res.exited} / 升 ${res.up} / 降 ${res.down}）`,
    );
    if (pruned.length > 0) console.log(`[sync] 已清理旧版本：${pruned.join(", ")}`);

    return {
      ok: true,
      version: res.version,
      listed: res.listed,
      entered: res.entered,
      exited: res.exited,
      pruned,
    };
  } catch (e) {
    if (process.argv.includes("--strict-d1")) throw e;
    console.error(`[sync] ${board} 写入失败，JSON 链路继续：`, e);
    return { ok: false, version, error: String(e) };
  }
}