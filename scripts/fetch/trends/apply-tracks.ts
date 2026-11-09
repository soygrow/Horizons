import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve(process.cwd(), "content/trends.json");
const GROUPS = "/tmp/clusters.json";

interface Item {
  keyword: string;
  slug: string;
  variantOf?: string;
  series?: { values?: number[] };
}

interface Group {
  keep: string;
  merge: string[];
  reason: string;
}

const peakOf = (items: Item[], k: string): number => {
  const t = items.find((x) => x.keyword === k);
  return t ? Math.max(...(t.series?.values ?? [0]), 0) : 0;
};

function main(): void {
  const dry = process.argv.includes("--dry");
  const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as { keywords: Item[] };
  const groups = JSON.parse(fs.readFileSync(GROUPS, "utf8")) as Group[];

  // 人工修正 1：品牌监测赛道的代表词换成措辞最自然、峰值最高的那个
  const brand = groups.find((g) => g.merge.includes("brand mentions in chatgpt"));
  if (brand && brand.keep !== "track brand mentions chatgpt") {
    brand.merge = [brand.keep, ...brand.merge.filter((k) => k !== "track brand mentions chatgpt")];
    brand.keep = "track brand mentions chatgpt";
    brand.reason = "都是监测品牌在 AI 回答里被提及";
  }

  // 人工修正 2：簇间交叉——AI 可见性审计整组并入品牌监测
  const visibility = groups.find((g) => g.keep === "ai visibility audit");
  if (brand && visibility) {
    brand.merge.push(...[visibility.keep, ...visibility.merge]);
    groups.splice(groups.indexOf(visibility), 1);
  }

  // 人工修正 3：UGC 广告工厂并入 UGC 广告
  const ugcFactory = groups.find((g) => g.keep === "ugc ad factory ai");
  const ugc = groups.find((g) => g.keep === "ai ugc ads");
  if (ugc && ugcFactory) {
    ugc.merge.push(ugcFactory.keep, ...ugcFactory.merge);
    groups.splice(groups.indexOf(ugcFactory), 1);
  }

  // 人工修正 4：本地 LLM 写代码的两个说法合并
  const localLlmVscode = groups.find((g) => g.keep === "local llm vscode");
  const localLlm = groups.find((g) => g.keep === "local llm for coding");
  if (localLlm && localLlmVscode) {
    localLlm.merge.push(localLlmVscode.keep, ...localLlmVscode.merge);
    groups.splice(groups.indexOf(localLlmVscode), 1);
  }

  // 建立 keyword → 代表词
  const byKeyword = new Map(data.keywords.map((t) => [t.keyword, t]));
  const variantOf = new Map<string, string>();
  const problems: string[] = [];

  for (const g of groups) {
    const keepItem = byKeyword.get(g.keep);
    if (!keepItem) {
      problems.push(`代表词不存在: ${g.keep}`);
      continue;
    }
    for (const k of g.merge) {
      if (k === g.keep) continue;
      const item = byKeyword.get(k);
      if (!item) {
        problems.push(`别名不存在: ${k}`);
        continue;
      }
      if (variantOf.has(keepItem.slug)) {
        problems.push(`代表词自己又是别人的别名: ${g.keep}`);
      }
      variantOf.set(k, keepItem.slug);
    }
  }

  // 校验：不能被合并两次（A→B，B→C 这种链）
  const repSlugs = new Set(groups.map((g) => byKeyword.get(g.keep)?.slug).filter(Boolean) as string[]);
  for (const [k] of variantOf) {
    const item = byKeyword.get(k);
    if (item && repSlugs.has(item.slug)) problems.push(`既是代表词又是别名: ${k}`);
  }

  console.log(`合并组 ${groups.length} 个，变体 ${variantOf.size} 个，上榜 ${data.keywords.length - variantOf.size} 个`);
  if (problems.length) {
    console.log(`问题 ${problems.length} 处：`);
    problems.slice(0, 10).forEach((p) => console.log("  -", p));
  }

  console.log("\n=== 每个代表词吸收了多少别名 ===");
  const count = new Map<string, number>();
  for (const [, rep] of variantOf) count.set(rep, (count.get(rep) ?? 0) + 1);
  [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([rep, n]) => {
      const item = [...byKeyword.values()].find((t) => t.slug === rep);
      console.log(` ${String(n).padStart(2)} 个 ← ${item?.keyword ?? rep} (峰值 ${item ? peakOf(data.keywords, item.keyword) : 0})`);
    });

  if (dry) {
    console.log("\n--dry，未写盘");
    return;
  }

  let n = 0;
  for (const t of data.keywords) {
    const rep = variantOf.get(t.keyword);
    if (rep && rep !== t.slug) {
      t.variantOf = rep;
      n++;
    }
  }
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log(`\n已写入 ${n} 条 variantOf`);
}

main();