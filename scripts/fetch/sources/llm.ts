// DeepSeek LLM 客户端（OpenAI 兼容接口），用于中文描述 / 分类 / 定价提取
import { proxyPostJSON } from "../proxy";

export function hasLLM(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

/** 网络类错误与限流 / 5xx 才重试；4xx 参数错误重试也没用 */
const RETRIES = Number(process.env.LLM_RETRIES ?? 2);
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 90_000);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // 偶发返回内容被截断，重试通常就能过
  if (e instanceof SyntaxError) return true;
  const code = String((e as { cause?: { code?: string } }).cause?.code ?? "");
  const text = `${e.message} ${code}`;
  if (/UND_ERR|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|socket hang up|fetch failed|timeout/i.test(text)) {
    return true;
  }
  return /DeepSeek 请求失败 (429|5\d\d)/.test(e.message);
}

/**
 * model 默认 deepseek-chat（服务端别名，现在指向 flash，足够描述/分类这种活）。
 * 机会榜要长文推理 + 长 JSON 输出，会显式传 deepseek-flash。
 */
export async function chatJSON<T>(
  system: string,
  user: string,
  maxTokens = 4000,
  temperature = 0.4,
  model = process.env.LLM_MODEL || "deepseek-chat",
): Promise<T> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("未配置 DEEPSEEK_API_KEY");

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature,
    max_tokens: maxTokens,
  });

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await proxyPostJSON("https://api.deepseek.com/chat/completions", body, {
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: TIMEOUT_MS,
      });
      if (!res.ok) {
        throw new Error(`DeepSeek 请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const data = JSON.parse(await res.text()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      return JSON.parse(content) as T;
    } catch (e) {
      // 最后一次仍失败就抛出，由调用方记录该站失败
      if (attempt >= RETRIES || !retryable(e)) throw e;
      const wait = 1500 * (attempt + 1);
      console.warn(
        `[llm] 第 ${attempt + 1} 次失败，${wait}ms 后重试：${e instanceof Error ? e.message.slice(0, 120) : e}`,
      );
      await sleep(wait);
    }
  }
}
