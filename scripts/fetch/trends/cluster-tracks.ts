import fs from "node:fs";
import path from "node:path";
import "../config";
import { chatJSON } from "../sources/llm";

const FILE = path.resolve(process.cwd(), "content/trends.json");

interface Item {
  keyword: string;
  slug: string;
  series?: { values?: number[] };
}

const STOP = new Set([
  "ai", "the", "for", "and", "of", "in", "to", "how", "what", "is", "a", "app", "apps",
  "tool", "tools", "best", "free", "online", "with", "your", "my", "on", "vs", "new", "top",
  "2026", "2025", "use", "using", "make", "get", "from",
]);

function buildClusters(items: Item[]): string[][] {
  const toks = items.map((t) => ({
    k: t.keyword,
    set: new Set(
      String(t.keyword)
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  }));
  const inv = new Map<string, number[]>();
  toks.forEach((t, i) =>
    t.set.forEach((w) => {
      if (!inv.has(w)) inv.set(w, []);
      inv.get(w)!.push(i);
    }),
  );
  const par = toks.map((_, i) => i);
  const find = (x: number): number => (par[x] === x ? x : (par[x] = find(par[x])));
  const uni = (a: number, b: number): void => {
    a = find(a);
    b = find(b);
    if (a !== b) par[a] = b;
  };
  for (let i = 0; i < toks.length; i++) {
    const cnt = new Map<number, number>();
    toks[i].set.forEach((w) => {
      const list = inv.get(w) ?? [];
      if (list.length > 25) return;
      list.forEach((j) => {
        if (j > i) cnt.set(j, (cnt.get(j) ?? 0) + 1);
      });
    });
    for (const [j, c] of cnt) if (c >= 2) uni(i, j);
  }
  const groups = new Map<number, string[]>();
  toks.forEach((t, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(t.k);
  });
  return [...groups.values()].filter((g) => g.length >= 2);
}

const SYSTEM = `你是 AI 趋势榜的编辑。下面给出若干关键词分组，每组内的词有共同的实词。

你的任务：判断哪些组里存在「同一个搜索需求的不同说法」。这类词必须合并成一个代表词，否则榜单上会出现同一件事说五遍。

判断标准：
- 合并（同一需求，只是措辞不同）：ai visibility audit / ai visibility tracker / ai search visibility checker —— 都是「查我在 AI 回答里被提没被提」
- 合并（同一需求，加了限定词但答案一样）：brand mentions in chatgpt / track brand in chatgpt / chatgpt brand monitoring
- 不合并（不同问题，答案不同）：ollama docker volume（怎么挂载数据）/ ollama docker gpu（怎么用显卡）
- 不合并（不同产品/不同人群）：ai customer support for shopify / ai customer support small business —— 后者不限平台，做的东西不一样

代表词选择：优先选搜索量最大的（我会给出峰值），其次选措辞最自然、最像真人会搜的那个。
被合并的词不该消失，它们会作为代表词的别名保留，所以选错代表词的代价是主页面 SEO 弱一点。

只输出 JSON，不要解释。格式：
{"groups":[{"keep":"代表词原文","merge":["被并入的词原文"],"reason":"20字内说明为什么是同一件事"}],"distinct":[["保留1","保留2"]]}
没有需要合并的组，groups 给空数组，把组放进 distinct。`;

async function main(): Promise<void> {
  const data = JSON.parse(fs.readFileSync(FILE, "utf8")) as { keywords: Item[] };
  const peakOf = (k: string): number => {
    const t = data.keywords.find((x) => x.keyword === k);
    return t ? Math.max(...(t.series?.values ?? [0]), 0) : 0;
  };

  const clusters = buildClusters(data.keywords);
  console.log(`规则聚出 ${clusters.length} 个簇`);

  // 分批：每批 8 簇，避免输出被截断
  const BATCH = 8;
  const merged: { keep: string; merge: string[]; reason: string }[] = [];

  for (let i = 0; i < clusters.length; i += BATCH) {
    const batch = clusters.slice(i, i + BATCH);
    const payload = batch.map((g, gi) => ({
      group: gi + 1,
      keywords: g.map((k) => ({ k, peak: peakOf(k) })).sort((a, b) => b.peak - a.peak),
    }));
    try {
      const out = await chatJSON<{ groups?: { keep: string; merge: string[]; reason: string }[] }>(
        SYSTEM,
        JSON.stringify(payload),
        3000,
        0.2,
      );
      const gs = out.groups ?? [];
      for (const g of gs) {
        if (g.keep && Array.isArray(g.merge) && g.merge.length > 0) merged.push(g);
      }
      console.log(`批次 ${Math.floor(i / BATCH) + 1}: 簇 ${batch.length} → 合并组 ${gs.length}`);
    } catch (e) {
      console.error(`批次 ${Math.floor(i / BATCH) + 1} 失败:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  fs.writeFileSync("/tmp/clusters.json", JSON.stringify(merged, null, 2));
  console.log(`\n共得到 ${merged.length} 组待合并`);
  for (const g of merged) {
    console.log(`【${g.keep}】峰值 ${peakOf(g.keep)}`);
    console.log(`  合并: ${g.merge.join(" | ")}`);
    console.log(`  理由: ${g.reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});