import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// 数据层（src/lib/data.ts、trends.ts）直接读 content/*.json，需要 @content 别名（只读，构建期解析）
const contentDir = fileURLToPath(new URL("../../content", import.meta.url));

// URL 保持既有线上路径：无尾斜杠。
// 产物为 /tools/xxx/index.html，由 Cloudflare 静态资产以 html_handling=drop-trailing-slash 直出。
export default defineConfig({
  site: "https://horizons.tools",
  /*
   * 站点仍然是静态站：所有页面默认预渲染，产物照旧是 dist 下的静态 HTML。
   * 唯一的例外是 /preview/[domain]（`prerender = false`）—— 后台预览页按需查 D1 渲染，
   * 数据一改刷新就生效，不用再等「整站构建 20 分钟」。
   *
   * 因此 adapter 只为那一条路由存在。图片走构建期编译（compile），不引入运行时
   * IMAGES 绑定，也不用 Cloudflare Images 的付费配额。
   */
  output: "static",
  adapter: cloudflare({ imageService: "compile" }),
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