import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

/**
 * 官网截图：桌面 + 移动双视口，存 apps/site/public/screenshots/，并推到 R2。
 *
 * 与 scripts/fetch/screenshot.ts（写 content/aitools.json 的旧批量脚本）的分工：
 * 那个是历史上跑全量 aitools 用的，现在候选池在 D1，富化时逐站调用本模块即可。
 *
 * 三条约束：
 *   1. headless —— 富化跑在 GitHub Actions（ubuntu），没有显示器；旧脚本的
 *      headless:false 只能靠 xvfb 兜着，这里不赌。
 *   2. 增量 —— 图已存在且字段有值就跳过，重复富化不会重拍（省时也省 R2 写）。
 *   3. 失败不致命 —— 截图拿不到是常见情况（Cloudflare 拦截、站点超时），
 *      调用方包 try/catch 即可，不要让一张图把整站富化算成失败。
 *
 * URL 形态固定为 /screenshots/<domain>.png（-mobile 后缀为移动版），
 * Worker 拦截该前缀从 R2 桶 horizons-archive 里取平铺文件名的对象。
 */

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SHOT_DIR = path.join(ROOT, "apps/site/public/screenshots");
const R2_BUCKET = "horizons-archive";
const WRANGLER_BIN = path.join(ROOT, "apps/site/node_modules/.bin/wrangler");

/** 首屏渲染：domcontentloaded 之后还要给字体/首屏动画留时间，否则截到白屏 */
const RENDER_SETTLE_MS = 2_500;
/** 切视口会触发响应式重排，等布局稳定再截 */
const VIEWPORT_SETTLE_MS = 800;

const VIEWPORTS = [
  { suffix: "", width: 1280, height: 800, field: "screenshotDesktopUrl" },
  { suffix: "-mobile", width: 390, height: 844, field: "screenshotMobileUrl" },
] as const;

export interface ScreenshotResult {
  screenshotDesktopUrl?: string;
  screenshotMobileUrl?: string;
  /** 本次新拍的张数（0 = 已存在，直接复用） */
  captured: number;
  /** 上传 R2 失败的张数（本地文件仍在，可用 upload-screenshots-r2 补传） */
  uploadFailed: number;
}

/**
 * 把图片推到 R2，key 与 Worker 的读取规则一致（平铺文件名）。
 *
 * 优先走 Cloudflare REST：富化一次跑十几站、每站两张图，wrangler 每张都得起一个
 * 子进程（~1.5s），40 张就多花一分钟；CI 里本来就有 API token，直接 PUT 更快。
 * 本地通常只有 wrangler 登录态、没有 token，于是回退到 CLI。
 */
async function putToR2(file: string): Promise<void> {
  const key = path.basename(file);
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (accountId && token) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${R2_BUCKET}/objects/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "image/png" },
        body: fs.readFileSync(file),
      },
    );
    if (!res.ok) {
      throw new Error(`R2 上传失败 HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
    }
    return;
  }

  await execFileAsync(
    WRANGLER_BIN,
    [
      "r2",
      "object",
      "put",
      `${R2_BUCKET}/${key}`,
      `--file=${file}`,
      "--content-type=image/png",
      "--remote",
    ],
    { cwd: ROOT, maxBuffer: 8 * 1024 * 1024 },
  );
}

/**
 * 截图一个站点。
 *
 * @param domain 站域名（同时作为文件名）
 * @param url    官网地址（用 tool.url，别用拼的 https://domain —— 有些站只在 www 上）
 * @param opts.upload   是否上传 R2（CI 里开，本地调试可关）
 * @param opts.timeoutMs 单次导航超时
 */
export async function captureScreenshots(
  domain: string,
  url?: string,
  opts: { upload?: boolean; timeoutMs?: number } = {},
): Promise<ScreenshotResult> {
  const upload = opts.upload ?? true;
  const timeoutMs = opts.timeoutMs ?? 25_000;
  const target = url || `https://${domain}`;
  const result: ScreenshotResult = { captured: 0, uploadFailed: 0 };

  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 已存在的先认下来：图在就不重拍，缺字段的顺手补上
  const missing = VIEWPORTS.filter((vp) => {
    const file = path.join(SHOT_DIR, `${domain}${vp.suffix}.png`);
    const exists = fs.existsSync(file);
    if (exists) result[vp.field] = `/screenshots/${domain}${vp.suffix}.png`;
    return !exists;
  });
  if (missing.length === 0) return result;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: VIEWPORTS[0].width, height: VIEWPORTS[0].height },
      // 部分站的入场动画会在截图瞬间停在半透明态，强制减少动效
      reducedMotion: "reduce",
    });
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(RENDER_SETTLE_MS);

    for (const vp of missing) {
      const file = path.join(SHOT_DIR, `${domain}${vp.suffix}.png`);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(VIEWPORT_SETTLE_MS);
      await page.screenshot({ path: file, type: "png" });
      result[vp.field] = `/screenshots/${domain}${vp.suffix}.png`;
      result.captured++;

      if (!upload) continue;
      try {
        await putToR2(file);
      } catch (e) {
        result.uploadFailed++;
        // 不中断：图已在本地，可事后用 scripts/admin/upload-screenshots-r2.ts 补传，
        // 但错误要打出来 —— 静默失败会让人以为线上有图
        const err = e as { message?: string; stderr?: string };
        console.warn(
          `[screenshot] R2 上传失败 ${domain}${vp.suffix}：`,
          (err.stderr || err.message || "").slice(0, 200),
        );
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}