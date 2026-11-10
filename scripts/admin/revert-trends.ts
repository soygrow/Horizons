import "../fetch/config"; // 副作用导入：加载 .env.local
import type { AITrend } from "@horizons/shared";
import { loadStaging, saveStaging } from "../fetch/trends/store";
import { arg, hasFlag, msgOf, parseSlugs } from "./cli";

/**
 * 把候选池里的词回滚到刷新前的上一版内容。
 *
 * 用法：
 *   pnpm trends:revert --slugs=a,b       # 必须显式指定，避免误把整池刷回旧版
 *   pnpm trends:revert --slugs=a --dry
 *
 * 只在「重刷后内容更差」时使用：刷新时 buildEnrichedTrend 会把旧内容留成
 * previousSnapshot，回滚只覆盖内容字段，曲线 / 趋势分 / 来源仍用这一轮的新数据。
 * 回滚后旧快照即失效（上一版已经回到正文），避免反复回滚产生歧义。
 */

function revertOne(item: AITrend): AITrend {
  const snap = item.previousSnapshot;
  if (!snap) return item;

  const next: AITrend = {
    ...item,
    normalizedName: snap.normalizedName,
    category: snap.category,
    why: snap.why,
    oppParts: snap.oppParts,
    evidence: snap.evidence,
    intents: snap.intents,
    opportunities: snap.opportunities,
    actions: snap.actions,
  };
  // 旧版没有的可选项要显式清掉，否则会残留新版内容
  if (snap.intentSummary) next.intentSummary = snap.intentSummary;
  else delete next.intentSummary;
  if (snap.editorNote) next.editorNote = snap.editorNote;
  else delete next.editorNote;
  if (snap.relatedQueries) next.relatedQueries = snap.relatedQueries;
  else delete next.relatedQueries;
  if (snap.competitors) next.competitors = snap.competitors;
  else delete next.competitors;

  delete next.previousSnapshot;
  // 内容已回到旧版，就是可发布状态
  delete next.enrichStatus;
  return next;
}

async function main(): Promise<void> {
  const dry = hasFlag("--dry");
  const jobId = arg("--job-id") ?? "-";
  const wanted = parseSlugs();

  if (wanted.size === 0) {
    console.error("[revert] 必须用 --slugs 指定要回滚的词，避免把整个候选池刷回旧版");
    process.exit(1);
  }
  if (wanted.size > 60) {
    console.error("[revert] 单次最多 60 个");
    process.exit(1);
  }

  const staging = loadStaging();
  if (staging.items.length === 0) {
    console.log("[revert] 候选池为空，无需回滚");
    return;
  }

  const next = [...staging.items];
  const done: string[] = [];
  const missing: string[] = [];

  for (const item of staging.items) {
    if (!wanted.has(item.slug)) continue;
    if (!item.previousSnapshot) {
      missing.push(item.keyword);
      continue;
    }
    const idx = next.findIndex((t) => t.slug === item.slug);
    if (idx >= 0) {
      next[idx] = revertOne(item);
      done.push(item.keyword);
    }
  }

  console.log(
    `[revert] job=${jobId} 请求 ${wanted.size} 个，回滚 ${done.length} 个，无快照跳过 ${missing.length} 个${dry ? "（dry-run）" : ""}`,
  );
  for (const k of done) console.log(`  ← ${k}`);
  for (const k of missing) console.warn(`  · 跳过 ${k}：没有上一版快照`);

  if (dry) {
    console.log("[revert] dry-run，未写入");
    return;
  }
  if (done.length > 0) {
    saveStaging({ ...staging, updatedAt: new Date().toISOString(), items: next });
    console.log("[revert] 已写入 content/trends-staging.json");
  }

  // 最后一行给 workflow / 后台读取
  console.log(JSON.stringify({ reverted: done.length, missing: missing.length, dry }));
}

main().catch((e) => {
  console.error("[revert] 运行失败：", msgOf(e));
  process.exit(1);
});