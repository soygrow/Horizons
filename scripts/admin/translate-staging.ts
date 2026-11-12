/**
 * 把候选池里仍是英文的描述翻成中文（存量兜底）。
 *
 * 正常情况下采集脚本入库前已经翻好（fetch-staging.ts 调 translateInPlace），
 * 这个脚本处理两类漏网：
 *   1. 历史上没经过翻译入库的老条目；
 *   2. 采集当时 LLM 抖动、那一批翻译失败留下的英文。
 *
 * 只改 card 里的 description，不动 status —— 后台已确认收录的条目不会被降级。
 *
 * 用法：
 *   pnpm tsx scripts/admin/translate-staging.ts            # 修全部
 *   pnpm tsx scripts/admin/translate-staging.ts --dry       # 只看有多少条要修
 *   pnpm tsx scripts/admin/translate-staging.ts --limit 20  # 限量
 */
import "../fetch/config"; // 副作用导入：触发 .env.local 加载
import { hasLLM } from "../fetch/sources/llm";
import { needsZh, translateInPlace, ZH_RE } from "../fetch/translate";
import { listCandidates, updateCards } from "./board-items";
import { d1Configured } from "./d1-client";

interface Card {
  domain?: string;
  name?: string;
  description?: string;
  descriptionSource?: string;
  [key: string]: unknown;
}

function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

function intArg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  if (!d1Configured()) {
    console.error("[zh] 未配置 D1 通道，读不到候选池");
    process.exit(1);
  }

  const dry = has("dry");
  const limit = intArg("limit", 0);

  const rows = await listCandidates<Card>("tools");
  const items = rows.filter((r) => r.card && r.status !== "rejected");
  const targets = items.filter((r) => needsZh(r.card as Card));

  console.log(
    `[zh] 候选池 ${rows.length} 条｜非拒绝 ${items.length} 条｜待翻译 ${targets.length} 条` +
      `${dry ? "（dry-run）" : ""}`,
  );
  if (targets.length === 0) return;

  if (dry) {
    for (const t of targets.slice(0, 20)) {
      console.log(`  - ${t.itemKey}｜${(t.card as Card).description?.slice(0, 70) ?? ""}`);
    }
    if (targets.length > 20) console.log(`  … 另有 ${targets.length - 20} 条`);
    return;
  }

  if (!hasLLM()) {
    console.error("[zh] 未配置 DEEPSEEK_API_KEY，无法翻译");
    process.exit(1);
  }

  const picked = limit > 0 ? targets.slice(0, limit) : targets;
  const stats = await translateInPlace(
    picked.map((r) => r.card as Card),
    (m) => console.log(m),
  );

  // translateInPlace 是原地改 card，这里把改过的写回去。
  // 判定标准用「现在含中文了」而不是统计值：失败批次里的条目不该被写回。
  const changed = picked.filter((r) => ZH_RE.test((r.card as Card).description ?? ""));
  const saved = await updateCards(
    "tools",
    changed.map((r) => ({ itemKey: r.itemKey, card: r.card })),
  );

  console.log(
    `[zh] 翻译 ${stats.translated} 条｜失败 ${stats.failed} 条｜已是中文 ${stats.skipped} 条｜写回 D1 ${saved} 条`,
  );
  if (stats.failed > 0) {
    console.log("::warning::[zh] 有批次翻译失败，重跑本脚本即可增量补齐");
  }
}

main().catch((e) => {
  console.error("[zh] 失败：", e);
  process.exit(1);
});