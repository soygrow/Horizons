/**
 * 模型榜 → D1。
 *
 * 模型榜只写库：`content/models.json` 不再入库，构建时由 `hydrate-models.ts`
 * 从库还原。本脚本吃的是「采集刚算出来的那一份」——通常由
 * `scripts/collect/index.mjs` 落在 `content/cache/models-pending.json` 后传进来。
 *
 * 名次口径与站点页面完全一致：综合分 = 0.9 × 能力 + 0.1 × 性价比，
 * 同分按名称字典序 —— 复用的是 `apps/site/src/lib/model-score.ts`，
 * 不在这里重写一遍公式，避免页面和榜单排名对不上。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-models.ts                     # 读 content/models.json（hydrate 出来的缓存）
 *   pnpm tsx scripts/admin/publish-models.ts --input content/cache/models-pending.json
 *   pnpm tsx scripts/admin/publish-models.ts --full               # 完整发布，建一个新版本（默认走增量）
 */
import fs from "node:fs";
import path from "node:path";
import { overallScore, valueScores } from "../../apps/site/src/lib/model-score";
import { currentBoardDataAt, syncBoardToD1, versionOf } from "./board-sync";
import type { PublishRow } from "./publish-board";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MODELS_PATH = path.join(ROOT, "content/models.json");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface ModelPrice {
  input?: number | null;
  output?: number | null;
  cachedInput?: number | null;
}

interface ModelRecord {
  slug: string;
  name: string;
  provider: string;
  capability: number;
  tags?: string[];
  price?: ModelPrice | null;
  [key: string]: unknown;
}

interface ModelsFile {
  updatedAt?: string;
  models: ModelRecord[];
  [key: string]: unknown;
}

async function main(): Promise<void> {
  const input = arg("input") ? path.resolve(ROOT, arg("input") as string) : MODELS_PATH;
  if (!fs.existsSync(input)) {
    throw new Error(
      `找不到 ${path.relative(ROOT, input)}。采集产物在 content/cache/models-pending.json，` +
        "用 --input 指过去；或者先跑 pnpm models:collect",
    );
  }
  const file = JSON.parse(fs.readFileSync(input, "utf-8")) as ModelsFile;
  const models = file.models ?? [];
  if (models.length === 0) throw new Error("模型数据里没有模型，拒绝发布空榜");

  /* 除 models 以外的字段都是文件头（来源统计、文案说明），原样存进 board_stats.meta */
  const { models: _ignored, ...meta } = file;

  // 性价比在全库样本内归一，和页面用同一套函数
  const valueMap = valueScores(
    models.map((m) => ({
      slug: m.slug,
      capability: m.capability,
      priceIn: m.price?.input ?? null,
      priceOut: m.price?.output ?? null,
    })),
  );

  const ordered = [...models].sort((a, b) => {
    const sa = overallScore(a.capability, valueMap.get(a.slug) ?? 0);
    const sb = overallScore(b.capability, valueMap.get(b.slug) ?? 0);
    if (sb !== sa) return sb - sa;
    return a.name.localeCompare(b.name);
  });

  /* 版本与数据截止日共用同一个时刻，避免两次取时间跨零点错一天 */
  const version = versionOf();
  /*
   * 这一版数据是哪天采的：模型文件只有一个采集日（`updatedAt`，精确到天），
   * 不像 GitHub 有整列 last_crawled_at，所以整版共用这一个值。
   * 没有就退回发布日 —— 至少版本号和「更新时间」列能对上，不会空着。
   */
  const dataAt = (file.updatedAt ?? version).slice(0, 10);

  /*
   * 跨天不原地 patch。
   *
   * 增量发布不推进版本号，数据日一变，旧版本槽里就装进了新一天的数据 ——
   * 后台会显示「版本 20261120（数据截止 11-20，发布于 11-19 09:20）」，
   * 看起来像时间算错了，其实是两份不同日期的数据被塞进同一个版本号；
   * 那一天的原始快照也就跟着没了。同一天内重发仍走增量，不会天天涨版本。
   */
  const curDataAt = await currentBoardDataAt("models");
  /* undefined = 读不到，别拦；null = 这版还没写 dataAt，也得落成新版本 */
  const dayChanged = curDataAt !== undefined && curDataAt !== dataAt;
  const patch = !process.argv.includes("--full") && !dayChanged;
  if (dayChanged) {
    console.log(
      curDataAt === null
        ? `[models] 当前版本没有数据日，新建版本写入 ${dataAt}`
        : `[models] 数据日从 ${curDataAt} 变成 ${dataAt}，改为完整发布（新建版本）`,
    );
  }

  const rows: PublishRow[] = ordered.map((model, i) => {
    const rank = i + 1;
    const value = valueMap.get(model.slug) ?? 0;
    const score = overallScore(model.capability, value);
    return {
      key: model.slug,
      rank,
      score,
      // 模型榜是公开榜，不分层
      tier: "core",
      name: model.name,
      url: null,
      cats: model.tags?.length ? model.tags : null,
      // 单条最大 1KB，卡片直接带全量字段，不必剔除
      card: { rank, score, value, ...model, dataAt },
      detail: { data: model, derived: { rank, score, value } },
    };
  });

  console.log(
    `[models] ${rows.length} 条，榜首 ${rows[0]?.name}（${rows[0]?.score}）` +
      `，榜单更新于 ${file.updatedAt ?? "未知"}`,
  );

  const res = await syncBoardToD1({
    board: "models",
    rows,
    actor: process.env.GITHUB_ACTOR ?? "manual",
    /*
     * 用当前时间，不用 file.updatedAt。
     *
     * updatedAt 是**采集脚本每次运行都会刷新**的字段，不是数据内容的时间，
     * 拿它当版本号等于每次都产生新版本 —— 和 versionOf() 没区别，
     * 反而多一处时区格式不一致的风险（文件里可能是本地时间）。
     * 版本就是「这一次快照」，总量由 pruneVersions 控制。
     */
    version,
    /*
     * 默认增量：只 UPSERT 变化的行，不新建版本。
     * 模型榜三百多条里日常刷新通常只动几条到几十条，整版要连其余五个榜一起重写，
     * 省下来的写库额度就是这里来的。要留一个可回滚的完整版本就加 --full。
     * 数据日变了的这一天例外（见上面的 dayChanged）：那天必须落成新版本。
     */
    patch,
    meta,
  });

  if (!res.ok && res.error !== "missing-credentials") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});