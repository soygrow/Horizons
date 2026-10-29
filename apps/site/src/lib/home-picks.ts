/**
 * 首页抽样（构建期计算，零客户端 JS）
 *
 * 规则（与榜单名次绑定，数据一变抽样结果自动跟着变）：
 *   名次 10–19  随机取 1 个
 *   名次 20–29  随机取 1 个
 *   名次 30+    随机取 8 个
 *   → 每个榜单 10 条；候选不足时用剩余名次补足，避免出现半空板块。
 *
 * 随机种子 = 「10 天窗口」序号：同一个 10 天窗口内多次构建结果完全一致，
 * 进入下一个窗口后自动换一批。种子只依赖时间，因此不写入数据文件。
 */
import type { RepoRow, ToolRow, TrendRow } from "./types";

/** 抽样轮换周期（天）：同一个窗口内首页样本保持不变 */
export const ROTATION_DAYS = 10;
const WINDOW_MS = ROTATION_DAYS * 24 * 60 * 60 * 1000;
/** 每个板块展示条数 */
export const PICKS_PER_BOARD = 10;

export interface RotationWindow {
  /** 窗口序号：每 10 天 +1，参与随机种子 */
  index: number;
  /** 本期窗口起止（UTC，仅用于展示） */
  start: Date;
  end: Date;
}

export function rotationWindow(now: Date = new Date()): RotationWindow {
  const index = Math.floor(now.getTime() / WINDOW_MS);
  return { index, start: new Date(index * WINDOW_MS), end: new Date((index + 1) * WINDOW_MS) };
}

/** 确定性 PRNG（mulberry32）：同一 seed 永远给出同一批样本 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌后取前 n 个下标 */
function sampleIndices(pool: number[], n: number, rnd: () => number): number[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, Math.min(n, copy.length)));
}

/**
 * 按名次区间抽样；rows 需按名次升序（名次 = 下标 + 1）。
 * 返回结果按名次升序，便于直接渲染。
 */
export function pickRotating<T>(rows: T[], seed: number, want = PICKS_PER_BOARD): T[] {
  const rnd = mulberry32(seed);
  const used = new Set<number>();

  const take = (from: number, to: number, n: number) => {
    const pool: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rank = i + 1;
      if (rank >= from && rank <= to && !used.has(i)) pool.push(i);
    }
    const picked = sampleIndices(pool, n, rnd);
    for (const i of picked) used.add(i);
    return picked;
  };

  const picked = [
    ...take(10, 19, 1),
    ...take(20, 29, 1),
    ...take(30, Number.MAX_SAFE_INTEGER, 8),
  ];

  // 候选不足（例如趋势词只有十几条）：先用名次 10 以后的剩余行补足，再从更靠前的名次补
  if (picked.length < want) {
    for (const from of [9, 0]) {
      if (picked.length >= want) break;
      const rest: number[] = [];
      for (let i = from; i < rows.length; i++) if (!used.has(i)) rest.push(i);
      for (const i of sampleIndices(rest, want - picked.length, rnd)) {
        used.add(i);
        picked.push(i);
      }
    }
  }

  return picked.sort((a, b) => a - b).map((i) => rows[i]);
}

/** 三个榜单统一按名次排好序（TrendRow 无 rank 字段，数组顺序即名次） */
function byRank<T extends { rank?: number }>(rows: T[]): T[] {
  return typeof rows[0]?.rank === "number"
    ? [...rows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    : rows;
}

export interface HomePicks {
  window: RotationWindow;
  tools: ToolRow[];
  repos: RepoRow[];
  trends: TrendRow[];
}

/** 首页三个榜单的本期抽样结果 */
export function homePicks(
  input: { tools: ToolRow[]; repos: RepoRow[]; trends: TrendRow[] },
  now: Date = new Date(),
): HomePicks {
  const win = rotationWindow(now);
  // 每个板块用不同 seed，避免三个榜单抽出同构的位置
  const seed = (k: number) => (Math.imul(win.index, 1013904223) + Math.imul(k, 2654435761)) >>> 0;

  return {
    window: win,
    tools: pickRotating(byRank(input.tools), seed(1)),
    repos: pickRotating(byRank(input.repos), seed(2)),
    trends: pickRotating(byRank(input.trends), seed(3)),
  };
}