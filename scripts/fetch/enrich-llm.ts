import fs from "node:fs";
import path from "node:path";
import type { AITool, AIToolCategory } from "@horizons/shared";
import "./config"; // 副作用导入：触发 .env.local 加载
import { chatJSON, hasLLM } from "./sources/llm";

/**
 * LLM 增强管线：中文一句话描述 + 品类分类 + 细分赛道标签。
 * 已处理过（descriptionSource === "ai"）的工具自动跳过，可重复执行增量补齐。
 *
 * 用法：pnpm run enrich:llm [--dry] [--limit N]
 */

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");

const CATEGORIES: AIToolCategory[] = [
  "AI Chat",
  "Image Gen",
  "Video",
  "Voice & Audio",
  "Writing",
  "Coding",
  "Automation",
  "Marketing",
  "Productivity",
  "Data & Analytics",
  "Other",
];

const SYSTEM = `你是 AI 工具目录网站的资深编辑。根据用户提供的工具信息，输出 JSON 对象，字段：
- "descriptionZh": 不超过 40 字的中文一句话描述，说清这个工具是做什么的、给谁用；
- "categories": 从下列枚举中选 1-3 个最贴切的（按贴合度排序）：${CATEGORIES.join(", ")}；
- "segmentLabel": 6-12 字的细分赛道标签，如「AI 视频生成」「会议转写助手」。
只输出 JSON，不要多余文本。`;

/** 只翻译简介用的提示词：不动分类与赛道，避免机器重判覆盖已校准的品类 */
const SYSTEM_DESC = `你是 AI 工具目录的中文编辑。用户给出若干工具的名称与英文简介。
把每条英文简介翻译成中文，要求：
- 不超过 40 字，说清「做什么」和「给谁用」；
- 产品名 / 品牌名保持原文，不翻译；
- 不要「该工具」「这是一款」这类冗余开头，直接说功能；
- API、SaaS、LLM 等专业术语保留原文，不硬译；
- 语气客观，不夸大（不写「最强」「颠覆」）。
输出 JSON：{"items":[{"id":<原样返回的 id>,"zh":"<中文简介>"}]}，条数与输入一致，不要多余文本。`;

function loadTools(): AITool[] {
  try {
    return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  } catch {
    return [];
  }
}

function saveTools(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

function parseLimit(): number {
  const i = process.argv.indexOf("--limit");
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface LLMOut {
  descriptionZh?: string;
  categories?: string[];
  segmentLabel?: string;
}

/**
 * 批量把英文简介翻成中文。按 10 条一批请求，逐批落盘，中断后可续跑。
 * 判定依据是「描述里有没有中文字符」，而不是 descriptionSource，
 * 这样历史上被误标成 ai 却仍是英文的条目也能覆盖到。
 */
async function translateDescriptions(tools: AITool[], dry: boolean, limit: number): Promise<void> {
  const ZH = /[\u4e00-\u9fa5]/;
  let targets = tools.filter((t) => t.description && !ZH.test(t.description));
  if (limit > 0) targets = targets.slice(0, limit);

  if (targets.length === 0) {
    console.log("[llm] 没有需要翻译的英文简介");
    return;
  }
  console.log(`[llm] 待翻译 ${targets.length} 条${dry ? "（dry-run）" : ""}`);

  const BATCH = 10;
  let done = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i += BATCH) {
    const chunk = targets.slice(i, i + BATCH);
    const input = JSON.stringify(
      chunk.map((t, idx) => ({ id: idx, name: t.name, tagline: t.description })),
    );

    try {
      const out = await chatJSON<{ items?: Array<{ id?: number; zh?: string }> }>(
        SYSTEM_DESC,
        input,
      );
      for (const item of out.items ?? []) {
        const idx = item.id;
        const target = typeof idx === "number" ? chunk[idx] : undefined;
        const zh = item.zh?.trim();
        // 必须真的含中文，避免模型原样返回英文却被当成翻译结果
        if (!target || !zh || !ZH.test(zh)) continue;
        target.description = zh.slice(0, 60);
        target.descriptionSource = "ai";
        done++;
      }
    } catch (e) {
      failed += chunk.length;
      console.warn(
        `[llm] 批次 ${Math.floor(i / BATCH) + 1} 失败：`,
        e instanceof Error ? e.message.slice(0, 120) : e,
      );
    }

    if (!dry && done > 0) saveTools(tools);
    console.log(`[llm] 进度 ${Math.min(i + BATCH, targets.length)}/${targets.length}｜已译 ${done}`);
    await sleep(300);
  }

  if (!dry && done > 0) saveTools(tools);
  console.log(
    `[llm] 翻译完成：成功 ${done}｜失败 ${failed}${dry ? "（dry-run 未写入）" : ""}`,
  );
}

async function main(): Promise<void> {
  if (!hasLLM()) {
    console.error("[llm] 未配置 DEEPSEEK_API_KEY，请在 .env.local 填写");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const limit = parseLimit();
  const tools = loadTools();

  // --desc-only：只把英文简介翻译成中文，不重判分类 / 赛道
  if (process.argv.includes("--desc-only")) {
    await translateDescriptions(tools, dry, limit);
    return;
  }

  let processed = 0;
  let updated = 0;

  for (const tool of tools) {
    if (limit > 0 && processed >= limit) break;
    if (tool.descriptionSource === "ai") continue; // 已处理，增量跳过
    processed++;

    const input = JSON.stringify({
      name: tool.name,
      tagline: tool.description,
      topics: tool.topicSlugs ?? [],
      domain: tool.domain,
    });

    try {
      const out = await chatJSON<LLMOut>(SYSTEM, input);
      const cats = (out.categories ?? []).filter((c): c is AIToolCategory =>
        (CATEGORIES as string[]).includes(c),
      );
      if (out.descriptionZh) {
        tool.description = out.descriptionZh;
        tool.descriptionSource = "ai";
      }
      if (cats.length > 0) tool.categories = cats;
      if (out.segmentLabel) tool.segmentLabel = out.segmentLabel;
      tool.collectedAt = new Date().toISOString();
      updated++;
      console.log(`[llm] ${tool.name}：${tool.description}｜${tool.categories.join("/")}`);
    } catch (e) {
      console.warn(
        `[llm] ${tool.name} 失败：`,
        e instanceof Error ? e.message : e,
      );
    }
    await sleep(200);
  }

  if (!dry && updated > 0) saveTools(tools);
  console.log(
    `[llm] 完成：处理 ${processed} 个，更新 ${updated} 个${dry ? "（dry-run 未写入）" : ""}`,
  );
}

main().catch((e) => {
  console.error("[llm] 失败：", e);
  process.exit(1);
});
