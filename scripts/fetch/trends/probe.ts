/**
 * 出口自检：pnpm trends:collect --probe（可加 --geo JP）
 *
 * 被限流时日志里只有一句「批量 429」，看不出是「这个 IP 被 Google 挡了」
 * 还是「拿不到 cookie」还是「整条链路不通」。这里按真实采集的顺序
 * （explore 页 → /trends/api/explore → multiline）逐个出口走一遍，
 * 把状态码和耗时摊开，最后给一条能直接抄进 .env.local 的结论。
 */
import "../config";
import { exitCount, useExit } from "../proxy";
import { probeExit, sleep } from "./http";

export async function runProbe(geo = "US"): Promise<void> {
  const total = exitCount();
  console.log(`[probe] 出口 ${total} 个（geo=${geo}）`);
  if (total === 1) {
    console.log("[probe] 只有 1 个出口：被限流时只能原地等解封，配 TRENDS_PROXY 才能换 IP");
  }

  const verdicts: { exit: string; ok: boolean; note: string }[] = [];
  for (let i = 0; i < total; i++) {
    useExit(i);
    const r = await probeExit(geo);
    verdicts.push({ exit: r.exit, ok: r.ok, note: r.note });
    const detail = [
      `html ${r.html || "-"}`,
      `explore ${r.explore || "-"}`,
      `点 ${r.points}`,
      `${r.ms}ms`,
      r.nid ? "有NID" : "无NID",
    ].join(" · ");
    console.log(`[probe] ${r.ok ? "OK " : "BAD"} ${r.exit.padEnd(22)} ${detail} → ${r.note}`);
    if (i < total - 1) await sleep(2000);
  }

  const good = verdicts.filter((v) => v.ok).map((v) => v.exit);
  console.log("");
  if (good.length > 0) {
    console.log(`[probe] 可用出口 ${good.length}/${total}：${good.join("、")}`);
    if (total === 1) {
      console.log('[probe] 想留冗余就在 .env.local 加：TRENDS_PROXY="direct,http://127.0.0.1:7890"');
    }
  } else if (verdicts.every((v) => /fetch failed|timeout|ECONN|ENOTFOUND|socket|TLS/i.test(v.note))) {
    console.log("[probe] 出口根本连不上 Google（网络或代理问题），先修网络再谈限流");
  } else {
    console.log("[probe] 没有可用出口：当前 IP 已被 Google 挡住，等 30–60 分钟或换一个住宅 IP");
  }
  useExit(0);
}