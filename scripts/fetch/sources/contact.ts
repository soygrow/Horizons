/**
 * 联系方式提取（免费、合规）：从首页 HTML 提取公开邮箱与社媒链接。
 * 只读取公开页面中的联系信息，不扫描任何非公开资源。
 */
import type { AITool } from "@horizons/shared";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g;

const EMAIL_BLOCKLIST = [
  /example\./i,
  /your(email|company|domain)?@/i,
  /test@/i,
  /sample@/i,
  /sentry/i,
  /wixpress/i,
  /\.(png|jpg|jpeg|gif|svg|webp|avif|ico)$/i,
  /noreply|no-reply/i,
  /@[1-9]x\b/i,
  /placeholder/i,
  /email\.com$/i,
  /domain\.com$/i,
  /\.sentry\.io$/i,
  /@github\./i,
];

const SOCIAL_RULES: { pattern: RegExp; label: string }[] = [
  { pattern: /(x|twitter)\.com\//i, label: "Twitter / X" },
  { pattern: /linkedin\.com\//i, label: "LinkedIn" },
  { pattern: /github\.com\//i, label: "GitHub" },
  { pattern: /youtube\.com\/|youtu\.be\//i, label: "YouTube" },
  { pattern: /discord\.(gg|com)\//i, label: "Discord" },
  { pattern: /t\.me\//i, label: "Telegram" },
  { pattern: /facebook\.com\//i, label: "Facebook" },
  { pattern: /instagram\.com\//i, label: "Instagram" },
];

const HREF_RE = /<a[^>]+href=["']([^"']+)["']/gi;

function extractEmails(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/[.,;:'"]+$/, "");
    if (EMAIL_BLOCKLIST.some((re) => re.test(email))) continue;
    seen.add(email.toLowerCase());
  }
  return [...seen];
}

function extractSocials(html: string, baseUrl: string): { label: string; url: string }[] {
  const seen = new Set<string>();
  const result: { label: string; url: string }[] = [];

  for (const m of html.matchAll(HREF_RE)) {
    const raw = m[1];
    let url = raw;
    try {
      url = new URL(raw, baseUrl).toString();
    } catch {
      continue;
    }
    for (const rule of SOCIAL_RULES) {
      if (rule.pattern.test(url)) {
        const key = `${rule.label}:${new URL(url).hostname}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push({ label: rule.label, url });
        break;
      }
    }
  }
  return result;
}

export function extractContact(
  html: string,
  baseUrl: string,
): NonNullable<AITool["contact"]> | undefined {
  const emails = extractEmails(html);
  const socials = extractSocials(html, baseUrl);
  if (emails.length === 0 && socials.length === 0) return undefined;

  return {
    email: emails[0],
    socials: socials.slice(0, 6),
  };
}
