/**
 * 从 D1 还原 `content/digest/<date>.json` —— 构建链路的日报一步。
 *
 * 从这一版起，往期情报的唯一真源是 D1 的 `digest_issues`：
 *   - 每期整份 JSON 原样存在 `payload` 里（写入见 `scripts/admin/digest-issues.ts`）；
 *   - 仓库里不再提交 `content/digest/<date>.json`（.gitignore），只作为构建缓存存在；
 *   - 站点仍是静态页（`/daily/[date]` 由 `apps/site/src/lib/digest.ts` 在构建期
 *     glob 读盘），所以只要构建前把文件重新物化出来，页面逻辑一行都不用改。
 *
 * 为什么不像 tools 那样走 R2 快照：一期 8KB 左右，一年也才 3MB，一次查询就搬完，
 * 多一跳对象存储只会多一个失败点。等期数真的过千再考虑。
 *
 * 三种失败一律硬失败（构建不能悄悄用旧数据）：
 *   1. 没有 D1 通道且本地也没有任何期；
 *   2. 库里一期都没有；
 *   3. 某期 payload 不是合法 JSON。
 *
 * 用法：
 *   pnpm tsx scripts/admin/hydrate-digest.ts                # 还原全部期
 *   pnpm tsx scripts/admin/hydrate-digest.ts --dry          # 只读不写，打印统计
 *   pnpm tsx scripts/admin/hydrate-digest.ts --limit 30     # 只还原最近 30 期（不清理）
 *   pnpm tsx scripts/admin/hydrate-digest.ts --no-prune     # 不删除库里没有的本地期
 *   pnpm tsx scripts/admin/hydrate-digest.ts --force        # 允许清理「比库里多」的本地期
 */
import fs from "node:fs";
import path from "node:path";
import { createD1Client, d1Configured } from "./d1-client";

const ROOT = path.resolve(import.meta.dirname, "../..");
const DIR = path.join(ROOT, "content/digest");
const ISSUE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

interface IssueRow {
  date: string;
  payload: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 本地已物化的期号（不含 raw/ state/ 与临时文件） */
function localDates(): string[] {
  if (!fs.existsSync(DIR)) return [];
  return fs
    .readdirSync(DIR)
    .filter((f) => ISSUE_RE.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/**
 * 读库里全部期（新→旧）。
 *
 * payload 是整期文件原文，一期 8KB 上下；一次查完比分页更省往返，
 * 也不会出现「翻页途中发布了新一期」导致期号错位。
 */
async function readIssues(limit: number | null): Promise<IssueRow[]> {
  const sql =
    "SELECT date, payload FROM digest_issues ORDER BY date DESC" +
    (limit && limit > 0 ? ` LIMIT ${Math.floor(limit)}` : "");
  const res = await createD1Client().query<IssueRow>(sql);
  return res.results.filter((r) => typeof r.date === "string" && ISSUE_RE.test(`${r.date}.json`));
}

/** 原子写：写临时文件再 rename，构建中途失败也不会留下半截 JSON */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const force = process.argv.includes("--force");
  const noPrune = process.argv.includes("--no-prune");
  const limit = arg("limit") ? Number(arg("limit")) : null;

  const local = localDates();

  /*
   * 没有 D1 通道时：
   *   - 本地已有期 → 告警后沿用（astro dev / 没登录 wrangler 的场景）；
   *   - 一期都没有 → 硬失败，构建出来会是一个空栏目。
   */
  if (!d1Configured()) {
    if (local.length) {
      console.log(
        `[hydrate:digest] 无 D1 通道（CLOUDFLARE_API_TOKEN 或 wrangler 登录态），` +
          `沿用现有 ${local.length} 期`,
      );
      return;
    }
    throw new Error(
      "无法还原每日情报：既没有 D1 凭据，本地也没有 content/digest/<date>.json。\n" +
        "配置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID，或执行 `pnpm wrangler login`。",
    );
  }

  const rows = await readIssues(limit);
  if (rows.length === 0) {
    throw new Error(
      "digest_issues 里一期都没有，拒绝用空数据生成站点。\n" +
        "先跑 `pnpm tsx scripts/admin/publish-digest.ts`（或后台点一次「发布本期」）。",
    );
  }

  let written = 0;
  let unchanged = 0;
  const bytesTotal = { n: 0 };

  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch {
      throw new Error(`${row.date} 的 payload 不是合法 JSON，库里的数据已损坏`);
    }

    const text = JSON.stringify(parsed, null, 2) + "\n";
    const file = path.join(DIR, `${row.date}.json`);
    bytesTotal.n += Buffer.byteLength(text);

    const prev = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
    if (prev === text) {
      unchanged++;
      continue;
    }
    if (!dry) writeAtomic(file, text);
    written++;
  }

  /*
   * 清理库里没有的本地期：它们要么是本地试跑留下的，要么是发布失败没入库的。
   * 留在盘上会直接变成线上页面 —— 「库里有几期，站点就有几期」才对得上。
   *
   * 库里期数比本地少时不清理（多半是库迁移 / 回填没跑完），除非 --force；
   * 指定 --limit 时同理：取的是子集，删掉更早的期会把历史页一起干掉。
   */
  const d1Set = new Set(rows.map((r) => r.date));
  const stale = local.filter((d) => !d1Set.has(d));
  let pruned: string[] = [];

  if (stale.length > 0 && !noPrune && !dry) {
    if (limit) {
      console.warn(`[hydrate:digest] 指定了 --limit ${limit}，跳过清理（避免删掉更早的期）`);
    } else if (d1Set.size < local.length && !force) {
      console.warn(
        `[hydrate:digest] 库里 ${d1Set.size} 期，比本地 ${local.length} 期少，` +
          `暂不清理 ${stale.join("、")}；确认无误后加 --force`,
      );
    } else {
      for (const d of stale) {
        fs.rmSync(path.join(DIR, `${d}.json`), { force: true });
      }
      pruned = stale;
    }
  }

  const newest = rows[0]?.date ?? "—";
  console.log(
    `[hydrate:digest]${dry ? " dry-run" : ""} ${rows.length} 期（最新 ${newest}）｜` +
      `写入 ${written} 期 / 未变 ${unchanged} 期｜` +
      `${(bytesTotal.n / 1024).toFixed(1)}KB → ${path.relative(ROOT, DIR)}` +
      (pruned.length ? `｜清理 ${pruned.length} 期（${pruned.join("、")}）` : ""),
  );
  console.log(
    JSON.stringify({
      count: rows.length,
      newest,
      written,
      unchanged,
      pruned,
      dry,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});