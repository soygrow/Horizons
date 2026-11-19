/**
 * AI 模型榜统一采集入口
 *
 * 一条命令跑完所有已注册的采集源，结果直接写进 D1（唯一真源）。
 * 新增采集源只需在 sources/ 下加文件 + 在 SOURCES 里注册，其余逻辑自动复用。
 *
 * 写库口径：采集产物先落到 content/cache/models-pending.json（不入库），
 * 再交给 publish-models 写 D1。仓库里没有 content/models.json —— 那是构建缓存，
 * 由 hydrate-models 从库还原。所以本地想让页面看到新数据，采集后要重新构建。
 *
 * 用法：
 *   pnpm models:collect                    # 全量采集（默认所有源）
 *   pnpm models:collect --dry              # 只打印统计，不写库
 *   pnpm models:collect --source=models-dev        # 只跑指定源
 *   pnpm models:collect --source=openrouter,models-dev
 *   pnpm models:collect --limit=100        # 按厂商轮转抽样
 *   pnpm models:collect --list             # 列出已注册的源
 *   pnpm models:collect --models=a,b,c     # 定向刷新：只更新这几个 slug，其余原样保留
 *
 * 定向刷新是后台「线上榜单 → 更新选中」用的：基线取 content/models.json
 * （= 当前线上榜单的 hydrate 产物），源接口本来就只返回全量，所以只是把拉回来的
 * 数据按 slug 覆盖回去，条数、slug、人工中文文案都不动。
 *
 * 采集规则（对所有源一致）：
 *   付费文本模型 · 去重变体 / 日期快照 / 社区微调 · 同模型跨源合并 · 能力分按家族校准
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assignSlugs,
  buildOutput,
  dropForeignBrand,
  fetchJson,
  keyOf,
  log,
  mergeRecords,
  OUT_PATH,
  ROOT,
  sampleByProvider,
  warn,
} from "./core.mjs";

/** 采集产物：入库前的临时落点，.gitignore 已忽略 content/cache/ */
const PENDING_PATH = resolve(ROOT, "content/cache/models-pending.json");
import modelsDev from "./sources/models-dev.mjs";
import openrouter from "./sources/openrouter.mjs";

/** 注册表：priority 越小越权威（同模型冲突时定价以它为准） */
const SOURCES = [openrouter, modelsDev];

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];

if (flag("list")) {
  warn("collect", "已注册采集源：");
  for (const s of SOURCES) {
    log("collect", `  ${s.id.padEnd(12)} priority=${s.priority}  ${s.label.padEnd(12)} ${s.url}`);
  }
  process.exit(0);
}

const DRY = flag("dry");
const LIMIT = Number(value("limit") || 0);
const wanted = (value("source") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/** 定向刷新的 slug 列表；空数组表示全量采集 */
const TARGETS = (value("models") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sources = wanted.length ? SOURCES.filter((s) => wanted.includes(s.id)) : SOURCES;
if (!sources.length) {
  warn("collect", `没有匹配的采集源：${wanted.join(",")}，用 --list 查看`);
  process.exit(1);
}

// ---------- 1. 各源独立采集（单源失败不影响其他源） ----------
const buckets = {};
const metas = [];
for (const source of sources) {
  try {
    const started = Date.now();
    const collected = await source.collect({ fetchJson, log, warn });
    // 统一规则：品牌归属与 Provider 不符的镜像条目一律丢弃
    const { records, dropped } = dropForeignBrand(collected);
    buckets[source.id] = records;
    metas.push({ id: source.id, label: source.label, url: source.url, priority: source.priority });
    log(
      source.id,
      `候选 ${records.length} 个${dropped.length ? `（剔除他人模型 ${dropped.length}）` : ""}，耗时 ${Date.now() - started}ms`,
    );
  } catch (err) {
    warn(source.id, `采集失败，跳过：${err.message}`);
  }
}
if (!metas.length) {
  warn("collect", "所有采集源都失败，线上榜单保持不变");
  process.exit(1);
}

// ---------- 2. 跨源合并 + 去重 ----------
const { records: merged, stats } = mergeRecords(metas, buckets);

/**
 * 落盘 + 同步 D1。
 *
 * 默认增量（只写变化行）；加 --full 才建完整版本（可回滚）——
 * 与其它榜同一个口径：改几个条目不该付出重写全榜的代价。
 */
function writeAndSync(out, { patch }) {
  mkdirSync(dirname(PENDING_PATH), { recursive: true });
  writeFileSync(PENDING_PATH, `${JSON.stringify(out, null, 2)}\n`);

  /*
   * 模型榜只写库：产物不进仓库，所以「写盘成功、写库失败」= 这次采集白跑。
   * 仍然只告警不抛错，让采集源自己的报告能完整打完，但文案要说清后果。
   */
  try {
    execSync(
      `pnpm tsx scripts/admin/publish-models.ts --input "${PENDING_PATH}"${patch ? "" : " --full"}`,
      {
        // 必须是仓库根：用 OUT_PATH 往上推容易多退一级，退到仓库外面去了，
        // 而这里的失败又只打一行告警，等于永远静默失败
        cwd: ROOT,
        stdio: "inherit",
      },
    );
  } catch (e) {
    warn(
      "collect",
      `D1 写入失败（models）：这次采集结果没进库，线上与站点仍是上一版。${e.message}`,
    );
  }
}

/*
 * ---------- 3a. 定向刷新：只覆盖选中的模型，其余一个字段都不动 ----------
 *
 * 源接口本来就只返回全量，所以先把全量拉回来，再按 slug 回填。三条底线：
 *   1. 条数不变 —— 选中的模型在源里查不到时保留旧数据，只记一条 warn；
 *   2. slug 不变 —— 不重跑 assignSlugs，否则名次与站内链接会整体换掉；
 *   3. 人工产物不覆盖 —— descZh / strengths / useCases 是翻译与人工补的，
 *      只覆盖采集得到的客观字段。
 */
const OVERRIDE_KEYS = [
  "name",
  "provider",
  "modality",
  "tags",
  "open",
  "license",
  "context",
  "maxOutput",
  "params",
  "price",
  "freeTier",
  "capability",
  "knowledgeCutoff",
  "releasedAt",
  "desc",
];

if (TARGETS.length > 0) {
  let prev;
  try {
    prev = JSON.parse(readFileSync(OUT_PATH, "utf-8"));
  } catch {
    warn(
      "collect",
      "没有 content/models.json（当前线上榜单的构建缓存），定向刷新无从覆盖；先跑 pnpm hydrate:models",
    );
    process.exit(1);
  }

  const bySlug = new Map((prev.models ?? []).map((m) => [m.slug, m]));
  const fresh = new Map(merged.map((r) => [keyOf(r.provider, r.name), r]));

  const changed = [];
  const missing = [];
  const unknown = [];

  for (const slug of new Set(TARGETS)) {
    const old = bySlug.get(slug);
    if (!old) {
      unknown.push(slug);
      continue;
    }
    const rec = fresh.get(keyOf(old.provider, old.name));
    if (!rec) {
      missing.push(slug);
      continue;
    }
    const next = { ...old };
    for (const key of OVERRIDE_KEYS) {
      if (rec[key] !== undefined) next[key] = rec[key];
    }
    if (JSON.stringify(next) !== JSON.stringify(old)) changed.push(slug);
    bySlug.set(slug, next);
  }

  const models = [...bySlug.values()].sort(
    (a, b) => b.capability - a.capability || (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""),
  );
  const outTarget = { ...prev, mode: "live", updatedAt: new Date().toISOString().slice(0, 10), models };

  log(
    "collect",
    `定向刷新 ${new Set(TARGETS).size} 个：有变化 ${changed.length} 个` +
      (changed.length ? `（${changed.slice(0, 8).join(", ")}${changed.length > 8 ? " …" : ""}）` : ""),
  );
  if (missing.length) warn("collect", `源里已查不到，保留旧数据：${missing.join(", ")}`);
  if (unknown.length) warn("collect", `不在当前榜单里，已忽略：${unknown.join(", ")}`);

  if (DRY) log("collect", "（dry，未写盘）");
  else writeAndSync(outTarget, { patch: true });

  process.exit(0);
}

// ---------- 3. 排序、抽样、slug ----------
merged.sort((a, b) => b.capability - a.capability || (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
const picked = sampleByProvider(merged, LIMIT);
assignSlugs(picked);

const out = buildOutput({ records: picked, metas, stats });

// ---------- 4. 落盘 ----------
if (!DRY) writeAndSync(out, { patch: !process.argv.includes("--full") });

// ---------- 5. 报告 ----------
const kb = (DRY ? Buffer.byteLength(JSON.stringify(out)) : statSync(PENDING_PATH).size) / 1024;
const byProvider = {};
for (const m of out.models) byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1;
const prices = out.models.map((m) => m.price.input).filter((x) => typeof x === "number");
const withDesc = out.models.filter((m) => m.desc).length;

for (const meta of metas) {
  const st = stats.get(meta.id);
  log(meta.id, `入选 ${st.used} · 与高优先级源合并 ${st.skipped}`);
}
log(
  "collect",
  `合计 ${out.models.length} 个 · 厂商 ${Object.keys(byProvider).length} · 开源 ${out.models.filter((m) => m.open).length} · 有官方简介 ${withDesc} · ${kb.toFixed(0)}KB${DRY ? "（dry，未写盘）" : ""}`,
);
if (prices.length) {
  log("collect", `输入价范围 $${Math.min(...prices)}–$${Math.max(...prices)} /1M`);
}
log(
  "collect",
  "Top5：" + out.models.slice(0, 5).map((m) => `${m.name}(${m.capability})`).join(" / "),
);
log(
  "collect",
  "厂商分布：" +
    Object.entries(byProvider)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 18)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · "),
);