import { config } from "./config";
import { fetchGithubTools } from "./sources/github";
import { fetchProductHuntTools } from "./sources/productHunt";
import { loadExisting } from "./dedupe";
import { appendTools } from "./output";
import type { AITool } from "../../src/lib/types";

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

  // 先加载已有数据，逐源渐进去重，避免重复项占满配额导致后面的源被跳过
  const existing = loadExisting();
  const seen = new Set(existing.map((t) => t.domain));
  const fresh: AITool[] = [];

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

  // GitHub（免费匿名）
  if (fresh.length < config.maxPerRun) {
    await sleep(randomDelay());
    try {
      const items = await fetchWithRetry(() =>
        fetchGithubTools(config.maxPerRun - fresh.length),
      );
      absorb("GitHub", items);
    } catch (e) {
      console.error(
        "[fetch] GitHub 失败：",
        e instanceof Error ? e.message : e,
      );
    }
  }

  // Product Hunt（需 PH_TOKEN，未配置则跳过）
  if (fresh.length < config.maxPerRun) {
    await sleep(randomDelay());
    try {
      const items = await fetchWithRetry(() =>
        fetchProductHuntTools(config.maxPerRun - fresh.length),
      );
      absorb("Product Hunt", items);
    } catch (e) {
      console.error(
        "[fetch] Product Hunt 失败：",
        e instanceof Error ? e.message : e,
      );
    }
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
