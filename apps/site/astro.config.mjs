import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// 数据层（src/lib/data.ts、trends.ts）直接读 content/*.json，需要 @content 别名（只读，构建期解析）
const contentDir = fileURLToPath(new URL("../../content", import.meta.url));

// URL 保持既有线上路径：无尾斜杠。
// 产物为 /tools/xxx/index.html，由 Cloudflare 静态资产以 html_handling=drop-trailing-slash 直出。
export default defineConfig({
  site: "https://horizons.tools",
  output: "static",
  trailingSlash: "ignore",
  build: {
    format: "directory",
    inlineStylesheets: "auto",
  },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: { "@content": contentDir },
    },
    server: {
      // 构建期需要读取仓库根的 content/dist 产物
      fs: { allow: ["../.."] },
      // 本地开发把 /api 转给 wrangler dev（apps/api），保证「我在做」等交互可联调
      proxy: {
        "/api": {
          target: process.env.API_ORIGIN || "http://127.0.0.1:8787",
          changeOrigin: true,
        },
      },
    },
  },
});