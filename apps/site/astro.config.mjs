import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// 复用 apps/web 的 lib 时需要它的 @content 别名（只读 JSON，构建期解析）
const contentDir = fileURLToPath(new URL("../../content", import.meta.url));

// URL 与现有 Next 站保持一致：无尾斜杠。
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
    },
  },
});