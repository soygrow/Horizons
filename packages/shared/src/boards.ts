/**
 * 六个榜的稳定标识。
 *
 * 这些字符串直接落进数据库的 board 列，**一旦上线就不能改**（改了等于数据全丢）。
 * 所以放在 shared 里，Worker、脚本、后台三边引用同一个字面量集合。
 */

export type Board = "tools" | "github" | "trends" | "models" | "opps" | "digest";

export const BOARDS: readonly Board[] = [
  "tools",
  "github",
  "trends",
  "models",
  "opps",
  "digest",
];

export const BOARD_LABELS: Record<Board, string> = {
  tools: "AI 工具榜",
  github: "GitHub 榜",
  trends: "趋势榜",
  models: "模型榜",
  opps: "机会榜",
  digest: "日报",
};

export function isBoard(value: string): value is Board {
  return (BOARDS as readonly string[]).includes(value);
}

/**
 * 保留多少个已生效版本（回滚深度）。
 *
 * 放在 shared 而不是各写各的：清理脚本按它删旧版本，后台按它显示「保留 N 期」。
 * 两处各自硬编码 3 的时候，改一处忘一处，后台就会显示一个和实际不符的数字 ——
 * 而那是出事时唯一能参考的信息。
 */
export const KEEP_VERSIONS = 3;