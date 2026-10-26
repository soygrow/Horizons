import fs from "node:fs";
import path from "node:path";

// tsx 不会自动加载 .env.local，这里手动解析（仅本地脚本使用，不进前端）
function loadEnvLocal(): void {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    const content = fs.readFileSync(p, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // .env.local 不存在则忽略
  }
}
loadEnvLocal();

export interface FetchConfig {
  /** 每次运行最多抓取条数 */
  maxPerRun: number;
  /** 请求之间随机延迟范围（毫秒） */
  requestDelayMs: [number, number];
  /** 失败重试次数（指数退避） */
  maxRetries: number;
  /** 合规声明 User-Agent */
  userAgent: string;
  github: {
    queries: string[];
    minStars: number;
  };
  productHunt: {
    topicSlugs: string[];
  };
}

export const config: FetchConfig = {
  maxPerRun: 60,
  requestDelayMs: [2000, 5000],
  maxRetries: 2,
  userAgent:
    "Horizons-content-fetcher/0.1 (low-frequency product research; contact via project repository)",
  github: {
    queries: [
      "topic:ai-tool",
      "topic:llm",
      "topic:ai-agents",
      "topic:text-to-image",
      "topic:text-to-speech",
      "topic:ai-coding",
      "topic:image-generation",
      "topic:speech-to-text",
      "topic:ai-productivity",
      "topic:ai-assistant",
    ],
    minStars: 50,
  },
  productHunt: {
    topicSlugs: ["artificial-intelligence"],
  },
};

export function getProductHuntToken(): string | null {
  return process.env.PH_TOKEN ?? null;
}
