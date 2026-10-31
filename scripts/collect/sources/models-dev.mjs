/**
 * 采集源：models.dev 开放数据集（https://models.dev/api.json）
 *
 * 提供：原厂直营价格 / 上下文 / 输出上限 / 模态 / 是否开源 / 发布与知识截止 / 官方简介。
 * 定位：厂商覆盖扩容源（priority 10），补上 OpenRouter 未上架的国内厂商直营型号。
 *
 * 收录口径与 OpenRouter 源保持一致：只收付费、纯文本输出的对话模型，
 * 且只取 MODELS_DEV_PROVIDERS 白名单里的模型原厂（排除聚合站 / 云市场 / 订阅套餐）。
 */
import { resolve } from "node:path";
import { CACHE_DIR, makeRecord } from "../core.mjs";
import {
  cleanDescription,
  detectLicense,
  MODELS_DEV_PROVIDERS,
  parseBenchmarks,
} from "../model-rules.mjs";

const API = "https://models.dev/api.json";

/** 非对话类模型：向量 / 重排 / 审核 / 生成式媒体 */
const SKIP_ID = /(embed|rerank|moderation|guard|image|video|tts|whisper|transcribe|flux|stable-diffusion)/i;

/** 同一模型在两个原厂站重复出现时，保留信息更全 / 更新时间更晚的一条 */
function dedupe(list) {
  const best = new Map();
  for (const rec of list) {
    const prev = best.get(rec._key);
    if (!prev) {
      best.set(rec._key, rec);
      continue;
    }
    const a = (rec._updated ?? "") + (rec.desc ? 1 : 0);
    const b = (prev._updated ?? "") + (prev.desc ? 1 : 0);
    if (a > b) best.set(rec._key, rec);
  }
  return [...best.values()];
}

export default {
  id: "models-dev",
  label: "models.dev",
  url: API,
  priority: 10,

  async collect({ fetchJson, log, warn }) {
    const { data, cached, error } = await fetchJson({
      url: API,
      cacheFile: resolve(CACHE_DIR, "models-dev.json"),
      timeout: 40_000,
    });
    if (cached) warn("models-dev", `实时拉取失败（${error?.message}），使用本地缓存`);

    const providers = Object.keys(data ?? {});
    log("models-dev", `接口返回 ${providers.length} 个 Provider`);

    const out = [];
    let vendors = 0;

    for (const [key, display] of Object.entries(MODELS_DEV_PROVIDERS)) {
      const p = data?.[key];
      if (!p?.models) {
        warn("models-dev", `跳过未知 Provider：${key}`);
        continue;
      }
      vendors++;
      const doc = p.doc || "https://models.dev";

      for (const m of Object.values(p.models)) {
        if (m.status === "deprecated") continue;
        if (m.type && !["chat", "realtime"].includes(m.type)) continue;
        if (SKIP_ID.test(m.id) || SKIP_ID.test(m.name ?? "")) continue;

        const outs = m.modalities?.output ?? ["text"];
        if (!outs.includes("text") || outs.some((x) => x !== "text")) continue; // 音视频生成不进文本榜
        const ins = m.modalities?.input ?? ["text"];

        const cost = m.cost ?? {};
        const priceIn = Number(cost.input) > 0 ? Number(cost.input) : null;
        const priceOut = Number(cost.output) > 0 ? Number(cost.output) : null;
        if (priceIn === null && priceOut === null) continue; // 免费 / 未公开定价不入榜

        const open = Boolean(m.open_weights);
        const desc = cleanDescription(m.description);
        const license = detectLicense(m.description, open);
        const ctx = Number(m.limit?.context) || 0;
        const maxOutput = Number(m.limit?.output) || null;
        const reasoning = Boolean(m.reasoning);
        const modality = ins.some((x) => x !== "text") ? "multimodal" : "text";

        // 「(latest)」是别名后缀，去掉后可与 OpenRouter 同名条目合并且不出现重复行
        const name = String(m.name ?? m.id).replace(/\s*\(latest\)$/i, "").trim();

        const rec = makeRecord({
          source: "models-dev",
          idTail: m.id,
          name,
          provider: display,
          modality,
          context: ctx,
          maxOutput,
          price: {
            input: priceIn,
            output: priceOut,
            cachedInput: Number(cost.cache_read) > 0 ? Number(cost.cache_read) : null,
          },
          open,
          license,
          knowledgeCutoff: m.knowledge ?? null,
          releasedAt: m.release_date ?? null,
          desc,
          benchmarks: parseBenchmarks(m.description || ""),
          reasoning,
          matcher: `${m.id} ${m.family ?? ""}`.toLowerCase(),
          sources: [{ label: `${display} 官方定价`, url: doc }],
        });
        rec._updated = m.last_updated ?? "";
        out.push(rec);
      }
    }

    log("models-dev", `命中 ${vendors} 家原厂，候选 ${out.length} 个模型`);
    return dedupe(out);
  },
};