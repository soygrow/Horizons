import { config } from "./config";
import { fetchProductHuntTools, closePHBrowser } from "./sources/productHunt";
import { loadExisting } from "./dedupe";
import { appendTools } from "./output";
import type { AITool } from "@horizons/shared";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(): number {
  const [min, max] = config.requestDelayMs;
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function fetchWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < config.maxRetries) {
        const wait = Math.min(1000 * 2 ** attempt, 8000);
        console.warn(`[fetch] 第 ${attempt + 1} 次重试，等待 ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry");
  const mode = dryRun ? "（dry-run，不写入）" : "";
  console.log(`[fetch] 开始抓取 AI 工具，每次最多 ${config.maxPerRun} 个${mode}`);

  const existing = loadExisting();
  const seen = new Set(existing.map((t) => t.domain));
  const fresh: AITool[] = [];
  const order = process.argv.includes("--new")
    ? ("NEWEST" as const)
    : ("VOTES" as const);
  // 单个 topic 挖尽后（新增骤降）用 --topic 切换到其他话题继续扩充候选
  const topicIdx = process.argv.indexOf("--topic");
  const topic = topicIdx >= 0 && process.argv[topicIdx + 1] ? process.argv[topicIdx + 1] : "artificial-intelligence";
  const existingNames = new Set(existing.map((t) => t.name.toLowerCase()));

  function absorb(label: string, items: AITool[]): void {
    let added = 0;
    for (const t of items) {
      if (fresh.length >= config.maxPerRun) break;
      if (seen.has(t.domain)) continue;
      seen.add(t.domain);
      fresh.push(t);
      added++;
    }
    console.log(`[fetch] ${label}：抓到 ${items.length} 个，新增 ${added} 个`);
  }

  try {
    // Product Hunt 优先（AI 工具榜主力 = 真实产品网站）
    if (fresh.length < config.maxPerRun) {
      await sleep(randomDelay());
      try {
        const items = await fetchWithRetry(() =>
          fetchProductHuntTools(
            config.maxPerRun + existing.length,
            order,
            topic,
            existingNames,
          ),
        );
        absorb("Product Hunt", items);
      } catch (e) {
        console.error(
          "[fetch] Product Hunt 失败：",
          e instanceof Error ? e.message : e,
        );
      }
    }

  } finally {
    await closePHBrowser();
  }

  if (fresh.length === 0) {
    console.log("[fetch] 无新增工具，结束");
    return;
  }

  if (dryRun) {
    console.log("[fetch] dry-run，以下为将写入的数据（未写入）：");
    console.log(JSON.stringify(fresh, null, 2));
  } else {
    appendTools(fresh);
    console.log(`[fetch] 已写入 content/aitools.json，新增 ${fresh.length} 个工具`);
  }
}

main().catch((e) => {
  console.error("[fetch] 抓取失败：", e);
  process.exit(1);
});
