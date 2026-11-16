/**
 * 「更新榜单」发布脚本（由 .github/workflows/publish-tools.yml 调用）。
 *
 * 只发布人工确认过、且已完成富化的候选：
 *   - stage = enriched  → 可发布
 *   - stage = approved  → 仅 --include-approved 时发布（跳过富化）
 *   - stage = candidate / rejected → 一律不发
 *
 * 已拒绝（rejected）域名永久跳过；已存在的域名跳过（不覆盖线上已富化数据）。
 * 发布后只从队列里移除本次发出去的条目，其余候选保留继续审核。
 *
 * --drops：同时执行存量重判给出的下榜清单（content/tools-audit.json）。
 * 只认 24 小时内生成的审计结果，避免拿过期清单误删在榜条目。
 *
 * 用法：
 *   pnpm tsx scripts/admin/publish-tools.ts --dry
 *   pnpm tsx scripts/admin/publish-tools.ts --domains a.com,b.com
 *   pnpm tsx scripts/admin/publish-tools.ts --include-approved
 *   pnpm tsx scripts/admin/publish-tools.ts --drops
 */
import fs from "node:fs";
import path from "node:path";
import { compareByToolScore, computeToolScore, tierOf } from "@horizons/shared";
import type { AITool } from "@horizons/shared";
import { syncBoardToD1 } from "./board-sync";
import {
  clearCandidates,
  markPublished,
  readWorkspace,
  syncCandidates,
  type ItemStatus,
} from "./board-items";
import { d1Configured } from "./d1-client";
import { readListedTools } from "./hydrate-tools";
import type { PublishRow } from "./publish-board";
import { statsLine, writeToolStats } from "./tool-stats";
import type { StagingFile, StagingItem } from "./verdict";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOOLS_PATH = path.join(ROOT, "content/aitools.json");
const AUDIT_PATH = path.join(ROOT, "content/tools-audit.json");
/** 审计结果的保鲜期：超过就不认，防止用几天前的清单误删 */
const AUDIT_TTL_MS = 24 * 3600_000;

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

/** 原子写：写临时文件再 rename，构建/提交中途失败也不会留下半截 JSON */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
}

/** --domains a.com,b.com：不传则发布全部已富化条目 */
function parseDomains(): Set<string> | null {
  const i = process.argv.indexOf("--domains");
  if (i < 0 || !process.argv[i + 1]) return null;
  return new Set(
    process.argv[i + 1]
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * --report <path>：把本次发布结果写成 JSON。
 *
 * 第二期起 `content/aitools.json` 不入库，git diff 不再是「有没有变更」的信号，
 * CI 只能靠这个报告决定要不要触发站点重建 —— 没有变更时白跑 20 分钟构建。
 */
function parseReportPath(): string | null {
  const i = process.argv.indexOf("--report");
  return i >= 0 && process.argv[i + 1] ? path.resolve(ROOT, process.argv[i + 1]) : null;
}

const REPORT_PATH = parseReportPath();

function emitReport(data: Record<string, unknown>): void {
  if (!REPORT_PATH) return;
  const tmp = `${REPORT_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, REPORT_PATH);
}

/**
 * --kind new|refresh：一次只发一个来源。
 *
 * 不分来源的话，在「线上榜单」点发布会把「数据抓取」里还没审核的新条目
 * 一起带到线上（反之亦然）。后台两个 tab 互不交叉，发布口也必须分开。
 */
function parseKind(): "new" | "refresh" | null {
  const i = process.argv.indexOf("--kind");
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v === "new" || v === "refresh" ? v : null;
}

/** 工作区书签字段，只在我们自己的队列里有意义，写进 aitools.json 就是脏数据 */
const BOOKKEEPING = ["stage", "kind", "refreshFrom", "fieldGaps", "enrichedAt"] as const;

function toCleanTool(item: StagingItem): AITool {
  const clean: Record<string, unknown> = { ...(item as unknown as Record<string, unknown>) };
  for (const k of BOOKKEEPING) delete clean[k];
  return clean as AITool;
}

function kindOf(item: StagingItem): "new" | "refresh" {
  return (item as StagingItem & { kind?: string }).kind === "refresh" ? "refresh" : "new";
}

interface AuditFile {
  generatedAt?: string;
  dropped?: Array<{ domain: string; reason?: string }>;
}

/** 读取存量重判的下榜清单；过期的审计结果一律不认 */
function loadDrops(tools: AITool[]): { domains: Set<string>; stale: boolean; pending: number } {
  const audit = readJson<AuditFile | null>(AUDIT_PATH, null);
  const dropped = audit?.dropped ?? [];
  if (dropped.length === 0) return { domains: new Set(), stale: false, pending: 0 };

  const at = audit?.generatedAt ? Date.parse(audit.generatedAt) : NaN;
  const stale = !Number.isFinite(at) || Date.now() - at > AUDIT_TTL_MS;
  if (stale) return { domains: new Set(), stale: true, pending: dropped.length };

  const onList = new Set(tools.map((t) => t.domain));
  const domains = new Set(dropped.map((d) => d.domain).filter((d) => onList.has(d)));
  return { domains, stale: false, pending: domains.size };
}

/* ------------------------------ D1 同步 ------------------------------ */

/**
 * 卡片 = 工具去掉 pageStructure。
 * pageStructure 单条约 11KB（占单条 25KB 的四成多），是付费墙后的深度情报，
 * 不该出现在列表查询里。其余字段合计约 3KB，可以整条带走。
 */
function toCard(tool: AITool): Record<string, unknown> {
  const card: Record<string, unknown> = { ...tool };
  delete card.pageStructure;
  return card;
}

/**
 * 构造名次表。
 *
 * tools 榜是「增量追加 + 存量下榜」，JSON 里的顺序是追加顺序，
 * 真正的名次必须按 compareByToolScore 重排 —— 与站点页面用的是同一个比较器。
 * 只写 tierOf 非 null 的条目，未过收录门槛的不进榜（与页面展示口径一致）。
 */
function toRows(next: readonly AITool[]): PublishRow[] {
  const ordered = [...next].sort(compareByToolScore).filter((t) => tierOf(t) !== null);

  return ordered.map((tool, i) => {
    const rank = i + 1;
    return {
      key: tool.domain,
      rank,
      score: computeToolScore(tool).score,
      tier: tierOf(tool) ?? "core",
      name: tool.name,
      url: tool.url ?? `https://${tool.domain}`,
      cats: tool.categories?.length ? tool.categories : null,
      card: { rank, ...toCard(tool) },
      detail: tool,
    };
  });
}

/**
 * 发布基线：D1 当前版本优先，本地文件只是缓存。
 *
 * 第二期起唯一真源是 D1，`content/aitools.json` 只在构建时由 hydrate 生成。
 * 若这里继续以文件为基线，本地一个过期的文件就会把线上榜单「回退」到旧状态
 * —— 而发布是全量快照，退一步就是整榜倒退。
 *
 * 回退顺序：
 *   1. --from-file 显式指定 → 只读文件（离线验算用）；
 *   2. 有 D1 通道 → 读当前版本（文件内容不作数）；
 *   3. 没有 D1 通道 → 文件兜底，没有文件就报错。
 */
async function loadCurrentTools(): Promise<AITool[]> {
  const fileTools = readJson<AITool[]>(TOOLS_PATH, []);

  if (process.argv.includes("--from-file")) {
    console.log(`[publish] --from-file：基线取本地文件 ${fileTools.length} 条`);
    return fileTools;
  }

  if (!d1Configured()) {
    if (fileTools.length === 0) {
      throw new Error(
        "没有 D1 通道，本地也没有 content/aitools.json。\n" +
          "先配置 CLOUDFLARE_API_TOKEN / 执行 wrangler login，或跑一次 scripts/admin/hydrate-tools.ts。",
      );
    }
    console.warn(
      `[publish] 无 D1 通道，基线取本地文件 ${fileTools.length} 条 —— ` +
        "文件可能已过期，正式发布请走 D1",
    );
    return fileTools;
  }

  const { version, tools } = await readListedTools();
  console.log(`[publish] 基线取 D1 版本 ${version}：${tools.length} 条`);
  return tools;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry");
  const includeApproved = process.argv.includes("--include-approved");
  const applyDrops = process.argv.includes("--drops");
  /** 只重灌 D1，不动 JSON 与队列：换库、修数据、验证链路时用 */
  const resync = process.argv.includes("--resync");
  const only = parseDomains();
  /** 只发某一来源：后台「数据抓取」发新条目、「线上榜单」发更新 */
  const kindFilter = parseKind();

  const tools = await loadCurrentTools();

  /*
   * 候选池只读 D1（没有文件兜底了）。
   *
   * status 列才是真相：后台的「确认收录 / 拒绝」直接写 board_items，
   * 卡片里的 stage 是采集当时的旧值，由 readWorkspace 覆盖。
   */
  const { items: queued, rejected: rejectedKeys } = await readWorkspace<StagingItem>("tools");
  const staging: StagingFile = {
    updatedAt: new Date().toISOString(),
    items: queued,
    rejected: rejectedKeys,
  };

  /*
   * --resync：把现有 JSON 原样重灌进 D1。
   *
   * 平时的发布路径只在有 accepted/drops 时才同步，所以一个已经稳定的榜
   * 永远进不了库（新库、误删、切换数据源时都需要这次「补灌」）。
   * 明确不碰 JSON 与队列，避免为了修库反而改了源数据。
   */
  if (resync) {
    const rows = toRows(tools);
    console.log(`[publish] resync：按现有 ${rows.length} 条重灌 D1（不改 JSON / 队列）`);
    await syncBoardToD1({
      board: "tools",
      rows,
      actor: process.env.GITHUB_ACTOR ?? "manual",
    });
    emitReport({ mode: "resync", added: 0, updated: 0, dropped: 0, changed: false });
    return;
  }

  const drops = applyDrops
    ? loadDrops(tools)
    : { domains: new Set<string>(), stale: false, pending: 0 };
  if (drops.stale) {
    console.warn(
      `[publish] 下榜清单已过期（超过 24 小时），本次不执行下榜。请重新跑「重判存量」。` +
        `待下榜 ${drops.pending} 条仍在文件里。`,
    );
  }

  const rejected = new Set(staging.rejected);
  const existing = new Set(tools.map((t) => t.domain));

  const accepted: StagingItem[] = [];
  const duplicates: string[] = [];
  const rejectedHit: string[] = [];
  const notReady: string[] = [];
  const notSelected: string[] = [];
  /** 标了 refresh 但线上没有同域名条目：数据不一致，不能当更新发 */
  const notListed: string[] = [];

  for (const item of staging.items) {
    if (!item?.domain) continue;
    if (rejected.has(item.domain)) {
      rejectedHit.push(item.domain);
      continue;
    }
    if (only && !only.has(item.domain)) {
      notSelected.push(item.domain);
      continue;
    }
    // 另一个来源 tab 的行：不属于本次发布范围，不能算「未选中」
    if (kindFilter && kindOf(item) !== kindFilter) continue;
    const refresh = kindOf(item) === "refresh";
    // 新条目：已收录就跳过，避免重复收录（原有行为）
    if (existing.has(item.domain) && !refresh) {
      duplicates.push(item.domain);
      continue;
    }
    // 更新条目：必须本来就在线上，否则「更新」无从谈起
    if (!existing.has(item.domain) && refresh) {
      notListed.push(item.domain);
      continue;
    }
    // publishing 是后台派发时写入的占位状态，本质就是「已富化、正在发」，必须照发，
// 否则后台一点发布就把自己的条目挡在门外
    const ready =
      item.stage === "enriched" ||
      item.stage === "publishing" ||
      (includeApproved && item.stage === "approved");
    if (!ready) {
      notReady.push(`${item.domain}(${item.stage ?? "无状态"})`);
      continue;
    }
    existing.add(item.domain);
    accepted.push(item);
  }

  const refreshItems = accepted.filter((i) => kindOf(i) === "refresh");
  const newItems = accepted.filter((i) => kindOf(i) !== "refresh");

  // 热度高的先插入，榜单 diff 更集中，也便于人工核对
  accepted.sort((a, b) => (b.heatScore ?? 0) - (a.heatScore ?? 0));

  /*
   * 队列条数按本次来源统计：工作区里两个 tab 的行混在一起，
   * 直接报 staging.items.length 会让人误以为 refresh 队列里有 13 条
   * （其实是另一个 tab 的）。
   */
  const kindQueue = kindFilter ? staging.items.filter((i) => kindOf(i) === kindFilter) : staging.items;

  console.log(
    `[publish]${kindFilter ? ` 来源 ${kindFilter}` : ""} 队列 ${kindQueue.length}` +
      `｜可发布 ${accepted.length}（新增 ${newItems.length} / 更新 ${refreshItems.length}）` +
      `｜未富化 ${notReady.length}｜重复 ${duplicates.length}｜已拒绝 ${rejectedHit.length}` +
      `｜未选中 ${notSelected.length}${notListed.length ? `｜不在线上 ${notListed.length}` : ""}` +
      `｜下榜 ${drops.domains.size}`,
  );
  if (notReady.length) {
    console.log(`[publish] 跳过（先确认收录并富化）：${notReady.slice(0, 12).join("、")}`);
  }
  if (notListed.length) {
    console.log(`[publish] 跳过（标了更新但线上没有）：${notListed.slice(0, 12).join("、")}`);
  }
  if (drops.domains.size) {
    console.log(`[publish] 本次将下榜 ${drops.domains.size} 条：${[...drops.domains].slice(0, 12).join("、")}`);
  }

  if (accepted.length === 0 && drops.domains.size === 0) {
    console.log("[publish] 没有可发布的条目，源数据未改动");
    console.log(
      JSON.stringify({
        added: 0,
        updated: 0,
        dropped: 0,
        notReady: notReady.length,
        duplicates: duplicates.length,
        notListed: notListed.length,
        rejected: rejectedHit.length,
      }),
    );
    emitReport({ added: 0, updated: 0, dropped: 0, changed: false });
    return;
  }

  if (dryRun) {
    console.log(`[publish] dry-run，将新增 ${newItems.length} 条：`);
    for (const t of newItems) {
      console.log(
        `  + ${t.domain.padEnd(28)} ${t.name}｜${t.verdict?.tier ?? "?"}｜缺失维度 ${t.fieldGaps?.length ?? 0}`,
      );
    }
    console.log(`[publish] dry-run，将更新 ${refreshItems.length} 条：`);
    for (const t of refreshItems) {
      console.log(`  ~ ${t.domain.padEnd(28)} ${t.name}`);
    }
    if (drops.domains.size) {
      console.log("[publish] dry-run，将下榜：");
      for (const d of drops.domains) console.log(`  - ${d}`);
    }
    console.log(
      JSON.stringify({
        added: newItems.length,
        updated: refreshItems.length,
        dropped: drops.domains.size,
        dry: true,
      }),
    );
    emitReport({ added: newItems.length, updated: refreshItems.length, dropped: drops.domains.size, dry: true, changed: false });
    return;
  }

  // 更新条目按域名覆盖线上同一条；新条目追加到末尾（排名由 score 统一重排）
  const refreshMap = new Map(refreshItems.map((i) => [i.domain.toLowerCase(), toCleanTool(i)]));
  const kept = tools
    .filter((t) => !drops.domains.has(t.domain))
    .map((t) => {
      const fresh = refreshMap.get(t.domain.toLowerCase());
      // 旧对象兜底：本次没重采的字段（pageStructure 等）保持线上现值，不会被抹掉
      return fresh ? { ...t, ...fresh, firstSeenAt: fresh.firstSeenAt ?? t.firstSeenAt } : t;
    });
  const nextTools = [...kept, ...newItems.map(toCleanTool)];
  /*
   * 写本地文件只是顺手更新构建缓存（已被 .gitignore 忽略）。
   * 真源是下面 syncBoardToD1 写进去的 D1 新版本 —— 构建时会从那里还原。
   */
  writeJson(TOOLS_PATH, nextTools);

  // 只移除本次发出去的条目；未富化/未确认的继续留在队列里
  const published = new Set(newItems.map((t) => t.domain));
  const handled = new Set(accepted.map((t) => t.domain.toLowerCase()));
  const remaining = staging.items.filter((i) => !handled.has(i.domain.toLowerCase()));

  // 先标「已发榜」再重建队列，顺序不能反：clearCandidates 只删非 published 的行。
  // 这些行留在库里，后台才能显示「发布成功」，等人工点「处理完成」再清掉。
  // 更新条目故意不标 published：它已经在线上，发完就该从队列消失，
  // 否则每轮更新都会在库里堆 200 多行僵尸数据。
  if (published.size) await markPublished("tools", [...published]);

  // 重建 D1 工作区：只剩「没发出去的条目 + 拒绝名单」，后台看到的就是真实剩余量
  if (staging.items.length > 0 || staging.rejected.length > 0) {
    await clearCandidates("tools");
    await syncCandidates("tools", [
      ...remaining.map((i) => ({
        itemKey: i.domain.toLowerCase(),
        name: i.name,
        url: i.url ?? `https://${i.domain}`,
        status: (i.stage ?? "candidate") as ItemStatus,
        // 剩余的更新条目必须保住 refresh，否则重建队列后就被当成新条目
        kind: kindOf(i),
        judge: i.verdict,
        card: i,
      })),
      ...staging.rejected.map((d) => ({
        itemKey: d.toLowerCase(),
        name: d,
        status: "rejected" as const,
      })),
    ]);
  }

  /* 同步 D1：灰度期是冷备，失败不影响 JSON 发布 */
  await syncBoardToD1({
    board: "tools",
    rows: toRows(nextTools),
    actor: process.env.GITHUB_ACTOR ?? "manual",
  });

  const stats = await writeToolStats();
  console.log(
    `[publish] 已写入 D1 与本地缓存（${tools.length} → ${nextTools.length} 条，` +
      `新增 ${newItems.length} / 更新 ${refreshItems.length}` +
      `${drops.domains.size ? ` / 下榜 ${drops.domains.size}` : ""}）`,
  );
  console.log(`[publish] 队列剩余 ${remaining.length} 个待处理`);
  if (newItems.length) {
    console.log(
      `[publish] ${newItems.length} 条新条目已标记「发布成功」，等后台点「处理完成」才真正移出队列`,
    );
  }
  console.log(`[publish] ${statsLine(stats)}`);
  console.log(
    JSON.stringify({
      added: newItems.length,
      updated: refreshItems.length,
      dropped: drops.domains.size,
      remaining: remaining.length,
      notReady: notReady.length,
      duplicates: duplicates.length,
      notListed: notListed.length,
      candidates: stats.candidates,
    }),
  );
  emitReport({
    added: newItems.length,
    updated: refreshItems.length,
    dropped: drops.domains.size,
    remaining: remaining.length,
    notReady: notReady.length,
    duplicates: duplicates.length,
    notListed: notListed.length,
    candidates: stats.candidates,
    // CI 只看这个：本次是否真的改了线上榜单
    changed: newItems.length + refreshItems.length + drops.domains.size > 0,
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});