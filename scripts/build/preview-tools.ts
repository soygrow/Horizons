/**
 * 生成「待发布条目」的详情预览数据（构建期执行）。
 *
 * 后台审核时最想确认的一件事是「这条工具在详情页上长什么样」，
 * 而富化完的卡片就躺在 board_items 里 —— 结构和发布后的 AITool 完全一致，
 * 唯一的差别是没有 ranks（还没上榜）和发布时的派生字段。
 *
 * 所以这里把队列里富化过的条目导出成和 `tools/detail/*.json` 同构的文件，
 * 页面侧用同一个 [domain].astro 组件渲染，布局、字段、样式天然一致，
 * 不需要为预览再维护一套模板（那必然会和线上跑偏）。
 *
 * 数据来源是 D1 的 board_items.card：
 *   enriched       富化成功的
 *   enriching      正在跑的（卡片可能只有一半，预览能看出还缺什么）
 *   enrich_failed  失败的（同样值得看，决定是重跑还是放弃）
 *
 * 无 D1 凭据时（本地没配 token、也没 wrangler 登录）跳过并且不动现有文件 ——
 * 本地 `astro dev` 想继续看预览，靠的就是上一次留下的产物。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { d1Configured } from "../admin/d1-client";
import { readWorkspace } from "../admin/board-items";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT_DIR = path.join(ROOT, "content/dist/tools/preview");

/**
 * 哪些状态值得预览。
 *
 * `candidate` 必须在内：采集落库后 stage 就是 candidate，
 * 只收 enriched 的话「后台刚采完 → 点预览」永远打不开 ——
 * 而审核员恰恰是在这一步判断这条要不要继续富化。
 * `rejected` 排除：判定不收录的条目没有预览价值。
 */
const PREVIEW_STAGES = new Set(["candidate", "enriched", "enriching", "enrich_failed"]);

interface PreviewItem {
  domain?: string;
  stage?: string;
}

function clean(): void {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function main(): Promise<void> {
  if (!d1Configured()) {
    console.log("[preview] 无 D1 凭据，跳过预览数据生成（沿用已有产物）");
    return;
  }

  const { items } = await readWorkspace<PreviewItem & Record<string, unknown>>("tools");
  const picked = items.filter((i) => i?.domain && PREVIEW_STAGES.has(i.stage ?? ""));

  clean();

  for (const tool of picked) {
    // 与 tools/detail/{domain}.json 同构：页面读的是模块的 data 导出
    fs.writeFileSync(
      path.join(OUT_DIR, `${tool.domain}.json`),
      JSON.stringify({ data: tool }, null, 2) + "\n",
      "utf-8",
    );
  }

  console.log(`[preview] 生成 ${picked.length} 个预览页（队列 ${items.length} 条）`);
}

main().catch((e) => {
  // 预览数据失败不该拦住整站构建：页面少几个预览，比发不出去好
  console.error(`[preview] 生成失败：${e instanceof Error ? e.message : String(e)}`);
});