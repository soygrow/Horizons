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

async function main(): Promise<void> {
  if (!hasLLM()) {
    console.error("[llm] 未配置 DEEPSEEK_API_KEY，请在 .env.local 填写");
    process.exit(1);
  }
  const dry = process.argv.includes("--dry");
  const limit = parseLimit();
  const tools = loadTools();

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
