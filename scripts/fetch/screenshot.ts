import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";
import type { AITool } from "@horizons/shared";

/**
 * 官网截图采集：访问每个工具的官网首页并截图（桌面 + 移动），存到 apps/site/public/screenshots/，
 * 并把 screenshotUrl / screenshotMobileUrl 写回 content/aitools.json。已存在的截图自动跳过，可增量执行。
 *
 * 截图会同时上传到 R2（桶 horizons-archive）：线上由 apps/site/src/worker.ts
 * 从桶里取图，public/ 下的副本只在本地留存、不入 git。上传失败只告警不中断，
 * 可用 scripts/admin/upload-screenshots-r2.ts 事后补传。
 *
 * 用法：pnpm run screenshot [--limit N] [--no-upload]
 */

const execFileAsync = promisify(execFile);

const TOOLS_PATH = path.resolve(process.cwd(), "content/aitools.json");
const SCREENSHOT_DIR = path.resolve(process.cwd(), "apps/site/public/screenshots");

const R2_BUCKET = "horizons-archive";
const WRANGLER_BIN = path.resolve(
  process.cwd(),
  "apps/site/node_modules/.bin/wrangler",
);

/** 把刚截的图推到 R2，key 与 Worker 的读取规则一致（平铺文件名） */
async function putToR2(file: string): Promise<void> {
  await execFileAsync(
    WRANGLER_BIN,
    [
      "r2",
      "object",
      "put",
      `${R2_BUCKET}/${path.basename(file)}`,
      `--file=${file}`,
      "--content-type=image/png",
      "--remote",
    ],
    { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 },
  );
}

/** 桌面 + 移动双视口；移动端截图几乎零额外成本（同页二次截图） */
const VIEWPORTS: {
  suffix: string;
  width: number;
  height: number;
  field: "screenshotDesktopUrl" | "screenshotMobileUrl";
}[] = [
  { suffix: "", width: 1280, height: 800, field: "screenshotDesktopUrl" },
  { suffix: "-mobile", width: 390, height: 844, field: "screenshotMobileUrl" },
];

function loadTools(): AITool[] {
  try {
    return JSON.parse(fs.readFileSync(TOOLS_PATH, "utf-8")) as AITool[];
  } catch {
    return [];
  }
}

function saveTools(tools: AITool[]): void {
  fs.writeFileSync(TOOLS_PATH, JSON.stringify(tools, null, 2) + "\n", "utf-8");
}

function parseLimit(): number {
  const i = process.argv.indexOf("--limit");
  if (i >= 0 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

async function getBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: false, channel: "chrome" });
  } catch {
    return await chromium.launch({ headless: false });
  }
}

/** --domain a.com,b.com 只处理指定域名（逗号分隔） */
function parseDomains(): string[] {
  const i = process.argv.indexOf("--domain");
  if (i < 0 || !process.argv[i + 1]) return [];
  return process.argv[i + 1].toLowerCase().split(",").map((d) => d.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const tools = loadTools();
  const limit = parseLimit();
  const only = parseDomains();
  // 默认传 R2；CI 或没登录 wrangler 的环境用 --no-upload 关掉
  const upload = !process.argv.includes("--no-upload");
  const browser = await getBrowser();

  let done = 0;
  let captured = 0;
  let restored = 0;
  try {
    for (const t of tools) {
      if (only.length && !only.includes(t.domain)) continue;
      if (limit > 0 && done >= limit) break;
      done++;

      const missing = VIEWPORTS.filter((vp) => {
        const file = path.join(SCREENSHOT_DIR, `${t.domain}${vp.suffix}.png`);
        if (fs.existsSync(file)) {
          // 图片已存在但字段丢失：仅补写字段，不重复截图
          if (!t[vp.field]) {
            t[vp.field] = `/screenshots/${t.domain}${vp.suffix}.png`;
            restored++;
          }
          return false;
        }
        return true;
      });
      if (missing.length === 0) continue; // 桌面 + 移动都已有，跳过

      try {
        const page = await browser.newPage();
        await page.goto(t.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        await page.waitForTimeout(2000);
        for (const vp of missing) {
          const file = path.join(SCREENSHOT_DIR, `${t.domain}${vp.suffix}.png`);
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.waitForTimeout(600);
          await page.screenshot({ path: file, type: "png" });
          t[vp.field] = `/screenshots/${t.domain}${vp.suffix}.png`;
          captured++;
          console.log(`[shot] ${t.name} → ${t.domain}${vp.suffix}.png`);
          if (upload) {
            try {
              await putToR2(file);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              console.warn(`[shot] 上传 R2 失败（本地已留存）：${msg.slice(0, 120)}`);
            }
          }
        }
        await page.close();
      } catch (e) {
        console.warn(
          `[shot] ${t.domain} 截图失败：`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  } finally {
    await browser.close();
  }

  saveTools(tools);
  console.log(`[shot] 完成：处理 ${done} 个，新截图 ${captured} 张，补写字段 ${restored} 个`);
}

main().catch((e) => {
  console.error("[shot] 失败：", e);
  process.exit(1);
});
