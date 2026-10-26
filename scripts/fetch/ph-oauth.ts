import "./config"; // 副作用导入：触发 .env.local 加载（不可写成命名导入，未使用会被 esbuild 删除）

/**
 * Product Hunt OAuth 授权（线上回调版）。
 * 生成授权链接（回调到 https://horizons.tools/api/ph/callback），用户浏览器授权后，
 * 线上端点会展示 token JSON，复制保存到 .ph-token.json 即可。
 *
 * 用法：pnpm ph:oauth
 */

const REDIRECT_URI = "https://horizons.tools/api/ph/callback";

async function main(): Promise<void> {
  if (!process.env.PH_API_KEY) {
    console.error("[ph-oauth] 请在 .env.local 配置 PH_API_KEY");
    process.exit(1);
  }

  const authorizeUrl =
    `https://api.producthunt.com/v2/oauth/authorize?` +
    `client_id=${encodeURIComponent(process.env.PH_API_KEY)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=${encodeURIComponent("public private")}`;

  console.log("[ph-oauth] 请用浏览器打开以下链接完成授权：\n");
  console.log(authorizeUrl + "\n");
  console.log("授权后会跳到线上页面，把页面上的 token JSON 复制保存到项目根目录 .ph-token.json");
}

main().catch((e) => {
  console.error("[ph-oauth] 失败：", e);
  process.exit(1);
});
