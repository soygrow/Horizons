import { Hono } from "hono";
import type { Env } from "../env";

const PH_REDIRECT_URI = "https://horizons.tools/api/ph/callback";

/**
 * Product Hunt OAuth 回调（线上）。
 * 授权码换取 access_token / refresh_token，并在页面展示 JSON，供本地采集脚本使用。
 */
export const ph = new Hono<{ Bindings: Env }>();

ph.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.text("缺少 code 参数", 400);

  let res: Response;
  try {
    res = await fetch("https://api.producthunt.com/v2/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: c.env.PH_API_KEY,
        client_secret: c.env.PH_API_SECRET,
        redirect_uri: PH_REDIRECT_URI,
        grant_type: "authorization_code",
        code,
      }),
    });
  } catch (e) {
    return c.text(`请求 PH token 失败：${e}`, 500);
  }

  if (!res.ok) {
    const body = await res.text();
    return c.text(`换取 token 失败：HTTP ${res.status}\n${body}`, 500);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const printable = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };

  const json = JSON.stringify(printable, null, 2);
  return c.html(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>PH 授权成功</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background:#0b0d12; color:#e5e7eb; max-width:680px; margin:60px auto; padding:0 20px; }
  h1 { font-size:20px; }
  pre { background:#12151c; border:1px solid #1f2430; border-radius:8px; padding:16px; overflow:auto; font-size:12px; color:#9ca3af; }
  code { color:#34d399; }
</style>
</head>
<body>
  <h1>✅ Product Hunt 授权成功</h1>
  <p>请复制下面的 JSON，保存到项目根目录 <code>.ph-token.json</code>（替换原内容）：</p>
  <pre>${json.replace(/</g, "&lt;")}</pre>
</body>
</html>`);
});
