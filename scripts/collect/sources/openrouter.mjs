/**
 * 采集源：OpenRouter 公开模型接口
 *
 * 提供：价格 / 上下文 / 模态 / 最大输出 / 发布时间 / 知识截止 / 官方简介原文。
 * 定位：定价基准源（priority 0），同模型冲突时以它的挂牌价为准。
 *
 * 收录口径：全部付费文本模型，去重变体（:free / :thinking / :online 等）、
 * 社区微调与路由占位模型不入榜。
 */
import { cleanDescription, detectLicense, detectOpen, parseBenchmarks, PROVIDERS, PRICING_URL, round } from "../model-rules.mjs";
import { baseNameOf, CACHE_DIR, makeRecord } from "../core.mjs";
import { resolve } from "node:path";

const API = "https://openrouter.ai/api/v1/models";

/** 社区微调 / 路由工具类厂商：与选型决策无关 */
const SKIP_VENDORS =
  /^(sao10k|undi95|gryphe|mancer|thedrummer|anthracite-org|elorian|xingchen-agi|dots-studio|recursive|typesafe|unbiased|scaledown|perceptron|prism-ml|neversleep|open-r1)\//;

/** 同一模型的历史快照：保留无后缀别名，否则保留最新 */
function dedupeSnapshots(records) {
  const best = new Map();
  for (const m of records) {
    const key = m._key;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, m);
      continue;
    }
    const mExact = m.name === m._baseName;
    const pExact = prev.name === prev._baseName;
    if (mExact !== pExact) {
      if (mExact) best.set(key, m);
      continue;
    }
    if ((m._created ?? 0) > (prev._created ?? 0)) best.set(key, m);
  }
  return [...best.values()];
}

export default {
  id: "openrouter",
  label: "OpenRouter",
  url: API,
  priority: 0,

  async collect({ fetchJson, log, warn }) {
    const { data, cached, error } = await fetchJson({
      url: API,
      cacheFile: resolve(CACHE_DIR, "openrouter-models.json"),
    });
    if (cached) warn("openrouter", `实时拉取失败（${error?.message}），使用本地缓存`);

    const raw = Array.isArray(data?.data) ? data.data : [];
    log("openrouter", `接口返回 ${raw.length} 个模型`);

    const out = [];
    const seenBase = new Set();

    for (const m of raw) {
      const now = Date.now();
      if (m.expiration_date && Date.parse(m.expiration_date) < now) continue;
      if (/^[~]|^openrouter\//.test(m.id)) continue; // 匿名 / 路由占位模型
      if (/:(batch|extended|nitro|online|thinking|free)$/i.test(m.id)) continue; // 同模型变体去重
      if (SKIP_VENDORS.test(m.id)) continue;

      const arch = m.architecture ?? {};
      const outs = arch.output_modalities ?? ["text"];
      if (!outs.includes("text")) continue; // 只收文本输出
      if (outs.some((x) => x !== "text")) continue; // 图像 / 音频生成模型不进文本榜
      if (/(guard|moderation|safety|rerank|embed)/i.test(m.id)) continue; // 审核 / 向量类
      if (/contributor/i.test(m.name) || /latest$/i.test(m.name)) continue; // 别名与实验变体

      const pIn = Math.max(0, Number(m.pricing?.prompt ?? 0) || 0);
      const pOut = Math.max(0, Number(m.pricing?.completion ?? 0) || 0);
      if (!pIn && !pOut) continue; // 纯免费 / 未知定价不入榜
      const priceIn = pIn ? round(pIn * 1e6) : null;
      const priceOut = pOut ? round(pOut * 1e6) : null;
      const cachedPrice = Math.max(0, Number(m.pricing?.input_cache_read ?? 0) || 0);

      const baseId = m.id.replace(/:(free|extended|thinking|nitro|online)$/i, "");
      if (seenBase.has(baseId)) continue;
      seenBase.add(baseId);

      const [vendor, ...rest] = m.id.split("/");
      const modelPart = rest.join("/") || m.id;
      const provider =
        PROVIDERS[vendor] ?? vendor.replace(/(^|-)(\w)/g, (_, a, b) => `${a ? " " : ""}${b.toUpperCase()}`);

      const rawName = String(m.name ?? modelPart);
      const stripped = rawName.includes(": ") ? rawName.split(": ").slice(1).join(": ") : rawName;
      const name = stripped.replace(/\s+/g, " ").trim();

      const ctx = Number(m.context_length) || 0;
      const maxOutput = Number(m.top_provider?.max_completion_tokens) || null;
      const reasoning = Boolean(m.reasoning) || (m.supported_parameters ?? []).includes("reasoning");
      const hasFree = raw.some((x) => x.id === `${baseId}:free`);

      const inputMods = arch.input_modalities ?? ["text"];
      const modality = outs.includes("image")
        ? "image"
        : outs.includes("audio")
          ? "audio"
          : inputMods.some((x) => x !== "text")
            ? "multimodal"
            : "text";

      const open = detectOpen(m.id, m.hugging_face_id, m.description);
      const license = detectLicense(m.description, open);

      const rec = makeRecord({
        source: "openrouter",
        idTail: modelPart,
        name,
        provider,
        modality,
        context: ctx,
        maxOutput,
        price: { input: priceIn, output: priceOut, cachedInput: cachedPrice ? round(cachedPrice * 1e6) : null },
        open,
        license,
        knowledgeCutoff: m.knowledge_cutoff ?? null,
        releasedAt: Number(m.created) ? new Date(Number(m.created) * 1000).toISOString().slice(0, 10) : null,
        desc: cleanDescription(m.description),
        benchmarks: parseBenchmarks(m.description || ""),
        freeTier: hasFree ? "提供免费变体（限速）" : null,
        reasoning,
        matcher: m.id.toLowerCase(),
        sources: [
          { label: "OpenRouter 模型页", url: `https://openrouter.ai/${m.id}` },
          ...(PRICING_URL[provider] ? [{ label: `${provider} 定价`, url: PRICING_URL[provider] }] : []),
        ],
      });
      rec._baseName = baseNameOf(name);
      rec._created = Number(m.created) || 0;
      out.push(rec);
    }

    return dedupeSnapshots(out);
  },
};