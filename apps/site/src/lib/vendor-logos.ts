/**
 * 厂商品牌图标（单色，随文字颜色变化）
 *
 * 图标文件位于 `apps/site/public/logos/*.svg`，取自 @lobehub/icons-static-svg（MIT）。
 * 只收录图形标，不收录字标，保证在 18px 下仍可辨识；未收录的厂商返回 null，
 * 由调用方退回首字母方块。
 */
const VENDOR_ICONS: Record<string, string> = {
  OpenAI: "openai",
  Anthropic: "anthropic",
  Google: "google",
  Qwen: "qwen",
  Meta: "meta",
  "Mistral AI": "mistral",
  DeepSeek: "deepseek",
  "Z.ai": "zai",
  MiniMax: "minimax",
  "Moonshot AI": "moonshot",
  xAI: "xai",
  Tencent: "tencent",
  ByteDance: "bytedance",
  NVIDIA: "nvidia",
  Amazon: "aws",
  Perplexity: "perplexity",
  Cohere: "cohere",
  Xiaomi: "xiaomimimo",
  "Sakana AI": "sakana",
  StepFun: "stepfun",
  "Nous Research": "nousresearch",
  InclusionAI: "ling",
  Inception: "inception",
  Reka: "reka",
  Upstage: "upstage",
  Poolside: "poolside",
  "Liquid AI": "liquid",
  "Inference.net": "inference",
  Relace: "relace",
  Morph: "morph",
  Microsoft: "microsoft",
  IBM: "ibm",
  Fireworks: "fireworks",
  Meituan: "longcat",
  "Aion Labs": "aionlabs",
};

/** 返回厂商图标 URL；未收录返回 null */
export function vendorIconUrl(provider: string): string | null {
  const name = VENDOR_ICONS[provider];
  return name ? `/logos/${name}.svg` : null;
}