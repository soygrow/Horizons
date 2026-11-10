/**
 * AI 模型榜统一采集入口
 *
 * 一条命令跑完所有已注册的采集源，产出 content/models.json（唯一真源）。
 * 新增采集源只需在 sources/ 下加文件 + 在 SOURCES 里注册，其余逻辑自动复用。
 *
 * 用法：
 *   pnpm models:collect                    # 全量采集（默认所有源）
 *   pnpm models:collect --dry              # 只打印统计，不写文件
 *   pnpm models:collect --source=models-dev        # 只跑指定源
 *   pnpm models:collect --source=openrouter,models-dev
 *   pnpm models:collect --limit=100        # 按厂商轮转抽样
 *   pnpm models:collect --list             # 列出已注册的源
 *
 * 采集规则（对所有源一致）：
 *   付费文本模型 · 去重变体 / 日期快照 / 社区微调 · 同模型跨源合并 · 能力分按家族校准
 */
import { execSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  assignSlugs,
  buildOutput,
  dropForeignBrand,
  fetchJson,
  log,
  mergeRecords,
  OUT_PATH,
  ROOT,
  sampleByProvider,
  warn,
} from "./core.mjs";
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
  warn("collect", "所有采集源都失败，保留原有 content/models.json 不变");
  process.exit(1);
}

// ---------- 2. 跨源合并 + 去重 ----------
const { records: merged, stats } = mergeRecords(metas, buckets);

// ---------- 3. 排序、抽样、slug ----------
merged.sort((a, b) => b.capability - a.capability || (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
const picked = sampleByProvider(merged, LIMIT);
assignSlugs(picked);

const out = buildOutput({ records: picked, metas, stats });

// ---------- 4. 落盘 ----------
if (!DRY) {
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(out, null, 2)}\n`);

  // ---------- 4.5 同步 D1 ----------
  // 灰度期 D1 是冷备：写失败只告警，绝不能让一次同步故障丢掉采集结果
  try {
    execSync("pnpm tsx scripts/admin/publish-models.ts", {
      // 必须是仓库根：用 OUT_PATH 往上推容易多退一级，退到仓库外面去了，
      // 而这里的失败又只打一行告警，等于永远静默失败
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch (e) {
    warn("collect", `D1 同步失败（models），JSON 已落盘，站点不受影响：${e.message}`);
  }
}

// ---------- 5. 报告 ----------
const kb = (DRY ? Buffer.byteLength(JSON.stringify(out)) : statSync(OUT_PATH).size) / 1024;
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