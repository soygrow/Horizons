/**
 * 采集框架核心：源契约 / 抓取缓存 / 记录归一化 / 跨源合并 / 抽样落盘
 *
 * 设计原则（新增采集源时不用碰这里）：
 *   1. 每个源只负责「取数 + 映射到统一 schema」，去重、合并、排序、抽样、落盘全部在这里做
 *   2. 记录统一经 makeRecord() 补默认值与派生字段（tags / params / capability）
 *   3. 跨源同模型合并按源的 priority 决胜负：数字小的字段更权威，缺失字段由后者补齐
 *
 * 新增一个源：
 *   ① 在 scripts/collect/sources/ 下新建 <id>.mjs，默认导出 Source（契约见下）
 *   ② 在 scripts/collect/index.mjs 的 SOURCES 里注册
 *   ③ node scripts/collect/index.mjs --source=<id> --dry 单独验证，再全量跑
 *
 * @typedef {Object} Source
 * @property {string} id        唯一标识，同时用于 --source= 过滤与日志前缀
 * @property {string} label     展示名，写入 content/models.json 的 sources
 * @property {string} url       数据接口地址，写入产物便于核对
 * @property {number} priority  冲突优先级，越小越权威（0 = 定价/官方字段基准源）
 * @property {(ctx: {fetchJson: Function, log: Function, warn: Function}) => Promise<object[]>} collect
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brandOwnerOf, buildCopy, estimateCapability, paramsOf, slugify } from "./model-rules.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * 当前线上榜单的构建缓存 —— 定向刷新读它当基线。
 *
 * 它不入库，由 `hydrate-models.ts` 从 D1 还原；采集结果写 `CACHE_DIR/models-pending.json`，
 * 再由 publish-models 直接进库。仓库里没有第二份真源。
 */
export const OUT_PATH = resolve(ROOT, "content/models.json");
export const CACHE_DIR = resolve(ROOT, "content/cache");

export const log = (ns, msg) => console.log(`[${ns}] ${msg}`);
export const warn = (ns, msg) => console.warn(`[${ns}] ${msg}`);

/**
 * 拉取 JSON 并写缓存；网络失败时回退本地缓存（缓存为上一次成功快照）。
 * @returns {Promise<{data: any, cached: boolean, error?: Error}>}
 */
export async function fetchJson({ url, cacheFile, timeout = 30_000, headers = {} }) {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "horizons-collector", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (cacheFile) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(data));
    }
    return { data, cached: false };
  } catch (err) {
    if (cacheFile) {
      try {
        return { data: JSON.parse(readFileSync(cacheFile, "utf8")), cached: true, error: err };
      } catch {
        /* 无缓存，继续抛错 */
      }
    }
    throw err;
  }
}

/** 日期归一：2024-12 / 2024 / 2024-12-01T… → YYYY-MM-DD */
export function normalizeDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-01`;
  m = /^(\d{4})$/.exec(s);
  if (m) return `${m[1]}-01-01`;
  return null;
}

/** 去补丁版本后缀，用于源内快照去重：Claude Sonnet 4.5 (20250929) → Claude Sonnet 4.5 */
export function baseNameOf(name = "") {
  return String(name)
    .replace(/\s*\((?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{8}|older[^)]*|v\d[^)]*)\)$/i, "")
    .replace(/\s+\d{4}-\d{2}-\d{2}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 跨源同名判定键：厂商 + 去掉分隔符与大小写的模型名。
 * 各家写法不统一（GLM-4.6 / GLM 4.6、GPT-5.3-Codex / GPT-5.3 Codex），
 * 只保留字母数字后即可视为同一模型；带括号的变体（Reasoning / Non-Reasoning）仍能区分。
 */
export function keyOf(provider, name) {
  return `${provider}|${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "")}`;
}

/**
 * 统一记录构造：源只提供事实字段，派生字段（tags / params / capability）在这里算，
 * 保证所有源出来的行长得一样。
 */
export function makeRecord(input) {
  const {
    source,
    idTail,
    name,
    provider,
    modality = "text",
    context = null,
    maxOutput = null,
    price = {},
    open = false,
    license = "Proprietary",
    knowledgeCutoff = null,
    releasedAt = null,
    desc = null,
    strengths = [],
    weaknesses = [],
    useCases = [],
    benchmarks = [],
    sources = [],
    freeTier = null,
    reasoning = false,
    capability,
    matcher,
  } = input;

  if (!name || !provider) throw new Error(`记录缺少 name/provider：${JSON.stringify({ name, provider })}`);

  const priceIn = Number.isFinite(price.input) ? price.input : null;
  const priceOut = Number.isFinite(price.output) ? price.output : null;
  const cachedInput = Number.isFinite(price.cachedInput) && price.cachedInput > 0 ? price.cachedInput : null;
  const ctx = Number(context) || 0;

  const score = Number.isFinite(capability)
    ? capability
    : estimateCapability(matcher ?? `${idTail ?? ""} ${name}`.toLowerCase(), ctx, reasoning);

  const copy = buildCopy({ reasoningFlag: reasoning, context: ctx, priceIn, maxOutput, open, modality, license });

  return {
    // 身份字段
    name: String(name).replace(/\s+/g, " ").trim(),
    provider,
    // 派生
    slug: "",
    modality,
    tags: [
      reasoning ? "推理" : null,
      modality === "multimodal" ? "多模态" : null,
      open ? "开源" : null,
      priceIn !== null && priceIn <= 0.5 ? "高性价比" : null,
      ctx >= 200_000 ? "长上下文" : null,
    ].filter(Boolean),
    open: Boolean(open),
    license,
    context: ctx || null,
    maxOutput: maxOutput || null,
    params: paramsOf(name),
    price: { input: priceIn, output: priceOut, cachedInput },
    freeTier,
    capability: score,
    knowledgeCutoff: knowledgeCutoff ?? null,
    releasedAt: normalizeDate(releasedAt),
    desc,
    // 优势 / 短板 / 适用场景：源未显式给出时按统一规则派生，保证各源文案同构
    strengths: strengths.length || weaknesses.length || useCases.length ? strengths : copy.strengths,
    weaknesses: strengths.length || weaknesses.length || useCases.length ? weaknesses : copy.weaknesses,
    useCases: strengths.length || weaknesses.length || useCases.length ? useCases : copy.useCases,
    benchmarks,
    sources,
    // 内部字段（落盘前统一剥离）
    _src: source,
    _idTail: idTail ?? name,
    _reasoning: Boolean(reasoning),
    _key: keyOf(provider, name),
  };
}

/** 把后一个源的记录补进主记录：主字段不动，空字段与来源链接补齐 */
function absorb(target, incoming) {
  const fill = (key) => {
    const t = target[key];
    if (t === null || t === undefined || t === "") target[key] = incoming[key];
  };
  for (const key of ["context", "maxOutput", "params", "knowledgeCutoff", "releasedAt", "desc", "freeTier"]) fill(key);
  for (const key of ["input", "output", "cachedInput"]) {
    if (target.price[key] === null || target.price[key] === undefined) target.price[key] = incoming.price[key];
  }
  target.modality = target.modality === "text" ? incoming.modality : target.modality;
  target.open = target.open || incoming.open;
  if (target.license === "Proprietary" && incoming.license !== "Proprietary") target.license = incoming.license;
  if ((target.benchmarks?.length ?? 0) === 0 && incoming.benchmarks?.length) target.benchmarks = incoming.benchmarks;
  if ((target.strengths?.length ?? 0) === 0 && incoming.strengths?.length) target.strengths = incoming.strengths;
  if ((target.weaknesses?.length ?? 0) === 0 && incoming.weaknesses?.length) target.weaknesses = incoming.weaknesses;
  if ((target.useCases?.length ?? 0) === 0 && incoming.useCases?.length) target.useCases = incoming.useCases;
  target.capability = Math.max(target.capability, incoming.capability);
  target.tags = [...new Set([...target.tags, ...incoming.tags])];
  const seen = new Set(target.sources.map((s) => s.url));
  for (const s of incoming.sources) {
    if (!seen.has(s.url)) {
      target.sources.push(s);
      seen.add(s.url);
    }
  }
}

/**
 * 跨源合并 + 同源去重
 * @param {Array<{id:string, label:string, priority:number}>} metas 按 priority 升序
 * @param {Record<string, object[]>} buckets 源 id → 记录
 */
export function mergeRecords(metas, buckets) {
  const merged = new Map();
  const stats = new Map(metas.map((m) => [m.id, { raw: 0, used: 0, added: 0, skipped: 0 }]));

  for (const meta of [...metas].sort((a, b) => a.priority - b.priority)) {
    const list = buckets[meta.id] ?? [];
    const st = stats.get(meta.id);
    st.raw = list.length;
    for (const rec of list) {
      const hit = merged.get(rec._key);
      if (!hit) {
        rec._mergedFrom = [meta.id];
        merged.set(rec._key, rec);
        st.added++;
        continue;
      }
      // 同名同厂 → 视为同一模型，让主源保留定价，副源补字段
      absorb(hit, rec);
      hit._mergedFrom.push(meta.id);
      st.skipped++;
    }
  }
  for (const st of stats.values()) st.used = st.raw - st.skipped;
  return { records: [...merged.values()], stats };
}

/**
 * 丢弃「挂羊头卖狗肉」的条目：模型名品牌与 Provider 不一致说明是分发方镜像，
 * 交由原厂自己的源收录，避免同一模型在多家厂商名下重复出现。
 */
export function dropForeignBrand(records) {
  const kept = [];
  const dropped = [];
  for (const r of records) {
    const owner = brandOwnerOf(r.name);
    if (owner && owner !== r.provider) {
      dropped.push(`${r.provider}/${r.name}`);
      continue;
    }
    kept.push(r);
  }
  return { records: kept, dropped };
}

/** slug 分配：优先用模型 id 尾段，冲突时加厂商前缀 */
export function assignSlugs(records) {
  const used = new Set();
  for (const r of records) {
    let slug = slugify(r._idTail) || slugify(r.name);
    if (used.has(slug)) slug = slugify(`${r.provider}-${r._idTail || r.name}`);
    let i = 2;
    const base = slug;
    while (used.has(slug)) slug = `${base}-${i++}`;
    used.add(slug);
    r.slug = slug;
  }
  return records;
}

/** 按厂商轮转抽样：先每厂商保底 2 个，再全局补足，单厂商上限 8 个 */
export function sampleByProvider(models, limit) {
  if (!limit || limit <= 0) return [...models];
  const pools = new Map();
  for (const m of models) {
    if (!pools.has(m.provider)) pools.set(m.provider, []);
    pools.get(m.provider).push(m);
  }
  const queues = [...pools.entries()]
    .map(([, list]) => ({ list }))
    .sort((a, b) => b.list[0].capability - a.list[0].capability);

  const picked = [];
  const counts = new Map();
  const take = (m) => {
    picked.push(m);
    counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  };

  for (let round = 0; round < 2; round++) {
    for (const q of queues) {
      if (picked.length >= limit) break;
      if (round < q.list.length) take(q.list[round]);
    }
  }
  for (const m of models) {
    if (picked.length >= limit) break;
    if (picked.includes(m)) continue;
    if ((counts.get(m.provider) ?? 0) >= 8) continue;
    take(m);
  }
  return picked;
}

/** 剥离内部字段并按稳定字段顺序输出 */
export function toOutputRecords(records) {
  const ORDER = [
    "slug", "name", "provider", "modality", "tags", "open", "license", "context", "maxOutput",
    "params", "price", "freeTier", "capability", "knowledgeCutoff", "releasedAt", "desc",
    "strengths", "weaknesses", "useCases", "benchmarks", "sources",
  ];
  return records.map((r) => {
    const out = {};
    for (const key of ORDER) out[key] = r[key];
    return out;
  });
}

/** 组装 content/models.json */
export function buildOutput({ records, metas, stats }) {
  return {
    mode: "live",
    updatedAt: new Date().toISOString().slice(0, 10),
    source: metas.map((m) => m.label).join(" · "),
    sources: metas.map((m) => ({
      id: m.id,
      label: m.label,
      url: m.url,
      priority: m.priority,
      models: stats.get(m.id)?.raw ?? 0,
      contributed: stats.get(m.id)?.added ?? 0,
    })),
    note:
      "价格为每 1M tokens 的美元挂牌价；同一模型同时出现在多个源时，以优先级高的源（OpenRouter）定价为准，缺失字段由其他源补齐。" +
      "纯免费与未公开定价的模型不入榜；缓存价与批量折扣不计入主表。",
    capabilityNote:
      "能力分为「公开基准 + 模型家族校准」的估算值（0–100），用于同榜横向比较；接入基准评测后应替换。",
    models: toOutputRecords(records),
  };
}