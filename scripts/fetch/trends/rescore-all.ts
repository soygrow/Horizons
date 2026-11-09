import fs from "node:fs";
import path from "node:path";
import { rescore } from "./score";
import type { AITrend } from "@horizons/shared";

const FILE = path.resolve(process.cwd(), "content/trends.json");

function main(): void {
  const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as { keywords: AITrend[]; [k: string]: unknown };
  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;
  const diffs: { keyword: string; before: number; after: number }[] = [];

  data.keywords = data.keywords.map((t) => {
    const next = rescore(t, today);
    if (next.trendParts.growth !== t.trendParts.growth) {
      changed++;
      diffs.push({ keyword: t.keyword, before: t.trendParts.growth, after: next.trendParts.growth });
    }
    return next;
  });

  diffs.sort((a, b) => a.before - a.after - (b.before - b.after));
  console.log(`重算 ${data.keywords.length} 个词，growth 变化 ${changed} 个`);
  console.log("下调最多的 8 个：");
  diffs.slice(0, 8).forEach((d) => console.log(`  ${d.before} → ${d.after}  ${d.keyword}`));
  console.log("上调最多的 5 个：");
  diffs.slice(-5).forEach((d) => console.log(`  ${d.before} → ${d.after}  ${d.keyword}`));

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log("已写盘");
}

main();