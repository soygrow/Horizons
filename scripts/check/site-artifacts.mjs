#!/usr/bin/env node
/**
 * 构建产物断言（本地部署与 CI 共用，任一失败即退出 1）
 *
 * 目的：把「只部署了一部分页面」「数据塌成 0 条」「SEO 策略被改坏」这几类事故
 * 拦在发布之前，而不是等用户看到空白页才发现。
 *
 * 用法：node scripts/check/site-artifacts.mjs [--dist apps/site/dist]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = path.join(ROOT, "apps/site/dist");
const MANIFEST = path.join(ROOT, "content/dist/manifest.json");

/** 必须存在的频道（新增频道时同步补这里；与 scripts/serve-local.sh 的 CHANNELS 一致） */
const CHANNELS = [
  "/",
  "/tools",
  "/github",
  "/trends",
  "/daily",
  "/models",
  "/opportunity",
  "/opportunity/archive",
];

/** 各榜单的最低条数：低于此值视为数据异常（保守阈值，只拦塌库不拦正常波动） */
const MIN_COUNTS = { tools: 50, github: 300, trends: 50, models: 50 };

/** 允许被索引的频道（与 apps/site/src/config/seo.ts 的 INDEXABLE_PATHS 一致） */
const INDEXABLE = ["/", "/tools", "/github", "/trends", "/privacy", "/terms"];

const errors = [];
const notes = [];
const fail = (msg) => errors.push(msg);
const note = (msg) => notes.push(msg);

const pagePath = (channel) =>
  channel === "/" ? path.join(DIST, "index.html") : path.join(DIST, channel.replace(/^\//, ""), "index.html");

// 1. 关键页面
if (!existsSync(DIST)) {
  console.error(`✗ 产物目录不存在：${DIST}（先执行构建）`);
  process.exit(1);
}
for (const c of CHANNELS) {
  const p = pagePath(c);
  if (!existsSync(p)) fail(`缺少频道页面：${path.relative(DIST, p)}（${c}）`);
}
if (!existsSync(path.join(DIST, "404.html"))) fail("缺少自定义 404 页（404.html）");

// 2. 页面总量（防止详情页整体没生成）
const countHtml = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return n + countHtml(p);
    return n + (e.name.endsWith(".html") ? 1 : 0);
  }, 0);
let htmlCount = 0;
try {
  htmlCount = countHtml(DIST);
} catch (e) {
  fail(`统计 HTML 失败：${e.message}`);
}
if (htmlCount < 500) fail(`HTML 页面仅 ${htmlCount} 个，远低于预期（详情页可能没生成）`);

// 3. 数据条数
if (!existsSync(MANIFEST)) {
  fail("缺少 content/dist/manifest.json（data 步骤没跑？）");
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const boards = manifest.boards || {};
  for (const [name, floor] of Object.entries(MIN_COUNTS)) {
    const b = boards[name];
    if (!b) {
      fail(`manifest 缺少榜单 ${name}`);
      continue;
    }
    if (b.status && b.status !== "ready") fail(`榜单 ${name} 状态为 ${b.status}，不是 ready`);
    const n = Number(b.count || 0);
    const d = Number(b.detailCount || 0);
    if (n < floor) fail(`榜单 ${name} 只有 ${n} 条（下限 ${floor}），疑似数据塌陷`);
    if (d < floor) fail(`榜单 ${name} 详情页只有 ${d} 个（下限 ${floor}）`);
  }
}

// 4. SEO 基础设施
for (const f of ["robots.txt", "sitemap.xml"]) {
  if (!existsSync(path.join(DIST, f))) fail(`缺少 ${f}`);
}
const sitemapFile = path.join(DIST, "sitemap.xml");
if (existsSync(sitemapFile)) {
  const xml = readFileSync(sitemapFile, "utf8");
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) {
    const p = new URL(loc).pathname.replace(/\/+$/, "") || "/";
    if (!INDEXABLE.includes(p)) fail(`sitemap 里出现了非白名单路径：${loc}`);
  }
  for (const c of INDEXABLE) {
    const expect = new URL(c, "https://horizons.tools").href;
    if (!locs.some((l) => l.replace(/\/+$/, "") === expect.replace(/\/+$/, ""))) {
      fail(`sitemap 缺少白名单频道：${c}`);
    }
  }
}

// 5. 索引策略：白名单频道 index、详情页 noindex
const robotsOf = (file) => {
  const html = readFileSync(file, "utf8");
  const m = html.match(/<meta name="robots" content="([^"]+)"/i);
  return m ? m[1] : "";
};
for (const c of INDEXABLE) {
  const p = pagePath(c);
  if (!existsSync(p)) continue;
  const r = robotsOf(p);
  if (!r.startsWith("index")) fail(`频道 ${c} 的 robots 应为 index,follow，实际是「${r || "无"}」`);
}
const detailSamples = [
  ["tools", path.join(DIST, "tools")],
  ["github", path.join(DIST, "github")],
  ["models", path.join(DIST, "models")],
];

/** 递归找出频道下第一个详情页（跳过频道自身的 index.html 与分页目录） */
function firstDetailPage(dir, depth = 0) {
  if (depth > 3) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (depth === 0 && ["page", "data"].includes(e.name)) continue;
    const child = path.join(dir, e.name);
    const idx = path.join(child, "index.html");
    if (existsSync(idx)) return idx;
    const deeper = firstDetailPage(child, depth + 1);
    if (deeper) return deeper;
  }
  return null;
}

for (const [name, dir] of detailSamples) {
  if (!existsSync(dir)) continue;
  const file = firstDetailPage(dir);
  if (!file) {
    fail(`${name} 频道没有任何详情页产物`);
    continue;
  }
  const r = robotsOf(file);
  if (!r.startsWith("noindex")) {
    fail(`详情页 ${path.relative(DIST, file)} 应为 noindex,follow，实际是「${r || "无"}」`);
  }
}

// 6. 首页体积（防止聚合数据把首屏撑爆）
const indexPath = path.join(DIST, "index.html");
if (existsSync(indexPath)) {
  const kb = statSync(indexPath).size / 1024;
  if (kb > 400) note(`首页 HTML ${kb.toFixed(0)}KB，偏大，注意首屏性能`);
}

if (notes.length) notes.forEach((n) => console.log(`! ${n}`));
if (errors.length) {
  console.error(`\n✗ 产物断言失败（${errors.length} 项）：`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}
console.log(`✓ 产物断言通过：${CHANNELS.length} 个频道 / ${htmlCount} 个页面 / sitemap ${INDEXABLE.length} 条 / noindex 策略正常`);