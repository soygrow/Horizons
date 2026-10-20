/** URL 规范化：去掉 hash 与常见跟踪参数 */
export function normalizeUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url.trim());
    u.hash = "";
    const tracking = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
      "ref_src",
      "fbclid",
    ];
    for (const p of tracking) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url.trim();
  }
}

/** 从 URL 提取域名（去 www） */
export function extractDomain(url: string): string {
  if (!url) return "";
  try {
    return new URL(url.trim()).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 压缩空白并截断 */
export function truncate(text: string, max = 300): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** 去除 HTML 标签与常见实体 */
export function stripHtml(text: string): string {
  return (text ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ");
}
