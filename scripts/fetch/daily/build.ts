import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { composeDigest } from "./compose";
import { todayInTimezone } from "./config";
import { mergeEvents } from "./events";
import { allocate, isBusiness, scoreEvent, type Allocation, type Scored } from "./score";
import { fetchBodies } from "./sources/body";
import { loadRawDigest, saveDigest } from "./store";
import type { ModuleKey } from "./types";

/**
 * 成稿入口：读 raw/<date>.json → 事件合并 → 评分 → 模块分配 → 写 <date>.json
 *   pnpm digest:daily                 # 处理今天
 *   pnpm digest:daily --date=2026-10-30
 *   pnpm digest:daily --dry           # 只打印，不写文件
 *   pnpm digest:daily --review        # 额外列出未采用里分数最高的 20 条，用于复盘漏报
 */

const MODULE_NAME: Record<ModuleKey, string> = {
  headline: "今日头条",
  tools: "能直接用的",
  money: "钱与机会",
  action: "今天就能做",
};

function argValue(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : undefined;
}

/** 未采用的原因：先给结构性否决，再给分数与配额，避免把「配额满」误读成「不重要」 */
function dropReason(s: Scored): string {
  if (!s.onTopic) return "与 AI 主题无关";
  if (s.evidence === "rumor") return "未证实，不发布";
  if (s.ev.items[0].repeat) return "旧闻，此前已出现过";
  if (s.score < 45) return `分数 ${s.score} < 45`;
  return "分数够但模块配额已满 / 类别未命中";
}

/** 复盘用：列出未采用里分数最高的一批，核对是否漏报 */
function printDropped(scored: Scored[], allocation: Allocation, top: number): void {
  const used = new Set<string>();
  for (const m of allocation.modules) for (const s of m.items) used.add(s.ev.id);

  const unused = scored
    .filter((s) => !used.has(s.ev.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  console.log(`\n未采用中最高的 ${unused.length} 条（复盘漏报，按分数降序）：`);
  unused.forEach((s, i) => {
    const primary = s.ev.items[0];
    console.log(
      `${String(i + 1).padStart(2)}. ${String(s.score).padStart(3)} 分 · ${primary.source.padEnd(10)} · ${s.category.padEnd(14)} · ${dropReason(s)}`,
    );
    console.log(`    ${primary.title.slice(0, 90)}`);
    console.log(`    ${primary.url}`);
  });
}

async function main(): Promise<void> {
  const date = argValue("--date") ?? todayInTimezone();
  const dry = process.argv.includes("--dry");

  const raw = loadRawDigest(date);
  if (!raw) {
    console.error(`找不到 content/digest/raw/${date}.json，先运行 pnpm fetch:daily`);
    process.exit(1);
  }

  const events = mergeEvents(raw.items, date);
  const scored: Scored[] = events.map((ev) => {
    const rank = Math.max(...ev.items.map((i) => i.signals.rank ?? 0));
    return scoreEvent(ev, rank);
  });
  const allocation = allocate(scored);

  console.log(`\n成稿 ${date}｜原始 ${raw.items.length} 条 → 事件 ${events.length} 个`);
  const borderline = events.filter((e) => e.mergedByTitle);
  console.log(
    `合并：按链接 ${events.length - borderline.length} 组，按标题相似 ${borderline.length} 组（需人工复核）`,
  );

  let total = 0;
  for (const m of allocation.modules) {
    total += m.items.length;
    console.log(`\n${MODULE_NAME[m.key]}（${m.items.length}）`);
    for (const s of m.items) {
      const flag = s.evidence === "verified" ? "验" : s.evidence === "pending" ? "待" : "闻";
      const src = s.ev.items[0].source.padEnd(10);
      const signal = isBusiness(s) ? "商业" : "";
      console.log(
        `  [${flag}] ${String(s.score).padStart(3)} 分 · 热度 ${s.heat} · ${src} ${s.ev.items[0].title.slice(0, 54)} ${signal}`,
      );
    }
  }

  console.log(
    `\n采用 ${total} 条，未采用 ${allocation.dropped} 条（分数不足 / 今日重复 / 非 AI 内容 ${allocation.offTopic} 条）`,
  );
  if (process.argv.includes("--review")) {
    const n = Number(argValue("--review") ?? 20) || 20;
    printDropped(scored, allocation, n);
  }
  if (borderline.length > 0) {
    console.log("\n待人工复核的标题合并：");
    for (const e of borderline) {
      console.log(`  - ${e.items.map((i) => `[${i.source}] ${i.title}`).join("  ≈  ")}`);
    }
  }

  // 正文抓取：只抓入选的 RSS 条目（github 用 description、HN 是讨论页不抓），
  // 抓不到静默降级，成稿退回 feed 摘要；--dry 不联网。
  const targets = allocation.modules.flatMap((m) =>
    m.items
      .filter((s) => s.ev.items[0].source === "rss")
      .map((s) => ({ id: s.ev.id, url: s.ev.items[0].url })),
  );
  const bodies = dry ? undefined : await fetchBodies(targets);
  if (bodies && targets.length > 0) {
    const fetched = [...bodies.values()].filter((b) => b.status === "ok").length;
    console.log(`\n正文抓取：${fetched}/${targets.length} 条成功（失败静默降级）`);
  }

  const digest = composeDigest({ date, raw, totalEvents: events.length, allocation, bodies });

  // 发布前闸门：不通过不拦截，但要打印出来，人工确认后才能上线
  const warnings: string[] = [];
  const ids = new Set<string>();
  for (const m of digest.modules) {
    for (const item of m.items) {
      if (ids.has(item.id)) warnings.push(`重复事件：${item.id} 出现在多个模块`);
      ids.add(item.id);
      if (!item.sources.some((s) => s.url.startsWith("http"))) {
        warnings.push(`缺可访问链接：${item.title.slice(0, 40)}`);
      }
      if (item.evidence === "rumor") {
        warnings.push(`未证实内容被发布：${item.title.slice(0, 40)}`);
      }
    }
  }
  // 席位没凑满只提示，不拦发布：宁可某天少一条，也不放低准入线凑数
  for (const s of allocation.shortfall) {
    warnings.push(`${MODULE_NAME[s.key]}只凑到 ${s.got}/${s.want} 条，当天信号不足`);
  }
  if (total < 10) warnings.push(`本期仅 ${total} 条，低于 10 条下限（不凑数，照实发）`);
  console.log(
    warnings.length === 0
      ? `\n闸门：全部通过（${total} 条，无重复、无未证实内容、链接齐全）`
      : `\n闸门：${warnings.length} 条提示\n  - ${warnings.join("\n  - ")}`,
  );
  if (dry) {
    console.log("\n[dry] 未写文件。");
    return;
  }
  const file = saveDigest(digest);
  console.log(`\n写入：${file}`);

  // 同步 D1（冷备）。失败只告警：文件已经写成功，站点读的是文件
  try {
    execSync(`pnpm tsx scripts/admin/publish-digest.ts --date ${digest.date}`, {
      cwd: resolve(import.meta.dirname, "../../.."),
      stdio: "inherit",
    });
  } catch {
    console.log("\n[警告] D1 同步失败（digest），文件已写入，站点不受影响");
  }
  console.log(
    `统计：候选 ${digest.stats.candidates} · 事件 ${digest.stats.merged} · 已核验 ${digest.stats.verified} · 采用 ${digest.stats.published}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});