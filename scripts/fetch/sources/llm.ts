// DeepSeek LLM 客户端（OpenAI 兼容接口），用于中文描述 / 分类 / 定价提取

export function hasLLM(): boolean {
  return !!process.env.DEEPSEEK_API_KEY;
}

export async function chatJSON<T>(
  system: string,
  user: string,
  maxTokens = 4000,
): Promise<T> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("未配置 DEEPSEEK_API_KEY");

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    throw new Error(`DeepSeek 请求失败 ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  return JSON.parse(content) as T;
}
