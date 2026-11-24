// 正文抓取：对入选的 RSS 条目抓原文正文，提取可读文本。
// 抓不到不阻断成稿，静默降级 —— 成稿仍用 feed 摘要兜底。
//
// 为什么只抓 RSS：feed 的 <description> 是作者随手写的残片，质量不可控；
// 正文导语（开头 1–2 句）才是可核实的事实陈述。GitHub 用 description 已够，
// HN 的条目本身是「讨论」而非「原文」，先不抓。

export type BodyStatus = "ok" | "empty" | "failed";

export interface BodyResult {
  status: BodyStatus;
  /** 提取出的正文文本（去标签、压空白）；失败时为 null */
  text: string | null;
}

const UA =
  "Horizons-daily-intel/0.1 (public pages only; low frequency; contact via project repository)";

/** 正文提取上限：足够提炼导语 + 核实数字，又不把整页垃圾存进去 */
const MAX_TEXT = 6000;

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;|&lsquo;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 从 HTML 提取正文：优先 <article>/<main>，退化为全页去标签 */
export function extractText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const main =
    s.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ??
    s.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  if (main) s = main;

  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, MAX_TEXT);
}

async function fetchHtml(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*" },
        signal: AbortSignal.timeout(12_000),
        redirect: "follow",
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      return await res.text();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("正文请求失败");
}

export async function fetchBody(url: string): Promise<BodyResult> {
  try {
    const html = await fetchHtml(url);
    const text = extractText(html);
    // 反爬拦截页 / 空页 / JSON 错误响应去掉标签后几乎不剩正文
    if (text.length < 80) return { status: "empty", text: null };
    return { status: "ok", text };
  } catch {
    return { status: "failed", text: null };
  }
}

/** 对一批目标并发抓正文（有限并发，避免短时间内打爆某个站点） */
export async function fetchBodies(
  targets: Array<{ id: string; url: string }>,
  concurrency = 4,
): Promise<Map<string, BodyResult>> {
  const results = new Map<string, BodyResult>();
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const t = queue.shift()!;
      results.set(t.id, await fetchBody(t.url));
    }
  });
  await Promise.all(workers);
  return results;
}