import fs from "node:fs";
import path from "node:path";
import "./config"; // 副作用导入：触发 .env.local 加载
import { chatJSON, hasLLM } from "./sources/llm";

/**
 * 模型中文简介：把英文原版 desc 翻成中文，写入 descZh。
 * 原 desc 保留不动，页面优先用 descZh，英文原文仍可回溯。
 *
 * 判定依据是「desc 里有没有中文字符且还没有 descZh」，可重复执行增量补齐。
 *
 * 用法：pnpm run enrich:models:zh [--dry] [--limit N]
 */

const MODELS_PATH = path.resolve(process.cwd(), "content/models.json");
const ZH = /[\u4e00-\u9fa5]/;

const SYSTEM = `你是 AI 模型目录的中文编辑。用户给出若干模型名称与英文原版简介，请逐条翻译成中文：
- 不超过 50 字，说清这个模型是什么、侧重哪方面能力；
- 模型名、公司名、参数与技术缩写（如 MoE、FP8、128K、SOTA）保留原文，不硬译；
- 不写「该模型」「这是一款」这类冗余开头，直接说能力；
- 客观陈述，不使用「最强」「颠覆」「碾压」等宣传语。
只输出 JSON：{"items":[{"id":<原样返回的 id>,"zh":"<中文简介>"}]}，条数与输入一致，不要多余文本。`;

interface Model {
  name?: string;
  desc?: string;
  descZh?: string;
  [key: string]: unknown;
}

function load(): Model[] {
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8")) as Model[] | { models?: Model[] };
    return Array.isArray(raw) ? raw : (raw.models ?? []);
  } catch {
    return [];
  }
}

/** 保持原文件形状：数组就写数组，包了一层 models 就写回 models */
function save(models: Model[]): void {
  const raw = JSON.parse(fs.readFileSync(MODELS_PATH, "utf-8")) as Model[] | { models?: Model[] };
  const payload = Array.isArray(raw) ? models : { ...raw, models };
  fs.writeFileSync(MODELS_PATH, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function argLimit(): number {
  const i = process.argv.indexOf("--limit");
  if (i >= 0) {
    const n = parseInt(process.argv[i + 1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!hasLLM()) {
    console.error("[models-zh] 未配置 DEEPSEEK_API_KEY，请在 .env.local 填写");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const limit = argLimit();
  const models = load();

  let targets = models.filter((m) => m.desc && !ZH.test(m.desc) && !m.descZh);
  if (limit > 0) targets = targets.slice(0, limit);

  if (targets.length === 0) {
    console.log("[models-zh] 没有需要翻译的模型简介");
    return;
  }
  console.log(`[models-zh] 待翻译 ${targets.length} 条${dry ? "（dry-run）" : ""}`);

  const BATCH = 10;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const input = JSON.stringify(chunk.map((m, idx) => ({ id: idx, name: m.name, desc: m.desc })));

    try {
      const out = await chatJSON<{ items?: Array<{ id?: number; zh?: string }> }>(SYSTEM, input);
      for (const item of out.items ?? []) {
        const target = typeof item.id === "number" ? chunk[item.id] : undefined;
        const zh = item.zh?.trim();
        // 模型原样返回英文时不能当成翻译结果
        if (!target || !zh || !ZH.test(zh)) continue;
        target.descZh = zh.slice(0, 80);
        done++;
      }
    } catch (e) {
      failed += chunk.length;
      console.warn(
        `[models-zh] 批次 ${Math.floor(i / BATCH) + 1} 失败：`,
        e instanceof Error ? e.message.slice(0, 120) : e,
      );
    }

    if (!dry && done > 0) save(models);
    console.log(`[models-zh] 进度 ${Math.min(i + BATCH, targets.length)}/${targets.length}｜已译 ${done}`);
    await sleep(200);
  }

  if (!dry && done > 0) save(models);
  console.log(`[models-zh] 完成：成功 ${done}｜失败 ${failed}${dry ? "（dry-run 未写入）" : ""}`);
}

main().catch((e) => {
  console.error("[models-zh] 失败：", e);
  process.exit(1);
});