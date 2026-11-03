import fs from "node:fs";
import path from "node:path";
import { compareByScore, computeProductScore } from "@horizons/shared";
import type { GitHubDerivative, GitHubRepo } from "@horizons/shared";
import "./config"; // 副作用导入：加载 .env.local
import { chatJSON, hasLLM } from "./sources/llm";

/**
 * GitHub 榜单「加工空间」评估。
 *
 * 榜单读者不是来找「好项目」的，是来找「能加工出不一样产品」的原材料。
 * 一个项目越完善、越像成品，照抄的价值越低——这件事没法用正则判断
 * （用 api/cli/sdk 这类词过滤，1500 条里 92% 命中，等于白送分），
 * 所以单独让模型读一遍 README 与已有情报，给出 base / occupancy / space / untapped / hook。
 *
 * 用法：
 *  pnpm tsx scripts/fetch/enrich-github-derivative.ts            # 只补缺失的
 *  pnpm tsx scripts/fetch/enrich-github-derivative.ts --force    # 全量重算
 *  pnpm tsx scripts/fetch/enrich-github-derivative.ts --only owner/repo
 */

const JSON_PATH = path.resolve(process.cwd(), "content/github.json");
const CONCURRENCY = 4;

const SYSTEM = `你是「独立开发者 / 小团队创业」的产品顾问。读者想找一个开源项目，**加工或附加处理**之后，做出一个跟这个项目本身**不一样**的产品去赚钱。
如果只能照抄原项目，别人也能马上复制，这件事就没有意义。你要判断的正是「加工空间有多大」。

判断四件事：
1) base：它现在是什么形态（库 / 引擎 / CLI 工具 / 服务端 / 桌面应用 / 网页应用 / 浏览器插件 / 协议标准），一句话。
2) occupancy：它自己已经占住的产品场景。它本身就是一个给最终用户用的成品时，必须写明它占住了什么（例如「在浏览器里审查 AI 编码代理产出的计划」）；它只是原材料时留空字符串。
3) space：加工空间 0-10，按下面锚点给分，不要因为项目热门就给高分：
   - 0-2：它本身就是完成度很高的成品（有完整界面、开箱即用、目标用户就是最终用户）。你加工后做出来的东西跟它高度重合，只能照抄或做它的插件/周边。
   - 3-5：产品形态已比较固定，能做的是换人群、换场景、做垂直版或做服务，替代空间有限。
   - 6-8：通用能力（库/引擎/工具），可以被嵌进明显不同的产品里，原项目不直接构成竞争。
   - 9-10：底层原材料（库/协议/引擎/模型），任何人都能拿去做完全不同的东西，且与原作者的业务不冲突。
4) untapped：它自己没做、但基于它能做的 2 个具体方向（要具体到人群和产品形态，禁止写「做成 SaaS」「加个界面」这类空话）。
5) hook：开发者能接入 / 扩展 / 定制的技术入口（CLI 能输出 JSON、HTTP 接口、插件目录、可替换模型、可读写的本地文件格式等）。没有就留空字符串。

额外要求：
- 判断依据是「它现在已经做完了什么」，不是「它还能做什么」。README 里写着 roadmap 要做、但还没做的，不算它占住了。
- 星标高不等于成品，星标低不等于原材料，只看产品形态。

严格输出 JSON（不要多余文字）：
{ "base": "", "occupancy": "", "space": 0, "untapped": ["", ""], "hook": "" }`;

function cleanReadme(readme: string): string {
  return readme
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#>*`_|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
}

function buildPayload(r: GitHubRepo): string {
  const ideas = (r.insight?.buildIdeas ?? []).map((b) => `${b.title}：${b.product}`);
  return JSON.stringify({
    fullName: r.fullName,
    description: r.description ?? "",
    topics: r.topics ?? [],
    language: r.language ?? "",
    stars: r.stars,
    homepage: r.homepage ?? "",
    whatZh: r.insight?.whatZh ?? "",
    capabilities: r.insight?.capabilities ?? [],
    alreadySuggestedIdeas: ideas,
    readmeExcerpt: cleanReadme(r.readme ?? ""),
  });
}

function normalizeDerivative(raw: Partial<GitHubDerivative>): GitHubDerivative | null {
  const space = Number(raw.space);
  if (!Number.isFinite(space) || space < 0 || space > 10) return null;
  const untapped = Array.isArray(raw.untapped)
    ? raw.untapped.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 3)
    : [];
  if (untapped.length < 2) return null;
  return {
    base: String(raw.base ?? "").trim() || "未判定",
    occupancy: String(raw.occupancy ?? "").trim() || undefined,
    space: Math.round(space * 10) / 10,
    untapped,
    hook: String(raw.hook ?? "").trim() || undefined,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyArg = args.find((a) => a.startsWith("--only"));
  const only = onlyArg
    ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : args[args.indexOf(onlyArg) + 1] ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : [];

  if (!hasLLM()) {
    console.error("未配置 DEEPSEEK_API_KEY，无法生成加工空间评估");
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(JSON_PATH, "utf-8"));
  const repos: GitHubRepo[] = data.repos;

  const todo = repos.filter((r) => {
    if (only.length && !only.includes(r.fullName.toLowerCase())) return false;
    if (force) return true;
    return !r.derivative || r.derivativeSource === "fallback";
  });

  console.log(`共 ${repos.length} 条，待评估 ${todo.length} 条（并发 ${CONCURRENCY}）`);
  if (!todo.length) return;

  let done = 0;
  let failed = 0;
  let dirty = 0;

  const flush = () => {
    const scored = repos.map((r) => ({ ...r, productScore: computeProductScore(r) })).sort(compareByScore);
    fs.writeFileSync(JSON_PATH, JSON.stringify({ ...data, repos: scored }, null, 2) + "\n", "utf-8");
    dirty = 0;
  };

  let cursor = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const r = todo[cursor++];
      try {
        const raw = await chatJSON<Partial<GitHubDerivative>>(SYSTEM, buildPayload(r), 900, 0.3);
        const d = normalizeDerivative(raw);
        if (!d) throw new Error("输出不合格");
        r.derivative = d;
        r.derivativeSource = "llm";
        done++;
        if (++dirty >= 30) flush();
        console.log(
          `[deriv] ✓ ${r.fullName}｜${d.space}/10｜${d.base}${d.occupancy ? `｜已占住：${d.occupancy.slice(0, 24)}` : ""}`,
        );
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        r.derivative = { base: "未判定", space: 5, untapped: [] };
        r.derivativeSource = "fallback";
        if (++dirty >= 30) flush();
        console.warn(`[deriv] ! ${r.fullName}：${msg.slice(0, 80)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flush();

  const ok = repos.filter((r) => r.derivativeSource === "llm").length;
  const fallback = repos.filter((r) => r.derivativeSource === "fallback").length;
  console.log(`\n完成：本轮成功 ${done}，失败 ${failed}｜全量 llm ${ok}，fallback ${fallback}`);
}

main();