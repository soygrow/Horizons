/**
 * 采集入口。`scripts/fetch/*` 一律从这里 import，不要直接引 `index.ts`。
 *
 * 实现在 `index.ts` 里（CLI 与库共用同一份代码，避免出现两条采集路径）。
 * 这层存在的意义是：
 *
 *   1. 明确「谁可以用」—— fetch 侧只依赖 collectSite，不依赖 CLI 的 argv 逻辑；
 *   2. 把类型集中导出，调用方不用知道字段定义在哪个文件；
 *   3. 将来如果把实现真正搬出 index.ts，调用方一行都不用改。
 *
 * 注意：`index.ts` 的 CLI 入口有 "是否直接执行" 判断，
 * 所以 import 这个模块不会误触发一轮采集。
 */
export { collectSite } from "./index";
export type { CollectPayload, CollectSiteOptions, CostItem, CostReport, SourceReport } from "./index";

import { collectSite } from "./index";
import { readTrafficMonths } from "../fetch/collect-store";

export interface CollectWithHistoryOptions {
  url: string;
  jobId?: string;
  force?: boolean;
  freeOnly?: boolean;
}

/**
 * 采集 + 读近 6 个月访问量，一次返回。
 *
 * 趋势图固定画 6 格，而 vortex 一次只给 3 个月 —— 缺的月份必须由
 * `traffic_history` 补齐（补 0，并在页面上标出来是空的），
 * 否则每月只有一段 3 个月的曲线，永远看不到「这个站是一路涨上来的」。
 */
export async function collectWithHistory(opts: CollectWithHistoryOptions) {
  const payload = await collectSite({
    url: opts.url,
    jobId: opts.jobId,
    force: opts.force,
    freeOnly: opts.freeOnly,
    persist: false,
  });
  const history = await readTrafficMonths(payload.domain, { months: 6 });
  return { payload, history };
}