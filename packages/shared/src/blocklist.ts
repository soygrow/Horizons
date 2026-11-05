/**
 * 域名准入黑名单（唯一真源）
 *
 * 对应 docs/15-AI工具榜收录原则.md 的 A1 / A2。
 * 采集端发现候选时用它拦截，构建端 isListed 再兜一次，
 * 避免历史存量里的违规站被重新放出来。
 */

/** A2：平台型大厂主站，不是受众要找的「AI 工具」，不参与排名 */
export const PLATFORM_BLOCKLIST: readonly string[] = [
  "microsoft.com",
  "google.com",
  "labs.google", // .google 是 gTLD，后缀匹配不到 google.com，需单列
  "apple.com",
  "amazon.com",
  "cloudflare.com",
  "figma.com",
  "adobe.com",
  "notion.so",
  "slack.com",
  "zoom.us",
  "xiaomi.com", // 手机/硬件厂商官网，AI 只是产品页里的一个型号
];

/**
 * A1：不满足「独立 AI 产品」的存量站。
 * 源数据保留（便于复采与画像），仅不进榜。
 */
export const AI_FIT_BLOCKLIST: readonly string[] = [
  "notion.com", // 与 notion.so 同一产品，协作平台而非 AI 原生工具
  "1password.com", // 密码管理器，agent 只是附加功能
  "bigmodel.cn", // 大模型开放平台，属平台/基础设施
  "claude.com", // Anthropic 官方站，非独立可复刻的 AI 工具
  "claude.ai", // 同上：厂商官方对话入口，不是受众要做的产品
  "deepseek.com", // 同上：模型厂商官方站
  "jotform.com", // 表单工具，AI 只是附加功能（与 1password 同类）
  "gitbook.com", // 文档工具，AI 只是附加功能
];

/** 判断域名是否命中任一黑名单（含子域，如 learn.microsoft.com） */
export function isBlockedDomain(domain: string): boolean {
  const d = (domain || "").toLowerCase().trim();
  if (!d) return true;
  return [...PLATFORM_BLOCKLIST, ...AI_FIT_BLOCKLIST].some(
    (b) => d === b || d.endsWith(`.${b}`),
  );
}