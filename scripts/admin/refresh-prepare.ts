/**
 * 把线上榜单条目回填进工作区，交给 enrich-staging 用**同一套采集**重跑。
 *
 * 为什么需要这一步：
 *   线上 210 条只在 board_listed / board_listed_details 快照里，
 *   工作区 board_items 里一条都没有（发布后都被「处理完成」清掉了）。
 *   要复用 enrich-staging → enrich-site → collectSite()，就得先把它们
 *   变成工作区里的 approved 条目，并打上 kind=refresh。
 *
 * 为什么基线取 board_listed_details：detail 是发布时写入的完整 tool 对象，
 * 从它出发做增量富化，与「新条目采集」走的是同一条路径 —— 口径不会分叉。
 * card 里刻意去掉 pageStructure（单条 11KB，列表查询用不上），
 * 发布覆盖时由 publish-tools 保留线上旧值，不会丢。
 *
 * 用法：
 *   pnpm tsx scripts/admin/refresh-prepare.ts --domains a.com,b.com
 *   pnpm tsx scripts/admin/refresh-prepare.ts --domains a.com,b.com --dry
 */
import { syncCandidates } from "./board-items";
import { createD1Client, d1Configured } from "./d1-client";

const BOARD = "tools";
/** 一次最多回填多少条：与 workflow 的单批上限一致，防止误传全量 */
const MAX_DOMAINS = 100;

/** 发布后不该出现在条目里的书签字段（工作区内部用，不是数据） */
const BOOKKEEPING = ["stage", "kind", "refreshFrom", "fieldGaps", "enrichedAt", "verdict"] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDomains(): string[] {
  const raw = arg("domains") ?? "";
  return [
    ...new Set(
      raw
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, MAX_DOMAINS);
}

interface ListedRow {
  item_key: string;
  rank: number;
  tier: string | null;
  name: string;
  url: string | null;
  card: string | null;
  detail: string | null;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const domains = parseDomains();

  if (domains.length === 0) {
    console.error("[refresh-prepare] 必须用 --domains 指定要更新的域名");
    process.exitCode = 1;
    return;
  }
  if (!d1Configured()) {
    console.error("[refresh-prepare] 没有 D1 通道（CLOUDFLARE_API_TOKEN 或 wrangler 登录态）");
    process.exitCode = 1;
    return;
  }

  const client = createD1Client();

  // 线上口径以当前版本指针为准，不允许不带 version 查 board_listed
  const verRow = await client.query<{ val: string }>(
    "SELECT val FROM app_config WHERE key='config.current_version'",
  );
  const version = verRow.results?.[0]?.val;
  if (!version) {
    console.error("[refresh-prepare] 库里没有 config.current_version，说明还没发布过榜单");
    process.exitCode = 1;
    return;
  }

  const placeholders = domains.map(() => "?").join(",");
  const res = await client.query<ListedRow>(
    `SELECT l.item_key, l.rank, l.tier, l.name, l.url, l.card, d.detail
       FROM board_listed l
       LEFT JOIN board_listed_details d
         ON d.version = l.version AND d.board = l.board AND d.item_key = l.item_key
      WHERE l.version = ? AND l.board = ? AND l.item_key IN (${placeholders})`,
    [version, BOARD, ...domains],
  );

  const rows = res.results ?? [];
  const found = new Set(rows.map((r) => r.item_key));
  const missing = domains.filter((d) => !found.has(d));

  console.log(
    `[refresh-prepare] 版本 ${version}｜请求 ${domains.length} 条｜命中 ${rows.length} 条` +
      `｜不在线上 ${missing.length} 条${dry ? "｜dry-run" : ""}`,
  );
  if (missing.length) {
    console.warn(
      `::warning::[refresh-prepare] 这些域名不在当前线上榜单，已跳过：${missing.slice(0, 12).join("、")}`,
    );
  }

  const inputs = rows.map((r) => {
    const raw = r.detail ?? r.card;
    if (!raw) {
      console.warn(`::warning::[refresh-prepare] ${r.item_key} 快照里没有 detail，跳过`);
      return null;
    }
    const tool = JSON.parse(raw) as Record<string, unknown>;
    const card: Record<string, unknown> = { ...tool };
    for (const k of BOOKKEEPING) delete card[k];
    // pageStructure 单条 11KB：列表查询不用，发布时由旧对象补齐
    delete card.pageStructure;

    return {
      itemKey: r.item_key,
      name: typeof card.name === "string" && card.name ? card.name : r.name,
      url: typeof card.url === "string" && card.url ? card.url : r.url ?? `https://${r.item_key}`,
      status: "approved" as const,
      kind: "refresh" as const,
      // stage 同时写进 card：enrich-site --staging 从 card 读基线，缺了会当成新条目
      card: { ...card, stage: "approved", kind: "refresh", refreshFrom: version },
    };
  });

  const prepared = inputs.filter((x): x is NonNullable<typeof x> => x !== null);

  if (dry) {
    for (const p of prepared) {
      console.log(`  · ${p.itemKey.padEnd(30)} ${p.name}`);
    }
    console.log(JSON.stringify({ version, requested: domains.length, prepared: prepared.length, dry: true }));
    return;
  }

  if (prepared.length === 0) {
    console.log("[refresh-prepare] 没有可回填的条目，工作区未改动");
    console.log(JSON.stringify({ version, requested: domains.length, prepared: 0 }));
    return;
  }

  const written = await syncCandidates(BOARD, prepared);
  console.log(
    `[refresh-prepare] 已回填 ${written} 条为 kind=refresh / status=approved，` +
      `下一步 enrich-staging --kind refresh 会用同一套采集重跑`,
  );
  console.log(
    JSON.stringify({
      version,
      requested: domains.length,
      prepared: prepared.length,
      written,
      missing,
    }),
  );
}

main().catch((e: unknown) => {
  console.error("[refresh-prepare] 失败：", e);
  process.exitCode = 1;
});