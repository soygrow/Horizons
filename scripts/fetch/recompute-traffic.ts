import "./config";
import fs from "node:fs";

import { applyTraffic } from "./apply-traffic";
import { extractTrafficMetrics, fetchLergassyMulti } from "./sources/apify";

/**
 * 用已缓存的 SimilarWeb 原始结果重算全库渠道指标。
 *
 * 用途：修复 extractTrafficMetrics 的口径 bug 后，让历史数据与新规则一致
 * （此前把「份额缺失」当成 0，导致「自然搜索量 0 / 占比 0%」的假数据）。
 *
 * 用法：pnpm tsx scripts/fetch/recompute-traffic.ts [--dry]
 * 优先命中 30 天缓存；缓存过期才会真实调用（该 Actor 实测 $0）。
 */
const DRY = process.argv.includes("--dry");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const file = "content/aitools.json";
const all = JSON.parse(fs.readFileSync(file, "utf8")) as Array<Record<string, any>>;

/** 直接读取本地 api 缓存里的 SimilarWeb 原始结果，避免为已采集过的站重复请求 */
function loadLocalRaw(): Map<string, any> {
  const dir = "content/cache/api/apify";
  const map = new Map<string, any>();
  if (!fs.existsSync(dir)) return map;
  for (const f of fs.readdirSync(dir)) {
    try {
      const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
      if (!j.endpoint?.includes("lergassy") || !j.ok || !j.data) continue;
      map.set(String(j.key).toLowerCase(), j.data);
    } catch {
      // 单个缓存文件损坏不影响整体
    }
  }
  return map;
}

async function main(): Promise<void> {
  const targets = all.filter(
    (t) =>
      t.trafficMetrics?.monthlyVisits && (only.length === 0 || only.includes(t.domain)),
  );
  console.log(`待重算 ${targets.length} 站`);

  let ok = 0;
  let skip = 0;
  let i = 0;

  // 优先用本地缓存离线重算；缺的再联网，4 站/批（12 站/批实测易超时）
  const rawMap = loadLocalRaw();
  const missing = targets.filter((t) => !rawMap.has(t.domain.toLowerCase()));
  console.log(`本地缓存可复用 ${targets.length - missing.length} 站，需联网 ${missing.length} 站`);
  for (let k = 0; k < missing.length; k += 4) {
    const part = await fetchLergassyMulti(missing.slice(k, k + 4).map((t) => t.domain));
    for (const [d, v] of part) {
      if (v) rawMap.set(d.toLowerCase(), v);
    }
    console.log(`  联网取数 ${Math.min(k + 4, missing.length)}/${missing.length}`);
  }

  for (const tool of targets) {
    i++;
    const raw = rawMap.get(tool.domain.toLowerCase()) ?? null;
    if (!raw) {
      skip++;
      continue;
    }
    const metrics = extractTrafficMetrics(raw);
    if (!metrics.monthlyVisits) {
      skip++;
      continue;
    }
    const before = {
      org: tool.trafficMetrics?.organicSearchVisits,
      dir: tool.trafficMetrics?.directVisits,
    };
    const after = { org: metrics.organicSearchVisits, dir: metrics.directVisits };
    if (!DRY) applyTraffic(tool, raw, metrics);
    ok++;
    if (before.org !== after.org || before.dir !== after.dir) {
      console.log(
        `  ${tool.domain.padEnd(22)} 自然 ${before.org ?? "—"}→${after.org ?? "—"}｜直接 ${
          before.dir ?? "—"
        }→${after.dir ?? "—"}`,
      );
    }
    if (i % 40 === 0) console.log(`  ...进度 ${i}/${targets.length}`);
  }

  if (!DRY) {
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
    console.log(`\n重算完成：成功 ${ok}，跳过 ${skip}（已写回）`);
  } else {
    console.log(`\n干跑完成：成功 ${ok}，跳过 ${skip}（未写回）`);
  }
}

void main();